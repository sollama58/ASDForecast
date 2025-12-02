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

app.use(cors({
    origin: 'https://www.alonisthe.dev',
    methods: ['GET', 'POST']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
const FEE_WALLET = new PublicKey("5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan");
const UPKEEP_WALLET = new PublicKey("BH8aAiEDgZGJo6pjh32d5b6KyrNt6zA9U8WTLZShmVXq");
const PRICE_SCALE = 0.1;
const PAYOUT_MULTIPLIER = 0.94;
const FEE_PERCENT = 0.0552; 
const RESERVE_SOL = 0.02;
const SWEEP_TARGET = 0.05;
const FRAME_DURATION = 15 * 60 * 1000; // 15 Minutes in ms

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
    recentTrades: []
};
let historySummary = [];
let globalStats = { totalVolume: 0, totalFees: 0 };
let processedSignatures = new Set(); 

// --- I/O ---
function loadGlobalState() {
    try {
        if (fsSync.existsSync(HISTORY_FILE)) historySummary = JSON.parse(fsSync.readFileSync(HISTORY_FILE));
        if (fsSync.existsSync(STATS_FILE)) globalStats = JSON.parse(fsSync.readFileSync(STATS_FILE));
        
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
            recentTrades: gameState.recentTrades
        }));
        
        await fs.writeFile(STATS_FILE, JSON.stringify(globalStats));

        if (gameState.candleStartTime > 0) {
            const frameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            // EXPLICIT TIMESTAMPS IN SHARDED FILE
            await fs.writeFile(frameFile, JSON.stringify({
                id: gameState.candleStartTime,
                startTime: gameState.candleStartTime,
                endTime: gameState.candleStartTime + FRAME_DURATION,
                open: gameState.candleOpen,
                poolShares: gameState.poolShares,
                bets: [...gameState.bets]
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

        const eligibleWinners = [];
        let totalWinningShares = 0;

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

        // SWEEP EXCESS
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

        const openPrice = gameState.candleOpen;
        let result = "FLAT";
        if (closePrice > openPrice) result = "UP";
        else if (closePrice < openPrice) result = "DOWN";

        const realSharesUp = Math.max(0, gameState.poolShares.up - 50);
        const realSharesDown = Math.max(0, gameState.poolShares.down - 50);
        const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

        // EXPLICIT TIMESTAMPS IN HISTORY
        const frameRecord = {
            id: frameId,
            startTime: frameId, // Store start
            endTime: frameId + FRAME_DURATION, // Store end
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
                const myShares = userDir === 'UP' ? pos.up : (userDir === 'DOWN' ? pos.down : 0);
                userData.frameLog[frameId] = { 
                    dir: userDir, result: outcome, time: Date.now(),
                    shares: myShares, wagered: pos.sol
                };
                await saveUser(pubKey, userData);
            }));
        }

        gameState.candleStartTime = closeTime;
        gameState.candleOpen = closePrice;
        gameState.poolShares = { up: 50, down: 50 }; 
        gameState.bets = []; 
        await saveSystemState();

        processPayouts(frameId, result, betsSnapshot, frameSol);
        
    } finally { release(); }
}

// --- ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
        
        if (response.data && response.data.price) {
            const currentPrice = parseFloat(response.data.price);
            
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
        // Note: We still calc time left on the fly for the timer countdown
        const now = new Date();
        const nextWindowStart = getCurrentWindowStart() + FRAME_DURATION;
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
            candleStartTime: gameState.candleStartTime,
            // SEND CALCULATED END TIME
            candleEndTime: gameState.candleStartTime + FRAME_DURATION,
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
            recentTrades: gameState.recentTrades,
            userStats: myStats,
            activePosition: activePosition 
        });
    } finally { release(); }
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;
    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_DATA" });

    if (processedSignatures.has(signature)) {
        return res.status(400).json({ error: "DUPLICATE_TX_DETECTED" });
    }

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
        if (txBlockTime < gameState.candleStartTime) {
            console.warn(`> [SEC] Rejected Stale Bet: ${signature}`);
            return res.status(400).json({ error: "TX_TIMESTAMP_EXPIRED" });
        }

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

        gameState.bets.push({
            signature, user: userPubKey, direction,
            costSol: solAmount, entryPrice: price, shares: sharesReceived,
            timestamp: Date.now()
        });

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

app.listen(PORT, () => {
    console.log(`> ASDForecast Engine v32 running on ${PORT}`);
});
