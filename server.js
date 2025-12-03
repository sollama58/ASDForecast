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

// Enable trust proxy if behind a load balancer (like Render) to get real IPs for rate limiting
app.set('trust proxy', 1);

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- MAINNET CONFIGURATION ---
const SOLANA_NETWORK = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const FEE_WALLET = new PublicKey("5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan");
const UPKEEP_WALLET = new PublicKey("BH8aAiEDgZGJo6pjh32d5b6KyrNt6zA9U8WTLZShmVXq");

// --- ORACLE CONFIG ---
const PYTH_HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";
const SOL_FEED_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || ""; 

// --- CONFIG ---
const ASDF_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";
const PRICE_SCALE = 0.1;
const PAYOUT_MULTIPLIER = 0.94;
const FEE_PERCENT = 0.0552; 
const UPKEEP_PERCENT = 0.0048; // 0.48%
const FRAME_DURATION = 15 * 60 * 1000; 
const BACKEND_VERSION = "116.0"; // UPDATE: Scalability Guards

const PRIORITY_FEE_UNITS = 50000; 

// --- RATE LIMITING ---
// 1. Critical Write Limiter (Bets) - Strict
const betLimiter = rateLimit({
	windowMs: 1 * 60 * 1000, 
	max: 10, 
    message: { error: "RATE_LIMIT_EXCEEDED" },
	standardHeaders: true,
	legacyHeaders: false,
});

// 2. Read Limiter (State) - Generous but protective
// Allows ~2 requests per second burst, or consistent polling every 2s
const stateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 120, // 120 requests per minute per IP
    message: { error: "POLLING_LIMIT_EXCEEDED" },
    standardHeaders: true,
    legacyHeaders: false,
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

console.log(`> [SYS] Persistence Root: ${DATA_DIR}`);
if (!process.env.HELIUS_API_KEY) console.warn("⚠️ [WARN] HELIUS_API_KEY is missing! RPC calls may fail.");

async function atomicWrite(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try {
        await fs.writeFile(tempPath, JSON.stringify(data));
        await fs.rename(tempPath, filePath); 
    } catch (e) {
        console.error(`> [IO] Write Error on ${filePath}:`, e.message);
    }
}

// --- IMAGE CACHING ---
let cachedShareImage = null;
async function initShareImage() {
    const src = process.env.BASE_IMAGE_SRC;
    if (!src) {
        console.log("> [SYS] No BASE_IMAGE_SRC env variable found.");
        return;
    }
    if (src.startsWith('http')) {
        try {
            console.log("> [SYS] Fetching and caching share image...");
            const response = await axios.get(src, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data, 'binary');
            const type = response.headers['content-type'];
            cachedShareImage = `data:${type};base64,${buffer.toString('base64')}`;
            console.log("> [SYS] Share image cached successfully.");
        } catch (e) {
            console.error("> [ERR] Failed to cache share image:", e.message);
        }
    } else {
        cachedShareImage = src;
    }
}
initShareImage();

let houseKeypair;
try {
    if (process.env.SOLANA_WALLET_JSON) {
        houseKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_WALLET_JSON)));
        console.log(`> [AUTH] Wallet Loaded (ENV): ${houseKeypair.publicKey.toString()}`);
    } else if (fsSync.existsSync('house-wallet.json')) {
        houseKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fsSync.readFileSync('house-wallet.json'))));
        console.log(`> [AUTH] Wallet Loaded (File): ${houseKeypair.publicKey.toString()}`);
    } else {
        console.warn("> [WARN] NO PRIVATE KEY. Payouts Disabled.");
    }
} catch (e) { console.error("> [ERR] Wallet Load Failed:", e.message); }

// --- STATE ---
let gameState = {
    price: 0,
    lastPriceTimestamp: 0, 
    candleOpen: 0,
    candleStartTime: 0,
    poolShares: { up: 50, down: 50 },
    bets: [],
    recentTrades: [],
    sharePriceHistory: [],
    isPaused: false,
    isResetting: false,
    isCancelled: false
};
let historySummary = [];
let globalStats = { totalVolume: 0, totalFees: 0, totalASDF: 0, lastASDFSignature: null };
let processedSignatures = new Set(); 
let globalLeaderboard = [];

