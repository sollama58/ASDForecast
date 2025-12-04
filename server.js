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
const BACKEND_VERSION = "141.1"; // HOTFIX: feeAmt ReferenceError
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
let payoutHistory = [];
let cachedPublicState = null;
let sentimentVotes = new Map(); 

function getNextHourTimestamp() {
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    return now.getTime();
}

// --- UTILITY FUNCTION ---
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
        
        if (fsSync.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fsSync.readFileSync(STATE_FILE));
            gameState = { ...gameState, ...savedState };
            gameState.isResetting = false; 
            if (!gameState.broadcast) gameState.broadcast = { message: "", isActive: false };
            if (!gameState.vaultStartBalance) gameState.vaultStartBalance = 0; 
            
            if (!gameState.hourlySentiment || !gameState.hourlySentiment.nextReset) {
                gameState.hourlySentiment = { up: 0, down: 0, nextReset: getNextHourTimestamp() };
            }
            
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

        // BUGFIX: Declare feeAmt and upkeepAmt at top level with defaults
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
            // These are now guaranteed to be defined
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

// ... (updatePrice and endpoints UNCHANGED, omitting for brevity) ...
