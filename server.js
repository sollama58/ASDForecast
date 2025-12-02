const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');

const app = express();
const stateMutex = new Mutex();

app.use(cors({
    origin: 'https://www.alonisthe.dev',
    methods: ['GET', 'POST']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
const FEE_WALLET = new PublicKey("5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan");
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const PRICE_SCALE = 0.1;
const PAYOUT_MULTIPLIER = 0.94;
const FEE_PERCENT = 0.0552; 
const RESERVE_SOL = 0.02;

// --- PERSISTENCE ---
const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fs.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const USERS_DIR = path.join(DATA_DIR, 'users');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR);
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR);

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const STATS_FILE = path.join(DATA_DIR, 'global_stats.json');

console.log(`> [SYS] Persistence Root: ${DATA_DIR}`);

// --- KEY MANAGEMENT ---
let houseKeypair;
try {
    if (process.env.SOLANA_WALLET_JSON) {
        houseKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_WALLET_JSON)));
        console.log(`> [AUTH] Wallet Loaded (ENV): ${houseKeypair.publicKey.toString()}`);
    } else if (fs.existsSync('house-wallet.json')) {
        houseKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('house-wallet.json'))));
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
    poolShares: { up: 100, down: 100 },
    bets: [],
    recentTrades: [] // NEW: Rolling log of last 20 trades for ticker
};
let historySummary = [];
let globalStats = { totalVolume: 0, totalFees: 0 };

// --- I/O ---
function loadGlobalState() {
    try {
        if (fs.existsSync(HISTORY_FILE)) historySummary = JSON.parse(fs.readFileSync(HISTORY_FILE));
        if (fs.existsSync(STATS_FILE)) globalStats = JSON.parse(fs.readFileSync(STATS_FILE));
        
        if (fs.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fs.readFileSync(STATE_FILE));
            gameState.candleOpen = savedState.candleOpen || 0;
            gameState.candleStartTime = savedState.candleStartTime || 0;
            gameState.poolShares = savedState.poolShares || { up: 100, down: 100 };
            gameState.recentTrades = savedState.recentTrades || [];
            
            const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            if (fs.existsSync(currentFrameFile)) {
                const frameData = JSON.parse(fs.readFileSync(currentFrameFile));
                gameState.bets = frameData.bets || [];
                gameState.poolShares = frameData.poolShares || gameState.poolShares;
            } else {
                gameState.bets = [];
            }
        }
    } catch (e) { console.error("> [ERR] Load Error:", e); }
}

function saveSystemState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            candleOpen: gameState.candleOpen,
            candleStartTime: gameState.candleStartTime,
            poolShares: gameState.poolShares,
            recentTrades: gameState.recentTrades
        }));
        
        fs.writeFileSync(STATS_FILE, JSON.stringify(globalStats));

        if (gameState.candleStartTime > 0) {
            const frameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            fs.writeFileSync(frameFile, JSON.stringify({
                id: gameState.candleStartTime,
                open: gameState.candleOpen,
                poolShares: gameState.poolShares,
                bets: gameState.bets
            }));
        }
    } catch (e) { console.error("> [ERR] Save Error:", e); }
}

