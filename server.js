const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs').promises; 
const fsSync = require('fs');      
const path = require('path');
const { Mutex } = require('async-mutex');

const app = express();
const stateMutex = new Mutex();

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
const FEE_WALLET = new PublicKey("5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan");
const UPKEEP_WALLET = new PublicKey("BH8aAiEDgZGJo6pjh32d5b6KyrNt6zA9U8WTLZShmVXq");

// --- SECURITY: ADMIN PASSWORD ---
// Must be set in Render Environment Variables
const ADMIN_SECRET = process.env.ADMIN_ACTION_PASSWORD; 

if (!ADMIN_SECRET) {
    console.warn("⚠️ [SEC] WARNING: ADMIN_ACTION_PASSWORD is not set. Admin functions will fail.");
}

// --- CONFIG ---
const ASDF_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com/?api-key=f171f1e4-6e9a-4295-b4d6-a7b43a968c6a";
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const PRICE_SCALE = 0.1;
const PAYOUT_MULTIPLIER = 0.94;
const FEE_PERCENT = 0.0552; 
const RESERVE_SOL = 0.02;
const SWEEP_TARGET = 0.05;
const FRAME_DURATION = 15 * 60 * 1000; 

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

console.log(`> [SYS] Persistence Root: ${DATA_DIR}`);

// --- KEY MANAGEMENT ---
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
    candleOpen: 0,
    candleStartTime: 0,
    poolShares: { up: 50, down: 50 },
    bets: [],
    recentTrades: [],
    sharePriceHistory: [],
    isPaused: false
};
let historySummary = [];
let globalStats = { totalVolume: 0, totalFees: 0, totalASDF: 0, lastASDFSignature: null };
let processedSignatures = new Set(); 

// --- I/O ---
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
            lines.forEach(line => {
                if(line.trim()) processedSignatures.add(line.trim());
            });
        }

        if (fsSync.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fsSync.readFileSync(STATE_FILE));
            gameState.candleOpen = savedState.candleOpen || 0;
            gameState.candleStartTime = savedState.candleStartTime || 0;
            gameState.poolShares = savedState.poolShares || { up: 50, down: 50 };
            gameState.recentTrades = savedState.recentTrades || [];
            gameState.sharePriceHistory = savedState.sharePriceHistory || [];
            gameState.isPaused = savedState.isPaused || false;
            
            const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            if (fsSync.existsSync(currentFrameFile)) {
                const frameData = JSON.parse(fsSync.readFileSync(currentFrameFile));
                gameState.bets = frameData.bets || [];
            }
        }
    } catch (e) { console.error("> [ERR] Load Error:", e); }
}

async function saveSystemState() {
    try {
        await fs.writeFile(STATE_FILE, JSON.stringify({
            candleOpen: gameState.candleOpen,
            candleStartTime: gameState.candleStartTime,
            poolShares: gameState.poolShares,
            recentTrades: gameState.recentTrades,
            sharePriceHistory: gameState.sharePriceHistory,
            isPaused: gameState.isPaused
        }));
        await fs.writeFile(STATS_FILE, JSON.stringify(globalStats));
        if (gameState.candleStartTime > 0) {
            const frameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            await fs.writeFile(frameFile, JSON.stringify({
                id: gameState.candleStartTime,
                startTime: gameState.candleStartTime,
                endTime: gameState.candleStartTime + FRAME_DURATION,
                open: gameState.candleOpen,
                poolShares: gameState.poolShares,
                bets: [...gameState.bets],
                status: gameState.isPaused ? 'CANCELLED' : 'ACTIVE'
            }));
        }
    } catch (e) { console.error("> [ERR] Save Error:", e); }
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
        await fs.writeFile(path.join(USERS_DIR, `user_${pubKey}.json`), JSON.stringify(data));
    } catch (e) {}
}

loadGlobalState();