function loadGlobalState() {
    try {
        if (fsSync.existsSync(HISTORY_FILE)) historySummary = JSON.parse(fsSync.readFileSync(HISTORY_FILE));
        if (fsSync.existsSync(STATS_FILE)) {
            const loaded = JSON.parse(fsSync.readFileSync(STATS_FILE));
            globalStats = { ...globalStats, ...loaded };
        }
        if (fsSync.existsSync(SIGS_FILE)) {
            const fileContent = fsSync.readFileSync(SIGS_FILE, 'utf-8');
            const lines = fileContent.split('\n');
            // SCALABILITY: Limit loaded signatures to avoid memory bloat
            lines.slice(-5000).forEach(line => { if(line.trim()) processedSignatures.add(line.trim()); });
        }
        if (fsSync.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fsSync.readFileSync(STATE_FILE));
            gameState = { ...gameState, ...savedState };
            gameState.isResetting = false; 
            
            if (gameState.candleStartTime > 0) {
                const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
                if (fsSync.existsSync(currentFrameFile)) {
                    const frameData = JSON.parse(fsSync.readFileSync(currentFrameFile));
                    gameState.bets = frameData.bets || [];
                }
            }
        }
    } catch (e) { console.error("> [ERR] Load Error:", e); }
}

async function saveSystemState() {
    await atomicWrite(STATE_FILE, {
        candleOpen: gameState.candleOpen,
        candleStartTime: gameState.candleStartTime,
        poolShares: gameState.poolShares,
        recentTrades: gameState.recentTrades,
        sharePriceHistory: gameState.sharePriceHistory,
        isPaused: gameState.isPaused,
        isResetting: gameState.isResetting,
        isCancelled: gameState.isCancelled,
        lastPriceTimestamp: gameState.lastPriceTimestamp
    });
    await atomicWrite(STATS_FILE, globalStats);

    if (gameState.candleStartTime > 0) {
        const frameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
        const status = gameState.isCancelled ? 'CANCELLED' : (gameState.isPaused ? 'PAUSED' : (gameState.isResetting ? 'RESETTING' : 'ACTIVE'));
        await atomicWrite(frameFile, {
            id: gameState.candleStartTime,
            startTime: gameState.candleStartTime,
            endTime: gameState.candleStartTime + FRAME_DURATION,
            open: gameState.candleOpen,
            poolShares: gameState.poolShares,
            bets: [...gameState.bets],
            status: status
        });
    }
}

async function getUser(pubKey) {
    const file = path.join(USERS_DIR, `user_${pubKey}.json`);
    try {
        const data = await fs.readFile(file, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0, frameLog: {} };
    }
}

async function saveUser(pubKey, data) {
    try {
        const file = path.join(USERS_DIR, `user_${pubKey}.json`);
        await atomicWrite(file, data);
    } catch (e) {}
}

loadGlobalState();

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
        if (newPurchasedAmount > 0) globalStats.totalASDF += newPurchasedAmount;
    } catch (e) { console.error("> [ASDF] History Check Failed:", e.message); }
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
                if (data.frameLog) {
                    Object.values(data.frameLog).forEach(log => { if (log.payoutAmount) totalWon += log.payoutAmount; });
                }
                const totalGames = data.wins + data.losses;
                if (totalGames > 0) {
                     leaders.push({ pubKey: file.replace('user_', '').replace('.json', ''), wins: data.wins, bets: totalGames, winRate: (data.wins / totalGames) * 100, totalWon: totalWon });
                }
            } catch(e) {}
        }
        leaders.sort((a, b) => b.totalWon - a.totalWon);
        globalLeaderboard = leaders.slice(0, 5); 
    } catch (e) { console.error("Leaderboard Error:", e.message); }
}
setInterval(updateLeaderboard, 60000); 
updateLeaderboard(); 

function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