function getUser(pubKey) {
    const file = path.join(USERS_DIR, `user_${pubKey}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
    return { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0, frameLog: {} };
}

function saveUser(pubKey, data) {
    fs.writeFileSync(path.join(USERS_DIR, `user_${pubKey}.json`), JSON.stringify(data));
}

loadGlobalState();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

// --- PAYOUT ENGINE ---
async function processPayouts(frameId, result, bets, totalVolume) {
    if (!houseKeypair || totalVolume === 0) return;

    const connection = new Connection(SOLANA_NETWORK, 'confirmed');
    console.log(`> [PAYOUT] Frame ${frameId} | Result: ${result} | Vol: ${totalVolume.toFixed(4)} SOL`);

    try {
        const balance = await connection.getBalance(houseKeypair.publicKey);
        if ((balance / 1e9) < RESERVE_SOL) return console.error("> [PAYOUT] Reserve Low. Halting.");

        // --- FLAT MARKET ---
        if (result === "FLAT") {
            const burnLamports = Math.floor((totalVolume * 0.99) * 1e9);
            if (burnLamports > 0) {
                try {
                    const burnTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: FEE_WALLET, lamports: burnLamports }));
                    await sendAndConfirmTransaction(connection, burnTx, [houseKeypair]);
                    globalStats.totalFees += (burnLamports / 1e9);
                    saveSystemState();
                    console.log(`> [BURN] Sent ${burnLamports/1e9} SOL to Fee Wallet.`);
                } catch (e) { console.error("> [BURN] Error:", e.message); }
            }
            return;
        }

        // --- NORMAL MARKET ---
        const feeLamports = Math.floor((totalVolume * FEE_PERCENT) * 1e9);
        if (feeLamports > 0) {
            try {
                const feeTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: FEE_WALLET, lamports: feeLamports }));
                await sendAndConfirmTransaction(connection, feeTx, [houseKeypair]);
                globalStats.totalFees += (feeLamports / 1e9);
                saveSystemState();
            } catch (e) { console.error("> [FEE] Error:", e.message); }
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

        if (totalWinningShares === 0) return console.log("> [PAYOUT] House Wins.");

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
                    
                    for (const w of batch) {
                        const uData = getUser(w.pubKey);
                        if (uData.frameLog && uData.frameLog[frameId]) {
                            uData.frameLog[frameId].payoutTx = sig;
                            await saveUser(w.pubKey, uData);
                        }
                    }
                } catch (e) { console.error(`> [PAYOUT] Batch Failed: ${e.message}`); }
            }
        }
    } catch (e) { console.error("> [PAYOUT] System Error:", e); }
}

async function closeFrame(closePrice, closeTime) {
    const release = await stateMutex.acquire(); 
    try {
        const frameId = gameState.candleStartTime; 
        console.log(`> [SYS] Closing Frame: ${frameId}`);

        const openPrice = gameState.candleOpen;
        let result = "FLAT";
        if (closePrice > openPrice) result = "UP";
        else if (closePrice < openPrice) result = "DOWN";

        const realSharesUp = Math.max(0, gameState.poolShares.up - 50);
        const realSharesDown = Math.max(0, gameState.poolShares.down - 50);
        const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

        const frameRecord = {
            id: frameId, time: new Date(frameId).toISOString(),
            open: openPrice, close: closePrice, result: result,
            sharesUp: realSharesUp, sharesDown: realSharesDown, totalSol: frameSol
        };
        historySummary.unshift(frameRecord); 
        await fs.writeFileSync(HISTORY_FILE, JSON.stringify(historySummary));

        const userPositions = {};
        gameState.bets.forEach(bet => {
            if (!userPositions[bet.user]) userPositions[bet.user] = { up: 0, down: 0 };
            if (bet.direction === 'UP') userPositions[bet.user].up += bet.shares;
            else userPositions[bet.user].down += bet.shares;
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
                userData.frameLog[frameId] = { dir: userDir, result: outcome, time: Date.now() };
                await saveUser(pubKey, userData);
            }));
        }

        processPayouts(frameId, result, [...gameState.bets], frameSol);

        gameState.candleStartTime = closeTime;
        gameState.candleOpen = closePrice;
        gameState.poolShares = { up: 50, down: 50 }; 
        gameState.bets = []; 

        await saveSystemState();
        
    } finally { release(); }
}

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
                if (currentWindowStart > gameState.candleStartTime) {
                    if (gameState.candleStartTime === 0) {
                        gameState.candleStartTime = currentWindowStart;
                        gameState.candleOpen = currentPrice;
                        await saveSystemState();
                    }
                }
            });
            
            const currentWindowStart = getCurrentWindowStart();
            if (currentWindowStart > gameState.candleStartTime && gameState.candleStartTime !== 0) {
                await closeFrame(currentPrice, currentWindowStart);
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
        const nextWindowStart = getCurrentWindowStart() + (15 * 60 * 1000);
        const msUntilClose = nextWindowStart - now.getTime();

        const priceChange = gameState.price - gameState.candleOpen;
        const percentChange = gameState.candleOpen ? (priceChange / gameState.candleOpen) * 100 : 0;
        const currentVolume = gameState.bets.reduce((acc, b) => acc + b.costSol, 0);

        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;

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
            change: percentChange,
            msUntilClose: msUntilClose,
            currentVolume: currentVolume,
            platformStats: globalStats,
            market: {
                priceUp, priceDown,
                sharesUp: gameState.poolShares.up,
                sharesDown: gameState.poolShares.down
            },
            history: historySummary,
            recentTrades: gameState.recentTrades, // Send Ticker Data
            userStats: myStats,
            activePosition: activePosition 
        });
    } finally { release(); }
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;
    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_DATA" });

    let solAmount = 0;
    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta.err) return res.status(400).json({ error: "TX_INVALID" });

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
        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; 
        if (direction === 'UP') price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        else price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;

        if (direction === 'UP') gameState.poolShares.up += sharesReceived;
        else gameState.poolShares.down += sharesReceived;

        const userData = await getUser(userPubKey);
        userData.totalSol += solAmount;
        await saveUser(userPubKey, userData);

        gameState.bets.push({
            signature, user: userPubKey, direction,
            costSol: solAmount, entryPrice: price, shares: sharesReceived,
            timestamp: Date.now()
        });

        // Add to Ticker
        gameState.recentTrades.unshift({
            user: userPubKey,
            direction: direction,
            shares: sharesReceived,
            time: Date.now()
        });
        if (gameState.recentTrades.length > 20) gameState.recentTrades.pop();

        globalStats.totalVolume += solAmount;
        await saveSystemState();
        
        res.json({ success: true, shares: sharesReceived, price: price });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "STATE_ERROR" });
    } finally { release(); }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Secure Engine v25 (Ticker Enabled) running on ${PORT}`);
});