async function updateASDFPurchases() {
    const connection = new Connection(HELIUS_MAINNET_URL); 
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

function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

// --- REFUND ENGINE (FOR CANCELLATION) ---
async function processRefunds(bets) {
    if (!houseKeypair || bets.length === 0) return;
    const connection = new Connection(SOLANA_NETWORK, 'confirmed');
    console.log(`> [REFUND] Processing ${bets.length} refunds...`);

    const refunds = {};
    let totalFee = 0;

    bets.forEach(bet => {
        if (!refunds[bet.user]) refunds[bet.user] = 0;
        const refundAmt = Math.floor(bet.costSol * 0.99 * 1e9); // Calculate in Lamports
        refunds[bet.user] += refundAmt;
        totalFee += (bet.costSol * 0.01 * 1e9);
    });

    // 1. Send Fee
    if (totalFee > 0) {
        try {
            const feeTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: FEE_WALLET, lamports: Math.floor(totalFee) }));
            await sendAndConfirmTransaction(connection, feeTx, [houseKeypair]);
        } catch(e) { console.error("> [REFUND] Fee Fail", e); }
    }

    // 2. Send Refunds
    const recipients = Object.entries(refunds).map(([pub, amt]) => ({ pubKey: pub, amount: amt }));
    const BATCH_SIZE = 15;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        const tx = new Transaction();
        let hasInstructions = false;
        
        batch.forEach(r => {
            if (r.amount > 5000) { // Dust check
                tx.add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: new PublicKey(r.pubKey), lamports: r.amount }));
                hasInstructions = true;
            }
        });

        if (hasInstructions) {
            try {
                const sig = await sendAndConfirmTransaction(connection, tx, [houseKeypair], { commitment: 'confirmed' });
                console.log(`> [REFUND] Batch Sent: ${sig}`);
            } catch (e) {
                console.error(`> [REFUND] Batch Failed: ${e.message}`);
            }
        }
    }
}

// --- PAYOUT ENGINE ---
async function processPayouts(frameId, result, bets, totalVolume) {
    if (!houseKeypair || totalVolume === 0) return;
    const connection = new Connection(SOLANA_NETWORK, 'confirmed');

    try {
        const balance = await connection.getBalance(houseKeypair.publicKey);
        if ((balance / 1e9) < RESERVE_SOL) return console.error("> [PAYOUT] Reserve Low. Halting.");

        if (result === "FLAT") {
            const burnLamports = Math.floor((totalVolume * 0.99) * 1e9);
            if (burnLamports > 0) {
                try {
                    const burnTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: FEE_WALLET, lamports: burnLamports }));
                    await sendAndConfirmTransaction(connection, burnTx, [houseKeypair]);
                    await stateMutex.runExclusive(async () => {
                        globalStats.totalFees += (burnLamports / 1e9);
                        await saveSystemState();
                    });
                } catch (e) {}
            }
            return;
        }

        const feeLamports = Math.floor((totalVolume * FEE_PERCENT) * 1e9);
        if (feeLamports > 0) {
            try {
                const feeTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: FEE_WALLET, lamports: feeLamports }));
                await sendAndConfirmTransaction(connection, feeTx, [houseKeypair]);
                await stateMutex.runExclusive(async () => {
                    globalStats.totalFees += (feeLamports / 1e9);
                    await saveSystemState();
                });
            } catch (e) {}
        }

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
            let userDir = "FLAT";
            if (pos.up > pos.down) userDir = "UP";
            else if (pos.down > pos.up) userDir = "DOWN";

            if (userDir === result) {
                const sharesHeld = result === "UP" ? pos.up : pos.down;
                totalWinningShares += sharesHeld;
                eligibleWinners.push({ pubKey, sharesHeld });
            }
        }

        if (totalWinningShares > 0) {
            const BATCH_SIZE = 15; 
            for (let i = 0; i < eligibleWinners.length; i += BATCH_SIZE) {
                const batch = eligibleWinners.slice(i, i + BATCH_SIZE);
                const tx = new Transaction();
                let hasInstructions = false;

                for (const winner of batch) {
                    const shareRatio = winner.sharesHeld / totalWinningShares;
                    const payoutLamports = Math.floor(potLamports * shareRatio);

                    if (payoutLamports > 5000) { 
                        tx.add(SystemProgram.transfer({
                            fromPubkey: houseKeypair.publicKey,
                            toPubkey: new PublicKey(winner.pubKey),
                            lamports: payoutLamports
                        }));
                        hasInstructions = true;
                    }
                }

                if (hasInstructions) {
                    try {
                        const sig = await sendAndConfirmTransaction(connection, tx, [houseKeypair], { commitment: 'confirmed' });
                        batch.forEach(async (w) => {
                            const uData = await getUser(w.pubKey);
                            if (uData.frameLog && uData.frameLog[frameId]) {
                                const shareRatio = w.sharesHeld / totalWinningShares;
                                uData.frameLog[frameId].payoutTx = sig;
                                uData.frameLog[frameId].payoutAmount = (potLamports * shareRatio) / 1e9;
                                await saveUser(w.pubKey, uData);
                            }
                        });
                    } catch (e) { console.error(`> [PAYOUT] Batch Failed: ${e.message}`); }
                }
            }
        }

        try {
            const postPayoutBalance = await connection.getBalance(houseKeypair.publicKey);
            const reserveLamports = SWEEP_TARGET * 1e9; 
            const txFeeBuffer = 5000;
            const sweepLamports = postPayoutBalance - reserveLamports - txFeeBuffer;

            if (sweepLamports > 0) {
                const sweepTx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: houseKeypair.publicKey,
                        toPubkey: UPKEEP_WALLET,
                        lamports: sweepLamports
                    })
                );
                await sendAndConfirmTransaction(connection, sweepTx, [houseKeypair]);
            }
        } catch (e) {}

    } catch (e) { console.error("> [PAYOUT] System Error:", e); }
}