async function processPayoutQueue() {
    const release = await payoutMutex.acquire();
    try {
        if (!houseKeypair || !fsSync.existsSync(QUEUE_FILE)) return;
        let queueData = [];
        try { queueData = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch(e) { queueData = []; }
        if (!queueData || queueData.length === 0) return;

        console.log(`> [QUEUE] Processing ${queueData.length} batches...`);
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        
        while (queueData.length > 0) {
            const batch = queueData[0];
            const { type, recipients, frameId } = batch;
            try {
                const tx = new Transaction();
                const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_UNITS });
                tx.add(priorityFeeIx);
                let hasInstructions = false;
                const validRecipients = [];
                
                if (type === 'USER_PAYOUT' || type === 'USER_REFUND') {
                    for (const item of recipients) {
                        const uData = await getUser(item.pubKey);
                        if (uData.frameLog && uData.frameLog[frameId]) {
                            const entry = uData.frameLog[frameId];
                            if (type === 'USER_PAYOUT' && entry.payoutTx) continue;
                            if (type === 'USER_REFUND' && entry.refundTx) continue;
                        }
                        validRecipients.push(item);
                    }
                } else {
                     recipients.forEach(r => validRecipients.push(r));
                }

                if (validRecipients.length > 0) {
                    for (const item of validRecipients) {
                        tx.add(SystemProgram.transfer({
                            fromPubkey: houseKeypair.publicKey,
                            toPubkey: new PublicKey(item.pubKey),
                            lamports: item.amount
                        }));
                        hasInstructions = true;
                    }

                    if (hasInstructions) {
                        const sig = await sendAndConfirmTransaction(connection, tx, [houseKeypair], { commitment: 'confirmed', maxRetries: 5 });
                        console.log(`> [QUEUE] Batch Sent: ${sig}`);

                        if (type === 'USER_PAYOUT') {
                            for (const item of validRecipients) {
                                const uData = await getUser(item.pubKey);
                                if (uData.frameLog && uData.frameLog[frameId]) {
                                    uData.frameLog[frameId].payoutTx = sig;
                                    uData.frameLog[frameId].payoutAmount = item.amount / 1e9;
                                    await saveUser(item.pubKey, uData);
                                }
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
            } catch (e) { console.error(`> [QUEUE] Batch Failed: ${e.message}`); }
            queueData.shift();
            await atomicWrite(QUEUE_FILE, queueData);
        }
    } catch (e) { console.error("> [QUEUE] Error:", e); }
    finally { release(); }
}

async function queuePayouts(frameId, result, bets, totalVolume) {
    if (totalVolume === 0) return;
    const queue = []; 

    if (result === "FLAT") {
        const burnLamports = Math.floor((totalVolume * 0.99) * 1e9);
        if (burnLamports > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: FEE_WALLET.toString(), amount: burnLamports }] });
    } else {
        const feeLamports = Math.floor((totalVolume * FEE_PERCENT) * 1e9); 
        const upkeepLamports = Math.floor((totalVolume * UPKEEP_PERCENT) * 1e9); 
        
        if (feeLamports > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: FEE_WALLET.toString(), amount: feeLamports }] });
        if (upkeepLamports > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: UPKEEP_WALLET.toString(), amount: upkeepLamports }] });
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
                if (batchRecipients.length > 0) queue.push({ type: 'USER_PAYOUT', frameId: frameId, recipients: batchRecipients });
            }
        }
    }

    let existingQueue = [];
    try { if (fsSync.existsSync(QUEUE_FILE)) existingQueue = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch(e) {}
    const newQueue = existingQueue.concat(queue);
    await atomicWrite(QUEUE_FILE, newQueue);
    processPayoutQueue();
}

async function processRefunds(frameId, bets) {
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
    if (totalFee > 0) queue.push({ type: 'FEE', recipients: [{ pubKey: FEE_WALLET.toString(), amount: Math.floor(totalFee) }] });
    const recipients = Object.entries(refunds).map(([pub, amt]) => ({ pubKey: pub, amount: amt }));
    const BATCH_SIZE = 12;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        queue.push({ type: 'USER_REFUND', frameId: frameId, recipients: batch }); 
    }
    let existingQueue = [];
    try { if (fsSync.existsSync(QUEUE_FILE)) existingQueue = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch(e) {}
    const newQueue = existingQueue.concat(queue);
    await atomicWrite(QUEUE_FILE, newQueue);
    processPayoutQueue();
}

