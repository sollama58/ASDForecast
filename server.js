const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');
const rateLimit = require('express-rate-limit'); 

const app = express();
const stateMutex = new Mutex();
const payoutMutex = new Mutex();
const lotteryMutex = new Mutex();

app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const SOLANA_NETWORK = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const FEE_WALLET = new PublicKey("5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan");
const UPKEEP_WALLET = new PublicKey("BH8aAiEDgZGJo6pjh32d5b6KyrNt6zA9U8WTLZShmVXq");
const PYTH_HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";
const SOL_FEED_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || ""; 

const ASDF_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";
const PRICE_SCALE = 0.1;
const PAYOUT_MULTIPLIER = 0.94;
const FEE_PERCENT = 0.0552;
const UPKEEP_PERCENT = 0.0048; // 0.48%
const FRAME_DURATION = 15 * 60 * 1000;
const BACKEND_VERSION = "143.0"; // UPDATE: Lottery System + Sentiment Persistence Merge

// --- LOTTERY CONFIG ---
const LOTTERY_CONFIG = {
    ELIGIBILITY_PERCENT: 0.0000552,      // 0.00552% of circulating supply
    MAX_TICKETS: 52,                      // Max tickets per holder
    DRAW_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
    ACTIVITY_WINDOW_DAYS: 7,              // Days of activity required for full eligibility
    BASE_PRIZE: 100000,                   // Base ASDF prize amount
    PRIZE_PER_TICKET: 10000,              // Additional ASDF per ticket in pool
    SUPPLY_CACHE_MS: 5 * 60 * 1000        // Cache supply for 5 minutes
};

const PRIORITY_FEE_UNITS = 50000; 