// --- FRAME CLOSING ---
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

        const frameRecord = {
            id: frameId,
            startTime: frameId,
            endTime: frameId + FRAME_DURATION,
            time: new Date(frameId).toISOString(),
            open: openPrice, 
            close: closePrice, 
            result: result,
            sharesUp: realSharesUp, 
            sharesDown: realSharesDown, 
            totalSol: frameSol
        };
        historySummary.unshift(frameRecord); 
        await fs.writeFile(HISTORY_FILE, JSON.stringify(historySummary));

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
                let userDir = "FLAT";
                if (pos.up > pos.down) userDir = "UP";
                else if (pos.down > pos.up) userDir = "DOWN";
                const outcome = (userDir !== "FLAT" && result !== "FLAT" && userDir === result) ? "WIN" : "LOSS";
                if (outcome === "WIN") userData.wins += 1; else if (outcome === "LOSS") userData.losses += 1;
                if (!userData.frameLog) userData.frameLog = {};
                userData.frameLog[frameId] = { dir: userDir, result: outcome, time: Date.now(), upShares: pos.up, downShares: pos.down, wagered: pos.sol };
                await saveUser(pubKey, userData);
            }));
        }

        processedSignatures.clear();
        await fs.writeFile(SIGS_FILE, '');

        gameState.candleStartTime = closeTime;
        gameState.candleOpen = closePrice;
        gameState.poolShares = { up: 50, down: 50 }; 
        gameState.bets = []; 
        gameState.sharePriceHistory = [];
        await saveSystemState();

        processPayouts(frameId, result, betsSnapshot, frameSol);
        
    } finally { release(); }
}