// --- SHARED CANCELLATION LOGIC ---
async function cancelCurrentFrameAndRefund() {
    gameState.isPaused = true;
    gameState.isCancelled = true;
    
    if (gameState.bets.length > 0) {
        console.log(`> [CANCEL] Performing Cancellation & Refund for frame ${gameState.candleStartTime}...`);
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
    const release = await stateMutex.acquire(); 
    try {
        const frameId = gameState.candleStartTime; 
        console.log(`> [SYS] Closing Frame: ${frameId}`);

        await updateASDFPurchases();

        const openPrice = gameState.candleOpen;
        let result = "FLAT";
        if (closePrice > openPrice) result = "UP";
        else if (closePrice < openPrice) result = "DOWN";

        const realSharesUp = Math.max(0, gameState.poolShares.up - 50);
        const realSharesDown = Math.max(0, gameState.poolShares.down - 50);
        const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

        let frameFees = (result === "FLAT") ? frameSol * 0.99 : frameSol * FEE_PERCENT;
        globalStats.totalFees += frameFees;

        let winnerCount = 0;
        let payoutTotal = 0;
        if (result !== "FLAT") {
            const potSol = frameSol * 0.94;
            const userPositions = {};
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
            if (winnerCount > 0) payoutTotal = potSol;
        }

        const frameRecord = {
            id: frameId, startTime: frameId, endTime: frameId + FRAME_DURATION,
            time: new Date(frameId).toISOString(), open: openPrice, close: closePrice,
            result: result, sharesUp: realSharesUp, sharesDown: realSharesDown,
            totalSol: frameSol, winners: winnerCount, payout: payoutTotal
        };
        
        historySummary.unshift(frameRecord);
        if (historySummary.length > 100) historySummary = historySummary.slice(0, 100);
        await atomicWrite(HISTORY_FILE, historySummary);

        const betsSnapshot = [...gameState.bets];
        const userPositions = {};
        betsSnapshot.forEach(bet => {
            if (!userPositions[bet.user]) userPositions[bet.user] = { up: 0, down: 0, sol: 0 };
            if (bet.direction === 'UP') userPositions[bet.user].up += bet.shares;
            else userPositions[bet.user].down += bet.shares;
            userPositions[bet.user].sol += bet.costSol;
        });

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

        // SCALABILITY FIX: Memory Cleanup
        processedSignatures.clear();
        await fs.writeFile(SIGS_FILE, '');

        await queuePayouts(frameId, result, betsSnapshot, frameSol);

        gameState.candleStartTime = closeTime;
        gameState.candleOpen = closePrice;
        gameState.poolShares = { up: 50, down: 50 }; 
        gameState.bets = []; 
        gameState.sharePriceHistory = [];
        gameState.isResetting = false; 
        await saveSystemState();
        
    } finally { release(); }
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
    } catch (e) { console.log(`Pyth Failed: ${e.message}`); }

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
        } catch (e) { console.log(`CoinGecko Failed: ${e.message}`); }
    }

    if (priceFound) {
        await stateMutex.runExclusive(async () => {
            gameState.price = fetchedPrice;
            gameState.lastPriceTimestamp = Date.now();
            const currentWindowStart = getCurrentWindowStart();

            if (gameState.isResetting) return;
            
            if (gameState.isPaused) {
                const timeRemaining = (gameState.candleStartTime + FRAME_DURATION) - Date.now();
                if (!gameState.isCancelled && timeRemaining < 300000 && timeRemaining > 0) {
                    console.log("⚠️ Auto-cancelling due to prolonged pause...");
                    await cancelCurrentFrameAndRefund(); 
                    return;
                }
                if (currentWindowStart > gameState.candleStartTime) {
                    console.log("> [SYS] Unpausing for new Frame.");
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
                    gameState.isResetting = true; 
                    await saveSystemState();
                    closeFrame(fetchedPrice, currentWindowStart);
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
processPayoutQueue();

// --- ENDPOINTS ---
// UPDATE: Added stateLimiter to protect against DDoS
app.get('/api/state', stateLimiter, async (req, res) => {
    const now = new Date();
    const nextWindowStart = getCurrentWindowStart() + FRAME_DURATION;
    const msUntilClose = nextWindowStart - now.getTime();
    const priceChange = gameState.price - gameState.candleOpen;
    const percentChange = gameState.candleOpen ? (priceChange / gameState.candleOpen) * 100 : 0;
    const currentVolume = gameState.bets.reduce((acc, b) => acc + b.costSol, 0);

    const totalShares = gameState.poolShares.up + gameState.poolShares.down;
    const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
    const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;

    const nowTime = Date.now();
    const history = gameState.sharePriceHistory || [];
    const baseline = { up: 0.05, down: 0.05 };
    const oneMinAgo = history.find(x => x.t >= nowTime - 60000) || baseline;
    const fiveMinAgo = history.find(x => x.t >= nowTime - 300000) || baseline;
    function getPercentChange(current, old) { if (!old || old === 0) return 0; return ((current - old) / old) * 100; }
    const changes = {
        up1m: getPercentChange(priceUp, oneMinAgo.up),
        up5m: getPercentChange(priceUp, fiveMinAgo.up),
        down1m: getPercentChange(priceDown, oneMinAgo.down),
        down5m: getPercentChange(priceDown, fiveMinAgo.down),
    };
    const uniqueUsers = new Set(gameState.bets.map(b => b.user)).size;
    
    const userKey = req.query.user;
    let myStats = null;
    let activePosition = null;
    if (userKey) {
        myStats = await getUser(userKey);
        const userBets = gameState.bets.filter(b => b.user === userKey);
        activePosition = {
            upShares: userBets.filter(b => b.direction === 'UP').reduce((a, b) => a + b.shares, 0),
            downShares: userBets.filter(b => b.direction === 'DOWN').reduce((a, b) => a + b.shares, 0),
            upSol: userBets.filter(b => b.direction === 'UP').reduce((a, b) => a + b.costSol, 0),
            downSol: userBets.filter(b => b.direction === 'DOWN').reduce((a, b) => a + b.costSol, 0),
            wageredSol: userBets.reduce((a, b) => a + b.costSol, 0)
        };
    }
    res.json({
        price: gameState.price, openPrice: gameState.candleOpen, candleStartTime: gameState.candleStartTime, candleEndTime: gameState.candleStartTime + FRAME_DURATION,
        change: percentChange, msUntilClose: msUntilClose, currentVolume: currentVolume, uniqueUsers: uniqueUsers,
        platformStats: globalStats, isPaused: gameState.isPaused, isResetting: gameState.isResetting, isCancelled: gameState.isCancelled,
        market: { priceUp, priceDown, sharesUp: gameState.poolShares.up, sharesDown: gameState.poolShares.down, changes: changes },
        history: historySummary, recentTrades: gameState.recentTrades, userStats: myStats, activePosition: activePosition,
        leaderboard: globalLeaderboard, lastPriceTimestamp: gameState.lastPriceTimestamp,
        backendVersion: BACKEND_VERSION
    });
});

app.get('/api/share-image', (req, res) => {
    res.json({ image: cachedShareImage });
});

app.post('/api/verify-bet', betLimiter, async (req, res) => {
    if (gameState.isPaused) return res.status(400).json({ error: "MARKET_PAUSED" });
    if (gameState.isResetting) return res.status(503).json({ error: "CALCULATING_RESULTS" });
    if (gameState.isCancelled) return res.status(400).json({ error: "MARKET_CANCELLED" });

    const { signature, direction, userPubKey } = req.body;
    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_DATA" });
    
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
        
        if (!Number.isFinite(sharesReceived) || sharesReceived <= 0) {
             return res.status(500).json({ error: "CALCULATION_ERROR" });
        }

        if (direction === 'UP') gameState.poolShares.up += sharesReceived;
        else gameState.poolShares.down += sharesReceived;

        getUser(userPubKey).then(userData => {
            userData.totalSol += solAmount;
            saveUser(userPubKey, userData);
        });

        gameState.bets.push({ signature, user: userPubKey, direction, costSol: solAmount, entryPrice: price, shares: sharesReceived, timestamp: Date.now() });
        gameState.recentTrades.unshift({ user: userPubKey, direction, shares: sharesReceived, time: Date.now() });
        if (gameState.recentTrades.length > 20) gameState.recentTrades.pop();

        globalStats.totalVolume += solAmount;
        processedSignatures.add(signature);
        await fs.appendFile(path.join(DATA_DIR, 'signatures.log'), signature + '\n');

        await saveSystemState();
        res.json({ success: true, shares: sharesReceived, price: price });

    } catch (e) { console.error(e); res.status(500).json({ error: "STATE_ERROR" }); } finally { release(); }
});

app.post('/api/admin/toggle-pause', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });

    const release = await stateMutex.acquire();
    try {
        gameState.isPaused = !gameState.isPaused;
        if (!gameState.isPaused) gameState.isCancelled = false; 
        await saveSystemState();
        console.log(`> [ADMIN] Market Paused State toggled to: ${gameState.isPaused}`);
        res.json({ success: true, isPaused: gameState.isPaused });
    } catch (e) { console.error(e); res.status(500).json({ error: "ADMIN_ERROR" }); } 
    finally { release(); }
});

app.post('/api/admin/cancel-frame', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== process.env.ADMIN_ACTION_PASSWORD) return res.status(403).json({ error: "UNAUTHORIZED" });
    const release = await stateMutex.acquire();
    try {
        await cancelCurrentFrameAndRefund();
        res.json({ success: true, message: "Frame Cancelled. Market Paused." });
    } catch (e) { console.error(e); res.status(500).json({ error: "ADMIN_ERROR" }); } 
    finally { release(); }
});

app.listen(PORT, () => { console.log(`> ASDForecast Engine v${BACKEND_VERSION} running on ${PORT}`); });