// --- LOGGING ---
const serverLogs = [];
const MAX_LOGS = 100;
function log(message, type = "INFO") {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${message}`;
    console.log(logEntry);
    serverLogs.push(logEntry);
    if (serverLogs.length > MAX_LOGS) serverLogs.shift();
}

// --- VALIDATION ---
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{80,100}$/;
function isValidSolanaAddress(address) { return typeof address === 'string' && SOLANA_ADDRESS_REGEX.test(address); }
function isValidSignature(signature) { return typeof signature === 'string' && SIGNATURE_REGEX.test(signature); }

// --- RATE LIMIT ---
const betLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: { error: "RATE_LIMIT_EXCEEDED" }, standardHeaders: true, legacyHeaders: false });
const stateLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 120, message: { error: "POLLING_LIMIT_EXCEEDED" }, standardHeaders: true, legacyHeaders: false });
const voteLimiter = rateLimit({ 
    windowMs: 3600 * 1000, // 1 hour per IP limit (Backup/Safety)
    max: 1, 
    message: { error: "IP_COOLDOWN_ACTIVE" }, 
    standardHeaders: true, 
    legacyHeaders: false 
});

// --- PERSISTENCE ---
const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fsSync.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const USERS_DIR = path.join(DATA_DIR, 'users');

if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR);
if (!fsSync.existsSync(FRAMES_DIR)) fsSync.mkdirSync(FRAMES_DIR);
if (!fsSync.existsSync(USERS_DIR)) fsSync.mkdirSync(USERS_DIR);

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const STATS_FILE = path.join(DATA_DIR, 'global_stats.json');
const SIGS_FILE = path.join(DATA_DIR, 'signatures.log');
const QUEUE_FILE = path.join(DATA_DIR, 'payout_queue.json');
const LOTTERY_STATE_FILE = path.join(DATA_DIR, 'lottery_state.json');
const LOTTERY_HISTORY_FILE = path.join(DATA_DIR, 'lottery_history.json');
const PAYOUT_HISTORY_FILE = path.join(DATA_DIR, 'payout_history.json');
const PAYOUT_MASTER_LOG = path.join(DATA_DIR, 'payout_master.log');
const FAILED_REFUNDS_FILE = path.join(DATA_DIR, 'failed_refunds.json');
const SENTIMENT_VOTES_FILE = path.join(DATA_DIR, 'sentiment_votes.json');

log(`> [SYS] Persistence Root: ${DATA_DIR}`);

async function atomicWrite(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try { await fs.writeFile(tempPath, JSON.stringify(data)); await fs.rename(tempPath, filePath); } 
    catch (e) { log(`> [IO] Write Error on ${filePath}: ${e.message}`, "ERR"); }
}

// --- IMAGES ---
let cachedShareImage = null, cachedItsFineImage = null, cachedItsOverImage = null;
let cachedSentUpImage = null, cachedSentDownImage = null;
let isInitialized = false; 

async function cacheImage(url) {
    if (!url) return null;
    if (url.startsWith('http')) {
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data, 'binary');
            const type = response.headers['content-type'];
            return `data:${type};base64,${buffer.toString('base64')}`;
        } catch (e) { 
            log(`> [ERR] Failed to cache image: ${url} - ${e.message}`, "ERR");
            return null;
        }
    }
    return url;
}

async function initImages() {
    log("> [SYS] Caching Images...");
    cachedShareImage = await cacheImage(process.env.BASE_IMAGE_SRC);
    cachedItsFineImage = await cacheImage(process.env.ITSFINE_IMG_SRC);
    cachedItsOverImage = await cacheImage(process.env.ITSOVER_IMG_SRC);
    cachedSentUpImage = await cacheImage(process.env.SENTIMENT_UP_IMG_SRC); 
    cachedSentDownImage = await cacheImage(process.env.SENTIMENT_DOWN_IMG_SRC); 
    log("> [SYS] Images Cached.");
}

let houseKeypair;
try {
    if (process.env.SOLANA_WALLET_JSON) { houseKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_WALLET_JSON))); } 
    else if (fsSync.existsSync('house-wallet.json')) { houseKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fsSync.readFileSync('house-wallet.json')))); }
} catch (e) { log(`> [ERR] Wallet Load Failed: ${e.message}`, "ERR"); }

// --- STATE ---
let gameState = {
    price: 0, lastPriceTimestamp: 0, candleOpen: 0, candleStartTime: 0, poolShares: { up: 50, down: 50 }, bets: [],
    recentTrades: [], sharePriceHistory: [], isPaused: false, isResetting: false, isCancelled: false,
    broadcast: { message: "", isActive: false }, vaultStartBalance: 0, hourlySentiment: { up: 0, down: 0, nextReset: 0 } 
};
let historySummary = [];
let globalStats = { totalVolume: 0, totalFees: 0, totalASDF: 0, totalWinnings: 0, totalLifetimeUsers: 0, lastASDFSignature: null };
let processedSignatures = new Set(); 
let globalLeaderboard = [];
let knownUsers = new Set();
let currentQueueLength = 0;

// --- LOTTERY STATE ---
let lotteryState = {
    currentRound: 1,
    roundStartTime: Date.now(),
    lastDrawTime: null,
    nextDrawTime: Date.now() + LOTTERY_CONFIG.DRAW_INTERVAL_MS
};
let lotteryHistory = { draws: [] };
let cachedCirculatingSupply = { value: 0, timestamp: 0 }; 

// --- STATE CACHING (NEW) ---
let cachedPublicState = null;
let sentimentVotes = new Map();
let isProcessingQueue = false;
let payoutHistory = []; 

function getNextDayTimestamp() { // MODIFIED: Next Day Reset
    const now = new Date();
    now.setDate(now.getDate() + 1);
    now.setHours(0, 0, 0, 0); // Reset at midnight EST
    return now.getTime();
}

function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}


async function loadAndInit() {
    await initImages(); 
    await loadGlobalState(); 
    await updatePrice(); 
    
    isInitialized = true; 
    updatePublicStateCache(); 

    log(`> [SYS] Backend Initialization Complete.`, "SYS");
}

function loadGlobalState() {
    try {
        if (fsSync.existsSync(HISTORY_FILE)) historySummary = JSON.parse(fsSync.readFileSync(HISTORY_FILE));
        if (fsSync.existsSync(STATS_FILE)) {
            const loaded = JSON.parse(fsSync.readFileSync(STATS_FILE));
            globalStats = { ...globalStats, ...loaded };
            if(!globalStats.totalWinnings) globalStats.totalWinnings = 0;
            if(!globalStats.totalLifetimeUsers) globalStats.totalLifetimeUsers = 0;
        }
        if (fsSync.existsSync(SIGS_FILE)) {
            const fileContent = fsSync.readFileSync(SIGS_FILE, 'utf-8');
            const lines = fileContent.split('\n');
            lines.slice(-5000).forEach(line => { if(line.trim()) processedSignatures.add(line.trim()); });
        }
        if (fsSync.existsSync(PAYOUT_HISTORY_FILE)) payoutHistory = JSON.parse(fsSync.readFileSync(PAYOUT_HISTORY_FILE));
        
        // NEW: Load Sentiment Votes Map
        if (fsSync.existsSync(SENTIMENT_VOTES_FILE)) {
            const voteArray = JSON.parse(fsSync.readFileSync(SENTIMENT_VOTES_FILE));
            sentimentVotes = new Map(voteArray);
        }

        if (fsSync.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fsSync.readFileSync(STATE_FILE));
            gameState = { ...gameState, ...savedState };
            gameState.isResetting = false; 
            if (!gameState.broadcast) gameState.broadcast = { message: "", isActive: false };
            if (!gameState.vaultStartBalance) gameState.vaultStartBalance = 0; 
            
            // Re-init sentiment if missing or incorrectly hourly (now daily)
            if (!gameState.hourlySentiment || !gameState.hourlySentiment.nextReset) {
                gameState.hourlySentiment = { up: 0, down: 0, nextReset: getNextDayTimestamp() };
            }
            
            if (gameState.candleStartTime > 0) {
                const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
                if (fsSync.existsSync(currentFrameFile)) {
                    const frameData = JSON.parse(fsSync.readFileSync(currentFrameFile));
                    gameState.bets = frameData.bets || [];
                }
            }
        } else {
            gameState.hourlySentiment = { up: 0, down: 0, nextReset: getNextDayTimestamp() };
        }
        
        const userFiles = fsSync.readdirSync(USERS_DIR);
        userFiles.forEach(f => {
            if(f.startsWith('user_') && f.endsWith('.json')) {
                knownUsers.add(f.replace('user_','').replace('.json',''));
            }
        });
        globalStats.totalLifetimeUsers = knownUsers.size; 
        
        let recalculatedWinnings = 0;
        if (historySummary.length > 0) recalculatedWinnings = historySummary.reduce((sum, frame) => sum + (frame.payout || 0), 0);
        globalStats.totalWinnings = recalculatedWinnings;
        
        log(`> [SYS] State Loaded.`);

    } catch (e) { log(`> [ERR] Load Error: ${e}`, "ERR"); }
}

async function saveSystemState() {
    await atomicWrite(STATE_FILE, {
        candleOpen: gameState.candleOpen, candleStartTime: gameState.candleStartTime, poolShares: gameState.poolShares, recentTrades: gameState.recentTrades,
        sharePriceHistory: gameState.sharePriceHistory, isPaused: gameState.isPaused, isResetting: gameState.isResetting, isCancelled: gameState.isCancelled,
        lastPriceTimestamp: gameState.lastPriceTimestamp, broadcast: gameState.broadcast, vaultStartBalance: gameState.vaultStartBalance, hourlySentiment: gameState.hourlySentiment
    });
    await atomicWrite(STATS_FILE, globalStats);
    
    // NEW: Save Sentiment Votes Map
    await atomicWrite(SENTIMENT_VOTES_FILE, Array.from(sentimentVotes.entries()));
}

async function getUser(pubKey) {
    if (!isValidSolanaAddress(pubKey)) { return { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0, frameLog: {} }; }
    const file = path.join(USERS_DIR, `user_${pubKey}.json`);
    try {
        const data = await fs.readFile(file, 'utf8');
        return JSON.parse(data);
    } catch (e) { return { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0, frameLog: {} }; }
}

async function saveUser(pubKey, data) {
    if (!isValidSolanaAddress(pubKey)) return;
    try {
        const file = path.join(USERS_DIR, `user_${pubKey}.json`);
        await atomicWrite(file, data);
    } catch (e) {}
}

// Record daily activity for lottery eligibility multiplier
async function recordUserActivity(pubKey) {
    if (!isValidSolanaAddress(pubKey)) return;

    const userData = await getUser(pubKey);
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    // Initialize lottery object if not present
    if (!userData.lottery) {
        userData.lottery = {
            activityDays: [],
            firstSeenHolding: null,
            wins: [],
            participatedRounds: []
        };
    }

    // Initialize activityDays if not present
    if (!userData.lottery.activityDays) {
        userData.lottery.activityDays = [];
    }

    // Add today if not already recorded
    if (!userData.lottery.activityDays.includes(today)) {
        userData.lottery.activityDays.push(today);
    }

    // Keep only the last 7 days (cleanup old entries)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOTTERY_CONFIG.ACTIVITY_WINDOW_DAYS);
    userData.lottery.activityDays = userData.lottery.activityDays.filter(day => {
        return new Date(day) >= cutoffDate;
    });

    await saveUser(pubKey, userData);
}

// Calculate activity multiplier (0 to 1 based on active days in last 7 days)
function calculateActivityMultiplier(activityDays) {
    if (!activityDays || activityDays.length === 0) return 0;

    const now = new Date();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOTTERY_CONFIG.ACTIVITY_WINDOW_DAYS);

    // Count unique days active in the window
    const recentDays = activityDays.filter(day => new Date(day) >= cutoffDate);
    const uniqueDays = [...new Set(recentDays)].length;

    return uniqueDays / LOTTERY_CONFIG.ACTIVITY_WINDOW_DAYS; // 0 to 1
}

// --- LOTTERY PERSISTENCE ---
function loadLotteryState() {
    try {
        if (fsSync.existsSync(LOTTERY_STATE_FILE)) {
            lotteryState = JSON.parse(fsSync.readFileSync(LOTTERY_STATE_FILE));
            console.log(`> [LOTTERY] State loaded. Round ${lotteryState.currentRound}, next draw: ${new Date(lotteryState.nextDrawTime).toISOString()}`);
        }
        if (fsSync.existsSync(LOTTERY_HISTORY_FILE)) {
            lotteryHistory = JSON.parse(fsSync.readFileSync(LOTTERY_HISTORY_FILE));
            console.log(`> [LOTTERY] History loaded. ${lotteryHistory.draws.length} past draws.`);
        }
    } catch (e) {
        console.error("> [LOTTERY] Load Error:", e.message);
    }
}

async function saveLotteryState() {
    await atomicWrite(LOTTERY_STATE_FILE, lotteryState);
}

async function saveLotteryHistory() {
    await atomicWrite(LOTTERY_HISTORY_FILE, lotteryHistory);
}

// --- LOTTERY ON-CHAIN QUERIES ---
async function getCirculatingSupply() {
    const now = Date.now();
    // Return cached value if still valid
    if (cachedCirculatingSupply.value > 0 && (now - cachedCirculatingSupply.timestamp) < LOTTERY_CONFIG.SUPPLY_CACHE_MS) {
        return cachedCirculatingSupply.value;
    }

    try {
        const connection = new Connection(SOLANA_NETWORK);
        const mintPubKey = new PublicKey(ASDF_MINT);
        const mintInfo = await connection.getParsedAccountInfo(mintPubKey);

        if (mintInfo.value && mintInfo.value.data.parsed) {
            const supply = mintInfo.value.data.parsed.info.supply;
            const decimals = mintInfo.value.data.parsed.info.decimals;
            const circulatingSupply = Number(supply) / Math.pow(10, decimals);

            cachedCirculatingSupply = { value: circulatingSupply, timestamp: now };
            console.log(`> [LOTTERY] Circulating supply: ${circulatingSupply.toLocaleString()} ASDF`);
            return circulatingSupply;
        }
    } catch (e) {
        console.error("> [LOTTERY] Supply query failed:", e.message);
    }

    // Fallback to cached value if query fails
    return cachedCirculatingSupply.value || 1000000000; // Default 1B if no data
}

async function getUserASDFBalance(userPubKey) {
    try {
        const connection = new Connection(SOLANA_NETWORK);
        const owner = new PublicKey(userPubKey);
        const mintPubKey = new PublicKey(ASDF_MINT);

        // Get token accounts for this owner
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPubKey });

        let totalBalance = 0;
        for (const account of tokenAccounts.value) {
            const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
            totalBalance += balance || 0;
        }

        return totalBalance;
    } catch (e) {
        console.error(`> [LOTTERY] Balance query failed for ${userPubKey}:`, e.message);
        return 0;
    }
}

async function checkLotteryEligibility(userPubKey) {
    const supply = await getCirculatingSupply();
    const threshold = supply * LOTTERY_CONFIG.ELIGIBILITY_PERCENT;
    const balance = await getUserASDFBalance(userPubKey);

    return {
        isEligible: balance >= threshold,
        balance: balance,
        threshold: threshold,
        supply: supply
    };
}

function calculateTickets(user) {
    if (!user.lottery || !user.lottery.isEligible) return { base: 0, effective: 0, multiplier: 0 };

    const weeksHeld = Math.floor(
        (Date.now() - (user.lottery.firstSeenHolding || Date.now())) / (7 * 24 * 60 * 60 * 1000)
    );

    const baseTickets = Math.min(1 + weeksHeld, LOTTERY_CONFIG.MAX_TICKETS);
    const activityDays = user.lottery.activityDays || [];
    const activityMultiplier = calculateActivityMultiplier(activityDays);
    const effectiveTickets = activityMultiplier > 0 ? Math.max(1, Math.round(baseTickets * activityMultiplier)) : 0;

    return {
        base: baseTickets,
        effective: effectiveTickets,
        multiplier: activityMultiplier,
        activeDays: activityDays.length
    };
}

async function updateUserLotteryStatus(userPubKey) {
    const userData = await getUser(userPubKey);
    const eligibility = await checkLotteryEligibility(userPubKey);

    if (!userData.lottery) {
        userData.lottery = {
            firstSeenHolding: null,
            lastBalanceCheck: Date.now(),
            currentBalance: eligibility.balance,
            weeksHolding: 0,
            isEligible: eligibility.isEligible,
            wins: [],
            participatedRounds: []
        };
    }

    // Update balance and eligibility
    userData.lottery.currentBalance = eligibility.balance;
    userData.lottery.lastBalanceCheck = Date.now();

    if (eligibility.isEligible) {
        // If newly eligible, set firstSeenHolding
        if (!userData.lottery.firstSeenHolding) {
            userData.lottery.firstSeenHolding = Date.now();
        }
        userData.lottery.isEligible = true;
        userData.lottery.weeksHolding = Math.floor(
            (Date.now() - userData.lottery.firstSeenHolding) / (7 * 24 * 60 * 60 * 1000)
        );
    } else {
        // Lost eligibility - reset holding duration
        userData.lottery.firstSeenHolding = null;
        userData.lottery.weeksHolding = 0;
        userData.lottery.isEligible = false;
    }

    await saveUser(userPubKey, userData);
    return userData;
}

// --- LOTTERY DRAW MECHANISM ---

// Get earliest transaction for a token account to determine holding duration
async function getTokenAccountFirstTransaction(connection, tokenAccountAddress) {
    try {
        let lastSig = undefined;
        let oldestTimestamp = null;

        // Paginate through all signatures to find the oldest
        for (let i = 0; i < 10; i++) {
            const options = { limit: 1000 };
            if (lastSig) options.before = lastSig;

            const sigs = await connection.getSignaturesForAddress(
                new PublicKey(tokenAccountAddress),
                options
            );

            if (sigs.length === 0) break;

            // The last signature in the response is the oldest in this batch
            const oldestSig = sigs[sigs.length - 1];
            if (oldestSig.blockTime) {
                oldestTimestamp = oldestSig.blockTime * 1000;
            }

            lastSig = oldestSig.signature;
            if (sigs.length < 1000) break; // No more pages
        }

        return oldestTimestamp;
    } catch (e) {
        console.error(`> [LOTTERY] Error getting token account history:`, e.message);
        return null;
    }
}

// Scan all on-chain ASDF holders and return eligible participants with accurate holding duration
async function getEligibleParticipants() {
    const participants = [];

    try {
        const connection = new Connection(SOLANA_NETWORK);
        const mintPubKey = new PublicKey(ASDF_MINT);

        // Get circulating supply and calculate threshold
        const supply = await getCirculatingSupply();
        const threshold = supply * LOTTERY_CONFIG.ELIGIBILITY_PERCENT;

        console.log(`> [LOTTERY] Scanning on-chain holders... Threshold: ${Math.round(threshold).toLocaleString()} ASDF`);

        // Get top token accounts (largest holders)
        const largestAccounts = await connection.getTokenLargestAccounts(mintPubKey);

        const now = Date.now();
        const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

        for (const account of largestAccounts.value) {
            const balance = account.uiAmount || 0;

            // Skip if below threshold
            if (balance < threshold) continue;

            try {
                // Get owner of this token account
                const accountInfo = await connection.getParsedAccountInfo(account.address);
                if (!accountInfo.value || !accountInfo.value.data.parsed) continue;

                const ownerPubKey = accountInfo.value.data.parsed.info.owner;

                // Check user activity - MUST have played on the platform
                const userData = await getUser(ownerPubKey);
                const activityDays = userData.lottery?.activityDays || [];
                const activityMultiplier = calculateActivityMultiplier(activityDays);

                // Skip users with no activity (0 days active = 0 tickets)
                if (activityMultiplier === 0) {
                    console.log(`> [LOTTERY] ${ownerPubKey.slice(0, 8)}... | ${Math.round(balance).toLocaleString()} ASDF | NO ACTIVITY - SKIPPED`);
                    continue;
                }

                // Get first transaction timestamp for this token account
                const firstAcquired = await getTokenAccountFirstTransaction(connection, account.address.toString());

                // Calculate weeks holding
                let weeksHolding = 0;
                if (firstAcquired) {
                    weeksHolding = Math.max(0, Math.floor((now - firstAcquired) / oneWeekMs));
                }

                // Calculate base tickets: 1 base + weeks holding (max 52)
                const baseTickets = Math.min(1 + weeksHolding, LOTTERY_CONFIG.MAX_TICKETS);

                // Apply activity multiplier: effectiveTickets = baseTickets * (activeDays / 7)
                const effectiveTickets = Math.max(1, Math.round(baseTickets * activityMultiplier));

                if (effectiveTickets > 0) {
                    participants.push({
                        pubKey: ownerPubKey,
                        tickets: effectiveTickets,
                        baseTickets: baseTickets,
                        activityMultiplier: activityMultiplier,
                        activeDays: activityDays.length,
                        balance: Math.round(balance),
                        weeksHolding: weeksHolding,
                        firstAcquired: firstAcquired
                    });

                    console.log(`> [LOTTERY] ${ownerPubKey.slice(0, 8)}... | ${Math.round(balance).toLocaleString()} ASDF | ${weeksHolding}w | ${activityDays.length}/7 days | ${effectiveTickets} tickets (base: ${baseTickets})`);
                }

                // Rate limit to avoid RPC throttling
                await new Promise(r => setTimeout(r, 200));

            } catch (e) {
                console.error(`> [LOTTERY] Error processing account:`, e.message);
            }
        }

        console.log(`> [LOTTERY] Scan complete. ${participants.length} eligible holders with activity found.`);

    } catch (e) {
        console.error("> [LOTTERY] Error scanning holders:", e.message);
    }

    return participants;
}

async function executeLotteryDraw() {
    // Prevent concurrent draws with mutex
    const release = await lotteryMutex.acquire();

    try {
        console.log(`> [LOTTERY] Starting draw for Round ${lotteryState.currentRound}...`);
        // 1. Get all eligible participants
        const participants = await getEligibleParticipants();

        if (participants.length === 0) {
            console.log("> [LOTTERY] No eligible participants. Skipping draw.");
            // Still advance to next round
            lotteryState.lastDrawTime = Date.now();
            lotteryState.nextDrawTime = Date.now() + LOTTERY_CONFIG.DRAW_INTERVAL_MS;
            lotteryState.currentRound++;
            await saveLotteryState();
            return { success: false, reason: "NO_PARTICIPANTS" };
        }

        // 2. Build weighted ticket pool
        let totalTickets = 0;
        const ticketPool = [];

        for (const participant of participants) {
            for (let i = 0; i < participant.tickets; i++) {
                ticketPool.push(participant.pubKey);
            }
            totalTickets += participant.tickets;

            // Mark participation in user data
            const userData = await getUser(participant.pubKey);
            // Initialize lottery object if not present
            if (!userData.lottery) {
                userData.lottery = { activityDays: [], wins: [], participatedRounds: [] };
            }
            if (!userData.lottery.participatedRounds) userData.lottery.participatedRounds = [];
            userData.lottery.participatedRounds.push(lotteryState.currentRound);
            await saveUser(participant.pubKey, userData);
        }

        console.log(`> [LOTTERY] ${participants.length} participants with ${totalTickets} total tickets`);

        // 3. Calculate prize
        const prize = LOTTERY_CONFIG.BASE_PRIZE + (totalTickets * LOTTERY_CONFIG.PRIZE_PER_TICKET);

        // 4. Select random winner using crypto.randomInt for fairness
        const randomIndex = crypto.randomInt(0, ticketPool.length);
        const winnerPubKey = ticketPool[randomIndex];

        console.log(`> [LOTTERY] Winner selected: ${winnerPubKey.slice(0, 8)}...`);

        // 5. Record the draw
        const drawRecord = {
            round: lotteryState.currentRound,
            timestamp: Date.now(),
            winner: winnerPubKey,
            prize: prize,
            totalTickets: totalTickets,
            participantCount: participants.length,
            txSignature: null // Will be updated after transfer
        };

        // 6. Update winner's user data
        const winnerData = await getUser(winnerPubKey);
        // Initialize lottery object if not present
        if (!winnerData.lottery) {
            winnerData.lottery = { activityDays: [], wins: [], participatedRounds: [] };
        }
        if (!winnerData.lottery.wins) winnerData.lottery.wins = [];
        winnerData.lottery.wins.push({
            round: lotteryState.currentRound,
            prize: prize,
            timestamp: Date.now()
        });
        await saveUser(winnerPubKey, winnerData);

        // 7. Save draw to history
        lotteryHistory.draws.unshift(drawRecord);
        if (lotteryHistory.draws.length > 52) {
            lotteryHistory.draws = lotteryHistory.draws.slice(0, 52); // Keep 1 year of history
        }
        await saveLotteryHistory();

        // 8. Update lottery state for next round
        lotteryState.lastDrawTime = Date.now();
        lotteryState.nextDrawTime = Date.now() + LOTTERY_CONFIG.DRAW_INTERVAL_MS;
        lotteryState.currentRound++;
        await saveLotteryState();

        console.log(`> [LOTTERY] Draw complete! Winner: ${winnerPubKey.slice(0, 8)}... Prize: ${prize.toLocaleString()} ASDF`);

        return {
            success: true,
            winner: winnerPubKey,
            prize: prize,
            totalTickets: totalTickets,
            participantCount: participants.length,
            round: drawRecord.round
        };

    } catch (e) {
        console.error("> [LOTTERY] Draw failed:", e.message);
        return { success: false, reason: "DRAW_ERROR", error: e.message };
    } finally {
        release(); // Always release mutex
    }
}

// Check if it's time for a lottery draw
async function checkLotterySchedule() {
    if (Date.now() >= lotteryState.nextDrawTime) {
        console.log("> [LOTTERY] Draw time reached. Executing...");
        await executeLotteryDraw();
    }
}

loadGlobalState();
loadLotteryState();

// ... (unchanged ASDF logic) ... 
async function updateASDFPurchases() {
    const connection = new Connection(SOLANA_NETWORK); 
    try {
        const options = { limit: 20 };
        if (globalStats.lastASDFSignature) options.until = globalStats.lastASDFSignature;
        const signaturesDetails = await connection.getSignaturesForAddress(FEE_WALLET, options);
        if (signaturesDetails.length === 0) return;
        globalStats.lastASDFSignature = signaturesDetails[0].signature;
        const txs = await connection.getParsedTransactions(signaturesDetails.map(s => s.signature), { maxSupportedTransactionVersion: 0 });
        let newPurchasedAmount = 0;
        for (const tx of txs) {
            if (!tx || !tx.meta) continue;
            const preBal = tx.meta.preTokenBalances.find(b => b.mint === ASDF_MINT && b.owner === FEE_WALLET.toString());
            const postBal = tx.meta.postTokenBalances.find(b => b.mint === ASDF_MINT && b.owner === FEE_WALLET.toString());
            const preAmount = preBal?.uiTokenAmount.uiAmount || 0;
            const postAmount = postBal?.uiTokenAmount.uiAmount || 0;
            if (postAmount > preAmount) newPurchasedAmount += (postAmount - preAmount);
        }
        if (newPurchasedAmount > 0) {
             globalStats.totalASDF += newPurchasedAmount;
        }
    } catch (e) { log(`> [ASDF] History Check Failed: ${e.message}`, "ERR"); }
}

async function updateLeaderboard() {
    try {
        const files = await fs.readdir(USERS_DIR);
        const leaders = [];
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = await fs.readFile(path.join(USERS_DIR, file), 'utf8');
                const data = JSON.parse(raw);
                let totalWon = 0;
                if (data.frameLog) Object.values(data.frameLog).forEach(log => { if (log.payoutAmount) totalWon += log.payoutAmount; });
                const totalGames = data.wins + data.losses;
                if (totalGames > 0) leaders.push({ pubKey: file.replace('user_', '').replace('.json', ''), wins: data.wins, bets: totalGames, winRate: (data.wins / totalGames) * 100, totalWon: totalWon });
            } catch(e) {}
        }
        leaders.sort((a, b) => b.totalWon - a.totalWon);
        globalLeaderboard = leaders.slice(0, 5); 
    } catch (e) {}
}
setInterval(updateLeaderboard, 60000); 
updateLeaderboard(); 

async function processPayoutQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    const release = await payoutMutex.acquire();
    try {
        if (!houseKeypair || !fsSync.existsSync(QUEUE_FILE)) { currentQueueLength = 0; return; }
        let queueData = [];
        try { queueData = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch(e) { queueData = []; }
        currentQueueLength = queueData.length;
        if (!queueData || queueData.length === 0) return;

        log(`> [QUEUE] Processing ${queueData.length} batches...`, "QUEUE");
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        
        while (queueData.length > 0) {
            const batch = queueData[0];
            if (typeof batch.retries === 'undefined') batch.retries = 0;
            const { type, recipients, frameId } = batch;
            try {
                const tx = new Transaction();
                const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_UNITS });
                tx.add(priorityFeeIx);
                let hasInstructions = false;
                const validRecipients = [];
                let totalBatchAmount = 0;
                if (type === 'USER_PAYOUT' || type === 'USER_REFUND') {
                    for (const item of recipients) {
                        const uData = await getUser(item.pubKey);
                        if (type === 'USER_PAYOUT' && uData.frameLog && uData.frameLog[frameId] && uData.frameLog[frameId].payoutTx) continue; 
                        validRecipients.push(item); totalBatchAmount += (item.amount || 0);
                    }
                } else { recipients.forEach(r => { validRecipients.push(r); totalBatchAmount += (r.amount || 0); }); }
                if (validRecipients.length > 0) {
                    for (const item of validRecipients) { tx.add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: new PublicKey(item.pubKey), lamports: item.amount })); hasInstructions = true; }
                    if (hasInstructions) {
                        const sig = await sendAndConfirmTransaction(connection, tx, [houseKeypair], { commitment: 'confirmed', maxRetries: 5 });
                        log(`> [TX] Batch Sent (${type}): ${sig}`, "TX");
                        const historyRecord = { timestamp: Date.now(), frameId: frameId || 'N/A', type: type, signature: sig, recipientCount: validRecipients.length, totalAmount: (totalBatchAmount / 1e9).toFixed(4) };
                        payoutHistory.unshift(historyRecord);
                        if (payoutHistory.length > 100) payoutHistory.pop();
                        await atomicWrite(PAYOUT_HISTORY_FILE, payoutHistory);
                        await fs.appendFile(PAYOUT_MASTER_LOG, JSON.stringify(historyRecord) + '\n');
                        if (type === 'USER_PAYOUT') {
                            for (const item of validRecipients) {
                                const uData = await getUser(item.pubKey);
                                if (uData.frameLog && uData.frameLog[frameId]) { uData.frameLog[frameId].payoutTx = sig; uData.frameLog[frameId].payoutAmount = item.amount / 1e9; await saveUser(item.pubKey, uData); }
                            }
                        } else if (type === 'USER_REFUND') {
                            for (const item of validRecipients) {
                                const uData = await getUser(item.pubKey);
                                if (!uData.frameLog[frameId]) uData.frameLog[frameId] = { result: 'CANCELLED', time: Date.now() };
                                uData.frameLog[frameId].refundTx = sig;
                                await saveUser(item.pubKey, uData);
                            }
                        }
                    }
                }
                queueData.shift(); await atomicWrite(QUEUE_FILE, queueData); currentQueueLength = queueData.length;
            } catch (e) { 
                log(`> [TX] Batch Failed: ${e.message}`, "ERR");
                batch.retries = (batch.retries || 0) + 1;
                if (batch.retries >= 5) {
                     log(`> [QUEUE] Batch failed 5 times. Decomposing or Logging Failure.`, "ERR");
                     queueData.shift(); 
                     if (batch.recipients.length > 1) {
                         for (const item of batch.recipients) { queueData.push({ type: 'USER_REFUND', frameId: batch.frameId, recipients: [item], retries: 0 }); }
                     } else {
                         const failedRecord = { timestamp: Date.now(), batch: batch, error: e.message };
                         await fs.appendFile(FAILED_REFUNDS_FILE, JSON.stringify(failedRecord) + '\n');
                     }
                     await atomicWrite(QUEUE_FILE, queueData);
                } else {
                     await atomicWrite(QUEUE_FILE, queueData);
                     break; 
                }
                currentQueueLength = queueData.length;
            }
        }
    } catch (e) { log(`> [QUEUE] Error: ${e}`, "ERR"); }
    finally { release(); isProcessingQueue = false; }
}

setInterval(processPayoutQueue, 20000);

async function queuePayouts(frameId, result, bets, totalVolume) {
    log(`> [PAYOUT] Queuing payouts for Frame ${frameId}. Result: ${result}, Vol: ${totalVolume}`, "PAYOUT");
    if (totalVolume === 0) return;
    const queue = []; 

    if (result === "FLAT") {
        const burnLamports = Math.floor((totalVolume * 0.99) * 1e9);
        if (burnLamports > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: FEE_WALLET.toString(), amount: burnLamports }], retries: 0 });
    } else {
        const feeLamports = Math.floor((totalVolume * FEE_PERCENT) * 1e9); 
        const upkeepLamports = Math.floor((totalVolume * UPKEEP_PERCENT) * 1e9); 
        
        if (feeLamports > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: FEE_WALLET.toString(), amount: feeLamports }], retries: 0 });
        if (upkeepLamports > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: UPKEEP_WALLET.toString(), amount: upkeepLamports }], retries: 0 });
    }

    if (result !== "FLAT") {
        const potLamports = Math.floor((totalVolume * 0.94) * 1e9);
        const userPositions = {};
        bets.forEach(bet => {
            if (!userPositions[bet.user]) userPositions[bet.user] = { up: 0, down: 0 };
            if (bet.direction === 'UP') userPositions[bet.user].up += bet.shares;
            else userPositions[bet.user].down += bet.shares;
        });

        let totalWinningShares = 0;
        const eligibleWinners = [];

        for (const [pubKey, pos] of Object.entries(userPositions)) {
            const rUp = Math.round(pos.up * 10000) / 10000;
            const rDown = Math.round(pos.down * 10000) / 10000;
            let userDir = "FLAT";
            if (rUp > rDown) userDir = "UP";
            else if (rDown > rUp) userDir = "DOWN";
            if (pos.up === pos.down) userDir = "FLAT"; 

            if (userDir === result) {
                const sharesHeld = result === "UP" ? pos.up : pos.down;
                totalWinningShares += sharesHeld;
                eligibleWinners.push({ pubKey, sharesHeld });
            }
        }

        if (totalWinningShares > 0) {
            const BATCH_SIZE = 12; 
            for (let i = 0; i < eligibleWinners.length; i += BATCH_SIZE) {
                const batchWinners = eligibleWinners.slice(i, i + BATCH_SIZE);
                const batchRecipients = [];
                for (const winner of batchWinners) {
                    const shareRatio = winner.sharesHeld / totalWinningShares;
                    const payoutLamports = Math.floor(potLamports * shareRatio);
                    if (payoutLamports > 5000) batchRecipients.push({ pubKey: winner.pubKey, amount: payoutLamports });
                }
                if (batchRecipients.length > 0) queue.push({ type: 'USER_PAYOUT', frameId: frameId, recipients: batchRecipients, retries: 0 });
            }
        }
    }

    const release = await payoutMutex.acquire();
    try {
        let existingQueue = [];
        if (fsSync.existsSync(QUEUE_FILE)) { try { existingQueue = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch(e) {} }
        const newQueue = existingQueue.concat(queue);
        await atomicWrite(QUEUE_FILE, newQueue);
        currentQueueLength = newQueue.length;
    } finally { release(); }
    
    processPayoutQueue();
}

async function processRefunds(frameId, bets) {
    log(`> [REFUND] Processing refunds for Frame ${frameId}. Count: ${bets.length}`, "REFUND");
    if (!houseKeypair || bets.length === 0) return;
    const refunds = {};
    let totalFee = 0;
    bets.forEach(bet => {
        if (!refunds[bet.user]) refunds[bet.user] = 0;
        const refundAmt = Math.floor(bet.costSol * 0.99 * 1e9);
        refunds[bet.user] += refundAmt;
        totalFee += (bet.costSol * 0.01 * 1e9);
    });
    const queue = [];
    if (totalFee > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: FEE_WALLET.toString(), amount: Math.floor(totalFee) }], retries: 0 });
    const recipients = Object.entries(refunds).map(([pub, amt]) => ({ pubKey: pub, amount: amt }));
    const BATCH_SIZE = 12;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        queue.push({ type: 'USER_REFUND', frameId: frameId, recipients: batch, retries: 0 }); 
    }
    const release = await payoutMutex.acquire();
    try {
        let existingQueue = [];
        if (fsSync.existsSync(QUEUE_FILE)) { try { existingQueue = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch(e) {} }
        const newQueue = existingQueue.concat(queue);
        await atomicWrite(QUEUE_FILE, newQueue);
        currentQueueLength = newQueue.length;
    } finally { release(); }
    
    processPayoutQueue();
}

async function cancelCurrentFrameAndRefund() {
    gameState.isPaused = true;
    gameState.isCancelled = true;
    if (gameState.bets.length > 0) {
        log(`> [CANCEL] Performing Cancellation & Refund for frame ${gameState.candleStartTime}...`, "CANCEL");
        const betsToRefund = [...gameState.bets];
        const frameRecord = { id: gameState.candleStartTime, time: new Date(gameState.candleStartTime).toISOString(), result: "CANCELLED", totalSol: 0, winners: 0, payout: 0 };
        historySummary.unshift(frameRecord);
        if (historySummary.length > 100) historySummary = historySummary.slice(0, 100);
        await atomicWrite(HISTORY_FILE, historySummary);
        gameState.bets = [];
        gameState.poolShares = { up: 50, down: 50 };
        processRefunds(gameState.candleStartTime, betsToRefund);
    }
    await saveSystemState();
}

async function closeFrame(closePrice, closeTime) {
    try {
        const frameId = gameState.candleStartTime; 
        log(`> [SYS] Closing Frame: ${frameId}`);

        // 1. GET VAULT CLOSING BALANCE
        let vaultEndBalance = 0;
        if (houseKeypair) {
             try {
                const connection = new Connection(SOLANA_NETWORK);
                vaultEndBalance = (await connection.getBalance(houseKeypair.publicKey)) / 1e9;
             } catch(e) { log(`> [ERR] Failed to fetch vault close balance: ${e.message}`, "WARN"); }
        }

        await updateASDFPurchases();

        const openPrice = gameState.candleOpen;
        let result = "FLAT";
        if (closePrice > openPrice) result = "UP";
        else if (closePrice < openPrice) result = "DOWN";

        const realSharesUp = Math.max(0, gameState.poolShares.up - 50);
        const realSharesDown = Math.max(0, gameState.poolShares.down - 50);
        const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

        let feeAmt = 0;
        let upkeepAmt = 0;

        if (result === "FLAT") {
             feeAmt = frameSol * 0.99;
        } else {
             feeAmt = frameSol * FEE_PERCENT;
             upkeepAmt = frameSol * UPKEEP_PERCENT;
        }

        globalStats.totalFees += feeAmt;

        let winnerCount = 0;
        let payoutTotal = 0;
        // FIX: userPositions hoisted to avoid ReferenceError below
        const userPositions = {}; 
        
        if (result !== "FLAT") {
            const potSol = frameSol * 0.94;
            gameState.bets.forEach(bet => {
                if (!userPositions[bet.user]) userPositions[bet.user] = { up: 0, down: 0 };
                if (bet.direction === 'UP') userPositions[bet.user].up += bet.shares;
                else userPositions[bet.user].down += bet.shares;
            });
            for (const [pk, pos] of Object.entries(userPositions)) {
                const rUp = Math.round(pos.up * 10000) / 10000;
                const rDown = Math.round(pos.down * 10000) / 10000;
                let dir = "FLAT";
                if (rUp > rDown) dir = "UP";
                else if (rDown > rUp) dir = "DOWN";
                if (rUp === rDown) dir = "FLAT";
                if (dir === result) winnerCount++;
            }
            if (winnerCount > 0) {
                payoutTotal = potSol;
                globalStats.totalWinnings += payoutTotal; 
            }
        }

        const uniqueUsers = new Set(gameState.bets.map(b => b.user)).size;
        
        const frameRecord = {
            id: frameId, startTime: frameId, endTime: frameId + FRAME_DURATION,
            time: new Date(frameId).toISOString(), open: openPrice, close: closePrice,
            result: result, sharesUp: realSharesUp, sharesDown: realSharesDown,
            totalSol: frameSol, winners: winnerCount, payout: payoutTotal,
            fee: feeAmt, upkeep: upkeepAmt, users: uniqueUsers, vStart: gameState.vaultStartBalance, vEnd: vaultEndBalance
        };
        
        historySummary.unshift(frameRecord);
        if (historySummary.length > 100) historySummary = historySummary.slice(0, 100);
        await atomicWrite(HISTORY_FILE, historySummary);

        const betsSnapshot = [...gameState.bets];
        const usersToUpdate = Object.entries(userPositions);
        const USER_IO_BATCH_SIZE = 20; 
        for (let i = 0; i < usersToUpdate.length; i += USER_IO_BATCH_SIZE) {
            const batch = usersToUpdate.slice(i, i + USER_IO_BATCH_SIZE);
            await Promise.all(batch.map(async ([pubKey, pos]) => {
                const userData = await getUser(pubKey);
                userData.framesPlayed += 1;
                const rUp = Math.round(pos.up * 10000) / 10000;
                const rDown = Math.round(pos.down * 10000) / 10000;
                let userDir = "FLAT";
                if (rUp > rDown) userDir = "UP";
                else if (rDown > rUp) userDir = "DOWN";
                if (rUp === rDown) userDir = "FLAT";
                const outcome = (userDir !== "FLAT" && result !== "FLAT" && userDir === result) ? "WIN" : "LOSS";
                if (outcome === "WIN") userData.wins += 1; else if (outcome === "LOSS") userData.losses += 1;
                if (!userData.frameLog) userData.frameLog = {};
                userData.frameLog[frameId] = { 
                    dir: userDir, result: outcome, time: Date.now(),
                    upShares: pos.up, downShares: pos.down, wagered: pos.sol
                };
                await saveUser(pubKey, userData);
            }));
        }

        processedSignatures.clear();
        await fs.writeFile(SIGS_FILE, '');

        updatePublicStateCache();
        
        gameState.candleStartTime = closeTime;
        gameState.candleOpen = closePrice;
        gameState.poolShares = { up: 50, down: 50 }; 
        gameState.bets = []; 
        gameState.sharePriceHistory = [];
        gameState.isResetting = false; 
        gameState.vaultStartBalance = vaultEndBalance; 

        await saveSystemState();
        await queuePayouts(frameId, result, betsSnapshot, frameSol); 
    } catch(e) {
        log(`> [ERR] CloseFrame Failed: ${e.message}`, "ERR");
        gameState.isResetting = false; 
    }
}

async function updatePrice() {
    let fetchedPrice = 0;
    let priceFound = false;

    try {
        const response = await axios.get(`${PYTH_HERMES_URL}?ids[]=${SOL_FEED_ID}`, { timeout: 2000 });
        if (response.data && response.data.parsed && response.data.parsed[0]) {
            const p = response.data.parsed[0].price;
            fetchedPrice = Number(p.price) * Math.pow(10, p.expo);
            priceFound = true;
        }
    } catch (e) { console.log(`[ORACLE] Pyth Failed: ${e.message}`); }

    if (!priceFound && COINGECKO_API_KEY) {
        try {
            const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: { ids: 'solana', vs_currencies: 'usd', x_cg_demo_api_key: COINGECKO_API_KEY },
                timeout: 4000
            });
            if (response.data.solana) {
                fetchedPrice = response.data.solana.usd;
                priceFound = true;
            }
        } catch (e) { console.log(`[ORACLE] CoinGecko Failed: ${e.message}`); }
    }

    if (priceFound) {
        await stateMutex.runExclusive(async () => {
            gameState.price = fetchedPrice;
            gameState.lastPriceTimestamp = Date.now();
            const currentWindowStart = getCurrentWindowStart();

            if (Date.now() >= gameState.hourlySentiment.nextReset) {
                log("> [SENTIMENT] Daily reset triggered. Clearing votes.", "SENTIMENT");
                gameState.hourlySentiment.up = 0;
                gameState.hourlySentiment.down = 0;
                gameState.hourlySentiment.nextReset = getNextDayTimestamp();
                sentimentVotes.clear(); 
                await saveSystemState();
            }

            const frameEndTime = gameState.candleStartTime + FRAME_DURATION;
            if (gameState.isResetting && Date.now() > (frameEndTime + 60000)) {
                 log("⚠️ [FAILSAFE] RESETTING stuck > 1m. Refunds issued. Starting new frame.", "FAILSAFE");
                 await cancelCurrentFrameAndRefund();
                 gameState.isResetting = false; 
                 gameState.isPaused = false; 
                 gameState.isCancelled = false; 
                 gameState.candleStartTime = currentWindowStart;
                 gameState.candleOpen = fetchedPrice;
                 gameState.poolShares = { up: 50, down: 50 }; 
                 gameState.bets = []; 
                 gameState.sharePriceHistory = [];
                 await saveSystemState();
                 updatePublicStateCache();
                 return;
            }
            if (gameState.isResetting) return;
            if (gameState.isPaused) {
                const timeRemaining = (gameState.candleStartTime + FRAME_DURATION) - Date.now();
                if (!gameState.isCancelled && timeRemaining < 300000 && timeRemaining > 0) {
                    log("⚠️ [AUTO] Auto-cancelling due to prolonged pause...", "AUTO");
                    await cancelCurrentFrameAndRefund(); 
                    return;
                }
                if (currentWindowStart > gameState.candleStartTime) {
                    log("> [SYS] Unpausing for new Frame.");
                    if (!gameState.isCancelled) {
                         const skippedFrameRecord = {
                            id: gameState.candleStartTime,
                            startTime: gameState.candleStartTime,
                            endTime: gameState.candleStartTime + FRAME_DURATION,
                            time: new Date(gameState.candleStartTime).toISOString(),
                            open: gameState.candleOpen,
                            close: fetchedPrice,
                            result: "PAUSED", 
                            sharesUp: 0, sharesDown: 0, totalSol: 0, winners: 0, payout: 0
                        };
                        historySummary.unshift(skippedFrameRecord);
                        if(historySummary.length > 100) historySummary = historySummary.slice(0,100);
                        await atomicWrite(HISTORY_FILE, historySummary);
                        gameState.isPaused = false; 
                    } else {
                        gameState.isCancelled = false;
                        gameState.isPaused = false;
                    }
                    gameState.candleStartTime = currentWindowStart;
                    gameState.candleOpen = fetchedPrice;
                    await saveSystemState();
                }
                return;
            }
            if (currentWindowStart > gameState.candleStartTime) {
                if (gameState.candleStartTime === 0) {
                    gameState.candleStartTime = currentWindowStart;
                    gameState.candleOpen = fetchedPrice;
                    await saveSystemState();
                } else {
                    log(`> [SYS] Closing Frame: ${gameState.candleStartTime} @ $${fetchedPrice}`);
                    gameState.isResetting = true; 
                    await saveSystemState();
                    await closeFrame(fetchedPrice, currentWindowStart);
                }
            }
            const totalS = gameState.poolShares.up + gameState.poolShares.down;
            const pUp = (gameState.poolShares.up / totalS) * PRICE_SCALE;
            const pDown = (gameState.poolShares.down / totalS) * PRICE_SCALE;
            if (!gameState.sharePriceHistory) gameState.sharePriceHistory = [];
            gameState.sharePriceHistory.push({ t: Date.now(), up: pUp, down: pDown });
            const FIVE_MINS = 5 * 60 * 1000;
            gameState.sharePriceHistory = gameState.sharePriceHistory.filter(x => x.t > Date.now() - FIVE_MINS);
            await saveSystemState();
        });
    }
}

setInterval(updatePrice, 10000); 
updatePrice(); 

// --- CACHE GENERATION ---
function updatePublicStateCache() {
    if (!isInitialized) return; 
    const now = Date.now();
    const priceChange = gameState.price - gameState.candleOpen;
    const percentChange = gameState.candleOpen ? (priceChange / gameState.candleOpen) * 100 : 0;
    const currentVolume = gameState.bets.reduce((acc, b) => acc + b.costSol, 0);
    const totalShares = gameState.poolShares.up + gameState.poolShares.down;
    const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
    const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
    const history = gameState.sharePriceHistory || [];
    const baseline = { up: 0.05, down: 0.05 };
    const oneMinAgo = history.find(x => x.t >= now - 60000) || baseline;
    const fiveMinAgo = history.find(x => x.t >= now - 300000) || baseline;
    function getPercentChange(current, old) { if (!old || old === 0) return 0; return ((current - old) / old) * 100; }
    const changes = {
        up1m: getPercentChange(priceUp, oneMinAgo.up),
        up5m: getPercentChange(priceUp, fiveMinAgo.up),
        down1m: getPercentChange(priceDown, oneMinAgo.down),
        down5m: getPercentChange(priceDown, fiveMinAgo.down),
    };
    const uniqueUsers = new Set(gameState.bets.map(b => b.user)).size;
    const lastFramePot = historySummary.length > 0 ? historySummary[0].totalSol : 0;

    cachedPublicState = {
        price: gameState.price,
        openPrice: gameState.candleOpen,
        candleStartTime: gameState.candleStartTime,
        candleEndTime: gameState.candleStartTime + FRAME_DURATION,
        change: percentChange,
        currentVolume: currentVolume,
        uniqueUsers: uniqueUsers,
        platformStats: globalStats,
        isPaused: gameState.isPaused,
        isResetting: gameState.isResetting,
        isCancelled: gameState.isCancelled,
        market: {
            priceUp, priceDown,
            sharesUp: gameState.poolShares.up,
            sharesDown: gameState.poolShares.down,
            changes
        },
        history: historySummary,
        recentTrades: gameState.recentTrades,
        leaderboard: globalLeaderboard,
        lastPriceTimestamp: gameState.lastPriceTimestamp,
        backendVersion: BACKEND_VERSION,
        payoutQueueLength: currentQueueLength,
        lastFramePot: lastFramePot,
        totalLifetimeUsers: globalStats.totalLifetimeUsers,
        totalWinnings: globalStats.totalWinnings,
        // Lottery summary
        lottery: {
            currentRound: lotteryState.currentRound,
            nextDrawTime: lotteryState.nextDrawTime,
            msUntilDraw: Math.max(0, lotteryState.nextDrawTime - now),
            recentWinner: lotteryHistory.draws.length > 0 ? lotteryHistory.draws[0].winner : null,
            recentPrize: lotteryHistory.draws.length > 0 ? lotteryHistory.draws[0].prize : null
        }
    };
}

setInterval(updatePublicStateCache, 500);

// --- ENDPOINTS ---
app.get('/api/state', stateLimiter, async (req, res) => {
    if (!isInitialized || !cachedPublicState) return res.status(503).json({ error: "SERVICE_UNAVAILABLE", reason: "Backend cache initializing." });
    const response = { ...cachedPublicState };
    const now = new Date();
    const nextWindowStart = getCurrentWindowStart() + FRAME_DURATION;
    response.msUntilClose = nextWindowStart - now.getTime();
    const userKey = req.query.user;
    if (userKey && isValidSolanaAddress(userKey)) {
        const myStats = await getUser(userKey);
        response.userStats = myStats;
        const userBets = gameState.bets.filter(b => b.user === userKey);
        response.activePosition = {
            upShares: userBets.filter(b => b.direction === 'UP').reduce((a, b) => a + b.shares, 0),
            downShares: userBets.filter(b => b.direction === 'DOWN').reduce((a, b) => a + b.shares, 0),
            upSol: userBets.filter(b => b.direction === 'UP').reduce((a, b) => a + b.costSol, 0),
            downSol: userBets.filter(b => b.direction === 'DOWN').reduce((a, b) => a + b.costSol, 0),
            wageredSol: userBets.reduce((a, b) => a + b.costSol, 0)
        };
    }
    res.json(response);
});

app.get('/api/image/fine', (req, res) => { res.json({ image: cachedItsFineImage }); });
app.get('/api/image/over', (req, res) => { res.json({ image: cachedItsOverImage }); });
app.get('/api/share-image', (req, res) => { res.json({ image: cachedShareImage }); });
app.get('/api/image/sentiment-up', (req, res) => { res.json({ image: cachedSentUpImage }); });
app.get('/api/image/sentiment-down', (req, res) => { res.json({ image: cachedSentDownImage }); });

app.post('/api/sentiment/vote', voteLimiter, async (req, res) => {
    const { direction, userPubKey } = req.body; 
    if (!['UP', 'DOWN'].includes(direction)) return res.status(400).json({ error: "Invalid Direction" });
    if (!userPubKey || !isValidSolanaAddress(userPubKey)) return res.status(400).json({ error: "Invalid Wallet" });

    const release = await stateMutex.acquire();
    try {
        const now = Date.now();
        const lastVoteTime = sentimentVotes.get(userPubKey) || 0;
        const COOLDOWN_MS = 60 * 60 * 1000; // 1 Hour

        if (now - lastVoteTime < COOLDOWN_MS) {
            return res.status(429).json({ error: "VOTE_COOLDOWN", nextVote: lastVoteTime + COOLDOWN_MS });
        }

        if (direction === 'UP') gameState.hourlySentiment.up++;
        else gameState.hourlySentiment.down++;
        
        sentimentVotes.set(userPubKey, now);
        
        await saveSystemState();
        updatePublicStateCache(); 
        log(`> [SENTIMENT] Vote: ${direction} from ${userPubKey.slice(0,6)}`, "SENT");
        res.json({ success: true, sentiment: gameState.hourlySentiment });
    } finally { release(); }
});

app.get('/api/admin/logs', (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    res.json({ logs: serverLogs });
});

app.get('/api/admin/payouts', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    let currentQueue = [];
    if (fsSync.existsSync(QUEUE_FILE)) { try { currentQueue = JSON.parse(fsSync.readFileSync(QUEUE_FILE, 'utf8')); } catch(e) {} }
    res.json({ queue: currentQueue, history: payoutHistory });
});

app.get('/api/admin/full-history', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    res.json({ history: historySummary });
});

app.post('/api/verify-bet', betLimiter, async (req, res) => {
    if (!isInitialized) return res.status(503).json({ error: "SERVICE_UNAVAILABLE" });
    if (gameState.isPaused) return res.status(400).json({ error: "MARKET_PAUSED" });
    if (gameState.isResetting) return res.status(503).json({ error: "CALCULATING_RESULTS" });
    if (gameState.isCancelled) return res.status(400).json({ error: "MARKET_CANCELLED" });

    const { signature, direction, userPubKey } = req.body;
    if (!signature || !userPubKey || !isValidSolanaAddress(userPubKey) || !isValidSignature(signature)) return res.status(400).json({ error: "INVALID_DATA_FORMAT" });
    if (processedSignatures.has(signature)) return res.status(400).json({ error: "DUPLICATE_TX_DETECTED" });

    let solAmount = 0;
    let txBlockTime = 0;
    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta.err) return res.status(400).json({ error: "TX_INVALID" });
        txBlockTime = tx.blockTime * 1000;
        let housePubKeyStr = houseKeypair ? houseKeypair.publicKey.toString() : "BXSp5y6Ua6tB5fZDe1EscVaaEaZLg1yqzrsPqAXhKJYy"; 
        const instructions = tx.transaction.message.instructions;
        for (let ix of instructions) {
            if (ix.program === 'system' && ix.parsed.type === 'transfer') {
                if (ix.parsed.info.destination === housePubKeyStr) {
                    solAmount = ix.parsed.info.lamports / 1000000000;
                    break;
                }
            }
        }
        if (solAmount <= 0) return res.status(400).json({ error: "NO_FUNDS" });
    } catch (e) { return res.status(500).json({ error: "CHAIN_ERROR" }); }

    const release = await stateMutex.acquire();
    try {
        if (processedSignatures.has(signature)) return res.status(400).json({ error: "DUPLICATE_TX_DETECTED" });
        if (txBlockTime < gameState.candleStartTime) return res.status(400).json({ error: "TX_TIMESTAMP_EXPIRED" });
        if (gameState.isPaused) return res.status(400).json({ error: "MARKET_PAUSED" });
        if (gameState.isResetting) return res.status(503).json({ error: "CALCULATING_RESULTS" });

        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; 
        if (direction === 'UP') price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        else price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;
        if (!Number.isFinite(sharesReceived) || sharesReceived <= 0) return res.status(500).json({ error: "CALCULATION_ERROR" });

        if (direction === 'UP') gameState.poolShares.up += sharesReceived;
        else gameState.poolShares.down += sharesReceived;

        if (!knownUsers.has(userPubKey)) { knownUsers.add(userPubKey); globalStats.totalLifetimeUsers++; }

        getUser(userPubKey).then(userData => { userData.totalSol += solAmount; saveUser(userPubKey, userData); });

        // Record daily activity for lottery eligibility
        recordUserActivity(userPubKey);

        gameState.bets.push({ signature, user: userPubKey, direction, costSol: solAmount, entryPrice: price, shares: sharesReceived, timestamp: Date.now() });
        gameState.recentTrades.unshift({ user: userPubKey, direction, shares: sharesReceived, time: Date.now() });
        if (gameState.recentTrades.length > 20) gameState.recentTrades.pop();

        globalStats.totalVolume += solAmount;
        processedSignatures.add(signature);
        await fs.appendFile(path.join(DATA_DIR, 'signatures.log'), signature + '\n');
        updatePublicStateCache();
        await saveSystemState();
        log(`> [TRADE] ${userPubKey.slice(0,6)} bought ${sharesReceived.toFixed(2)} ${direction} for ${solAmount} SOL`, "TRADE");
        res.json({ success: true, shares: sharesReceived, price: price });
    } catch (e) { 
        log(`> [ERR] Trade Error: ${e}`, "ERR");
        res.status(500).json({ error: "STATE_ERROR" }); 
    } finally { release(); }
});

app.post('/api/admin/toggle-pause', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    const release = await stateMutex.acquire();
    try {
        gameState.isPaused = !gameState.isPaused;
        if (!gameState.isPaused) gameState.isCancelled = false; 
        await saveSystemState();
        log(`> [ADMIN] Market Paused State toggled to: ${gameState.isPaused}`, "ADMIN");
        res.json({ success: true, isPaused: gameState.isPaused });
    } catch (e) { log(`> [ERR] Admin Pause Error: ${e}`, "ERR"); res.status(500).json({ error: "ADMIN_ERROR" }); } 
    finally { release(); }
});

app.post('/api/admin/cancel-frame', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    const release = await stateMutex.acquire();
    try {
        await cancelCurrentFrameAndRefund();
        log(`> [ADMIN] Frame Cancelled by Admin`, "ADMIN");
        res.json({ success: true, message: "Frame Cancelled. Market Paused." });
    } catch (e) { console.error(e); res.status(500).json({ error: "ADMIN_ERROR" }); }
    finally { release(); }
});

app.post('/api/admin/broadcast', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    const { message, isActive } = req.body;
    const release = await stateMutex.acquire();
    try {
        gameState.broadcast = { message: message || "", isActive: !!isActive };
        await saveSystemState();
        updatePublicStateCache();
        log(`> [ADMIN] Broadcast updated: "${message}" (Active: ${isActive})`, "ADMIN");
        res.json({ success: true, broadcast: gameState.broadcast });
    } catch (e) { log(`> [ERR] Admin Broadcast Error: ${e}`, "ERR"); res.status(500).json({ error: "ADMIN_ERROR" }); }
    finally { release(); }
});

// --- LOTTERY ENDPOINTS ---
app.get('/api/lottery/status', stateLimiter, async (req, res) => {
    try {
        const supply = await getCirculatingSupply();
        const threshold = supply * LOTTERY_CONFIG.ELIGIBILITY_PERCENT;

        res.json({
            currentRound: lotteryState.currentRound,
            nextDrawTime: lotteryState.nextDrawTime,
            msUntilDraw: Math.max(0, lotteryState.nextDrawTime - Date.now()),
            lastDrawTime: lotteryState.lastDrawTime,
            eligibilityThreshold: threshold,
            circulatingSupply: supply,
            config: {
                eligibilityPercent: LOTTERY_CONFIG.ELIGIBILITY_PERCENT * 100,
                maxTickets: LOTTERY_CONFIG.MAX_TICKETS,
                basePrize: LOTTERY_CONFIG.BASE_PRIZE,
                prizePerTicket: LOTTERY_CONFIG.PRIZE_PER_TICKET
            },
            recentWinner: lotteryHistory.draws.length > 0 ? {
                winner: lotteryHistory.draws[0].winner,
                prize: lotteryHistory.draws[0].prize,
                round: lotteryHistory.draws[0].round,
                timestamp: lotteryHistory.draws[0].timestamp
            } : null
        });
    } catch (e) {
        console.error("> [LOTTERY] Status error:", e.message);
        res.status(500).json({ error: "LOTTERY_STATUS_ERROR" });
    }
});

app.get('/api/lottery/eligibility', stateLimiter, async (req, res) => {
    const userKey = req.query.user;

    if (!userKey || !isValidSolanaAddress(userKey)) {
        return res.status(400).json({ error: "INVALID_USER_ADDRESS" });
    }

    try {
        const userData = await updateUserLotteryStatus(userKey);
        const tickets = calculateTickets(userData);

        const supply = await getCirculatingSupply();
        const threshold = supply * LOTTERY_CONFIG.ELIGIBILITY_PERCENT;

        res.json({
            isEligible: userData.lottery?.isEligible || false,
            balance: userData.lottery?.currentBalance || 0,
            threshold: threshold,
            tickets: tickets.effective,
            baseTickets: tickets.base,
            activityMultiplier: tickets.multiplier,
            activeDays: tickets.activeDays,
            activityWindowDays: LOTTERY_CONFIG.ACTIVITY_WINDOW_DAYS,
            maxTickets: LOTTERY_CONFIG.MAX_TICKETS,
            weeksHolding: userData.lottery?.weeksHolding || 0,
            firstSeenHolding: userData.lottery?.firstSeenHolding,
            wins: userData.lottery?.wins || [],
            participatedRounds: userData.lottery?.participatedRounds || []
        });
    } catch (e) {
        console.error(`> [LOTTERY] Eligibility error for ${userKey}:`, e.message);
        res.status(500).json({ error: "ELIGIBILITY_CHECK_ERROR" });
    }
});

app.get('/api/lottery/history', stateLimiter, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 10, 52);

    res.json({
        draws: lotteryHistory.draws.slice(0, limit),
        totalDraws: lotteryHistory.draws.length
    });
});

app.post('/api/admin/lottery/draw', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) {
        return res.status(403).json({ error: "UNAUTHORIZED" });
    }

    try {
        console.log("> [ADMIN] Manual lottery draw triggered");
        const result = await executeLotteryDraw();
        res.json(result);
    } catch (e) {
        console.error("> [ADMIN] Lottery draw error:", e.message);
        res.status(500).json({ error: "DRAW_ERROR", message: e.message });
    }
});

// --- LOTTERY SCHEDULED TASK ---
// Check every hour if it's time for a draw
setInterval(checkLotterySchedule, 60 * 60 * 1000);
// Also check on startup after a short delay
setTimeout(checkLotterySchedule, 10000);

app.listen(PORT, () => { console.log(`> ASDForecast Engine v${BACKEND_VERSION} running on ${PORT}`); });