// --- ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'solana', vs_currencies: 'usd', x_cg_demo_api_key: COINGECKO_API_KEY }
        });
        
        if (response.data.solana) {
            const currentPrice = response.data.solana.usd;
            
            await stateMutex.runExclusive(async () => {
                gameState.price = currentPrice;
                const currentWindowStart = getCurrentWindowStart();
                
                // PAUSE CHECK: If paused, wait for next natural window start
                if (gameState.isPaused) {
                    if (currentWindowStart > gameState.candleStartTime) {
                        console.log("> [SYS] Unpausing for new Frame.");
                        gameState.isPaused = false; 
                        gameState.candleStartTime = currentWindowStart;
                        gameState.candleOpen = currentPrice;
                        await saveSystemState();
                    }
                    return;
                }

                if (currentWindowStart > gameState.candleStartTime) {
                    if (gameState.candleStartTime === 0) {
                        gameState.candleStartTime = currentWindowStart;
                        gameState.candleOpen = currentPrice;
                        await saveSystemState();
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
            
            if (!gameState.isPaused) {
                const currentWindowStart = getCurrentWindowStart();
                if (currentWindowStart > gameState.candleStartTime && gameState.candleStartTime !== 0) {
                    await closeFrame(currentPrice, currentWindowStart);
                }
            }
        }
    } catch (e) { console.log("Oracle unstable"); }
}

setInterval(updatePrice, 10000); 
updatePrice(); 

// --- ENDPOINTS ---
app.get('/api/state', async (req, res) => {
    const release = await stateMutex.acquire();
    try {
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
            price: gameState.price,
            openPrice: gameState.candleOpen,
            candleStartTime: gameState.candleStartTime,
            candleEndTime: gameState.candleStartTime + FRAME_DURATION,
            change: percentChange,
            msUntilClose: msUntilClose,
            currentVolume: currentVolume,
            uniqueUsers: uniqueUsers,
            platformStats: globalStats,
            isPaused: gameState.isPaused,
            market: { priceUp, priceDown, sharesUp: gameState.poolShares.up, sharesDown: gameState.poolShares.down, changes: changes },
            history: historySummary,
            recentTrades: gameState.recentTrades,
            userStats: myStats,
            activePosition: activePosition 
        });
    } finally { release(); }
});

app.post('/api/verify-bet', async (req, res) => {
    if (gameState.isPaused) return res.status(400).json({ error: "MARKET_PAUSED" });
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
        if (solAmount === 0) return res.status(400).json({ error: "NO_FUNDS" });
    } catch (e) { return res.status(500).json({ error: "CHAIN_ERROR" }); }

    const release = await stateMutex.acquire();
    try {
        if (processedSignatures.has(signature)) return res.status(400).json({ error: "DUPLICATE_TX_DETECTED" });
        if (txBlockTime < gameState.candleStartTime) return res.status(400).json({ error: "TX_TIMESTAMP_EXPIRED" });
        if (gameState.isPaused) return res.status(400).json({ error: "MARKET_PAUSED" });

        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; 
        if (direction === 'UP') price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        else price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;
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

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "STATE_ERROR" });
    } finally { release(); }
});

// --- ADMIN: CANCEL FRAME ---
app.post('/api/admin/cancel-frame', async (req, res) => {
    const auth = req.headers['x-admin-secret'];
    if (!auth || auth !== ADMIN_SECRET) return res.status(403).json({ error: "UNAUTHORIZED" });

    const release = await stateMutex.acquire();
    try {
        if (gameState.bets.length === 0) {
            gameState.isPaused = true;
            await saveSystemState();
            return res.json({ success: true, message: "Paused. No bets." });
        }
        
        console.log(`> [ADMIN] CANCELLING FRAME. Refunding...`);
        const betsToRefund = [...gameState.bets];
        
        const frameRecord = {
            id: gameState.candleStartTime,
            time: new Date(gameState.candleStartTime).toISOString(),
            result: "CANCELLED",
            totalSol: 0, winners: 0, payout: 0
        };
        historySummary.unshift(frameRecord);
        await fs.writeFile(HISTORY_FILE, JSON.stringify(historySummary));

        gameState.bets = [];
        gameState.poolShares = { up: 50, down: 50 };
        gameState.isPaused = true; 
        await saveSystemState();

        // Trigger Refunds (Async)
        processRefunds(betsToRefund);

        res.json({ success: true, message: "Frame Cancelled & Paused." });

    } catch (e) { console.error(e); res.status(500).json({ error: "ADMIN_ERROR" }); } 
    finally { release(); }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Engine v54 (Admin Auth) running on ${PORT}`);
});
