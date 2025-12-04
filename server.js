const express = require('express');
const cors = require('cors');
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
const UPKEEP_PERCENT = 0.0048; 
const FRAME_DURATION = 15 * 60 * 1000; 
const BACKEND_VERSION = "131.0"; // UPDATE: Initialization Guard & Cache Safety Fix
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
    windowMs: 15 * 1000, 
    max: 1, 
    message: { error: "COOLDOWN_ACTIVE" }, 
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
const PAYOUT_HISTORY_FILE = path.join(DATA_DIR, 'payout_history.json');
const PAYOUT_MASTER_LOG = path.join(DATA_DIR, 'payout_master.log');
const FAILED_REFUNDS_FILE = path.join(DATA_DIR, 'failed_refunds.json');

log(`> [SYS] Persistence Root: ${DATA_DIR}`);

async function atomicWrite(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try { await fs.writeFile(tempPath, JSON.stringify(data)); await fs.rename(tempPath, filePath); } 
    catch (e) { log(`> [IO] Write Error on ${filePath}: ${e.message}`, "ERR"); }
}

// --- IMAGES ---
let cachedShareImage = null, cachedItsFineImage = null, cachedItsOverImage = null;
let cachedSentUpImage = null, cachedSentDownImage = null;
let isInitialized = false; // Initialization status flag

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
let payoutHistory = [];
let cachedPublicState = null;


function getNextHourTimestamp() {
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    return now.getTime();
}

async function loadAndInit() {
    await initImages(); // Wait for images
    await loadGlobalState(); // Load file data
    await updatePrice(); // Initial price fetch & state machine start
    updatePublicStateCache(); // Initial cache generation

    // Set initialization flag after all steps complete
    isInitialized = true;
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
        
        if (fsSync.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fsSync.readFileSync(STATE_FILE));
            gameState = { ...gameState, ...savedState };
            gameState.isResetting = false; 
            if (!gameState.broadcast) gameState.broadcast = { message: "", isActive: false };
            if (!gameState.vaultStartBalance) gameState.vaultStartBalance = 0; 
            if (!gameState.hourlySentiment) gameState.hourlySentiment = { up: 0, down: 0, nextReset: getNextHourTimestamp() };
            
            if (gameState.candleStartTime > 0) {
                const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
                if (fsSync.existsSync(currentFrameFile)) {
                    const frameData = JSON.parse(fsSync.readFileSync(currentFrameFile));
                    gameState.bets = frameData.bets || [];
                }
            }
        } else {
            gameState.hourlySentiment = { up: 0, down: 0, nextReset: getNextHourTimestamp() };
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
    } catch (e) { log(`> [ERR] Load Error: ${e}`, "ERR"); }
}

async function saveSystemState() {
    await atomicWrite(STATE_FILE, {
        candleOpen: gameState.candleOpen, candleStartTime: gameState.candleStartTime, poolShares: gameState.poolShares, recentTrades: gameState.recentTrades,
        sharePriceHistory: gameState.sharePriceHistory, isPaused: gameState.isPaused, isResetting: gameState.isResetting, isCancelled: gameState.isCancelled,
        lastPriceTimestamp: gameState.lastPriceTimestamp, broadcast: gameState.broadcast, vaultStartBalance: gameState.vaultStartBalance, hourlySentiment: gameState.hourlySentiment
    });
    await atomicWrite(STATS_FILE, globalStats);
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

loadAndInit(); // Execute initialization immediately

// ... (Rest of logic omitted for brevity, assuming v129 logic) ...

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

            // HOURLY SENTIMENT RESET LOGIC
            if (Date.now() >= gameState.hourlySentiment.nextReset) {
                log("> [SENTIMENT] Hourly reset triggered.");
                gameState.hourlySentiment.up = 0;
                gameState.hourlySentiment.down = 0;
                gameState.hourlySentiment.nextReset = getNextHourTimestamp();
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
    if (!isInitialized) return; // Only cache when initialization is complete
    
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
        broadcast: gameState.broadcast,
        market: { priceUp, priceDown, sharesUp: gameState.poolShares.up, sharesDown: gameState.poolShares.down, changes },
        history: historySummary,
        recentTrades: gameState.recentTrades,
        leaderboard: globalLeaderboard,
        lastPriceTimestamp: gameState.lastPriceTimestamp,
        backendVersion: BACKEND_VERSION,
        payoutQueueLength: currentQueueLength,
        lastFramePot: lastFramePot,
        totalLifetimeUsers: globalStats.totalLifetimeUsers,
        totalWinnings: globalStats.totalWinnings,
        hourlySentiment: gameState.hourlySentiment // NEW
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

// IMAGE ENDPOINTS - Serve cached data
app.get('/api/image/fine', (req, res) => { res.json({ image: cachedItsFineImage }); });
app.get('/api/image/over', (req, res) => { res.json({ image: cachedItsOverImage }); });
app.get('/api/image/share-image', (req, res) => { res.json({ image: cachedShareImage }); });
app.get('/api/image/sentiment-up', (req, res) => { res.json({ image: cachedSentUpImage }); });
app.get('/api/image/sentiment-down', (req, res) => { res.json({ image: cachedSentDownImage }); });

// NEW VOTE ENDPOINT
app.post('/api/sentiment/vote', voteLimiter, async (req, res) => {
    const { direction } = req.body;
    if (!['UP', 'DOWN'].includes(direction)) return res.status(400).json({ error: "Invalid Direction" });

    const release = await stateMutex.acquire();
    try {
        if (direction === 'UP') gameState.hourlySentiment.up++;
        else gameState.hourlySentiment.down++;
        
        await saveSystemState();
        updatePublicStateCache(); 
        log(`> [SENTIMENT] Received vote: ${direction}`, "SENT");
        res.json({ success: true, sentiment: gameState.hourlySentiment });
    } finally {
        release();
    }
});

// ... (Other admin endpoints unchanged) ...

app.listen(PORT, () => { log(`> ASDForecast Engine v${BACKEND_VERSION} running on ${PORT}`, "SYS"); loadAndInit(); });
