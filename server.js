const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors({
    origin: 'https://www.alonisthe.dev',
    methods: ['GET', 'POST']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
// --- UPDATED VAULT ADDRESS ---
const HOUSE_ADDRESS = "BXSp5y6Ua6tB5fZDe1EscVaaEaZLg1yqzrsPqAXhKJYy";
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const PRICE_SCALE = 0.1;

// --- PERSISTENCE CONFIGURATION ---
const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fs.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : __dirname;

const STORAGE_FILE = path.join(DATA_DIR, 'storage.json'); 
const HISTORY_FILE = path.join(DATA_DIR, 'history.json'); 
const USERS_FILE = path.join(DATA_DIR, 'users.json');     

console.log(`> [SYS] Persistence Layer Active. Saving data to: ${DATA_DIR}`);
console.log(`> [SYS] Vault Address Configured: ${HOUSE_ADDRESS}`);

// --- STATE MANAGEMENT ---
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    bets: [], 
    poolShares: { up: 100, down: 100 } 
};

let frameHistory = []; 
let userStats = {};    

// --- LOAD DATA ---
function loadData() {
    try {
        if (fs.existsSync(STORAGE_FILE)) gameState = { ...gameState, ...JSON.parse(fs.readFileSync(STORAGE_FILE)) };
        if (fs.existsSync(HISTORY_FILE)) frameHistory = JSON.parse(fs.readFileSync(HISTORY_FILE));
        if (fs.existsSync(USERS_FILE)) userStats = JSON.parse(fs.readFileSync(USERS_FILE));
        console.log(`> [SYS] Data Loaded. Active Bets: ${gameState.bets.length}. Users: ${Object.keys(userStats).length}`);
    } catch (e) { console.error("Load Error", e); }
}

function saveData() {
    try {
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(gameState));
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(frameHistory));
        fs.writeFileSync(USERS_FILE, JSON.stringify(userStats));
    } catch (e) { console.error("Save Error", e); }
}

loadData();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

// --- FRAME CLOSING LOGIC ---
function closeFrame(closePrice, closeTime) {
    console.log(`> [SYS] Closing Frame: ${new Date(gameState.candleStartTime).toISOString()}`);

    const openPrice = gameState.candleOpen;
    let result = "FLAT";
    if (closePrice > openPrice) result = "UP";
    else if (closePrice < openPrice) result = "DOWN";

    const realSharesUp = Math.max(0, gameState.poolShares.up - 100);
    const realSharesDown = Math.max(0, gameState.poolShares.down - 100);
    const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

    // Archive Frame
    const frameRecord = {
        id: gameState.candleStartTime,
        time: new Date(gameState.candleStartTime).toISOString(),
        open: openPrice,
        close: closePrice,
        result: result,
        sharesUp: realSharesUp,
        sharesDown: realSharesDown,
        totalSol: frameSol
    };
    
    frameHistory.unshift(frameRecord); 
    if (frameHistory.length > 100) frameHistory.pop();

    // Determine Winners/Losers Logic
    const frameUserPositions = {}; 
    gameState.bets.forEach(bet => {
        if (!frameUserPositions[bet.user]) {
            frameUserPositions[bet.user] = { upShares: 0, downShares: 0 };
        }
        if (bet.direction === 'UP') frameUserPositions[bet.user].upShares += bet.shares;
        else frameUserPositions[bet.user].downShares += bet.shares;
    });

    for (const [pubKey, pos] of Object.entries(frameUserPositions)) {
        if (!userStats[pubKey]) userStats[pubKey] = { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0 };
        
        const user = userStats[pubKey];
        user.framesPlayed += 1; 

        let userDirection = "FLAT";
        if (pos.upShares > pos.downShares) userDirection = "UP";
        else if (pos.downShares > pos.upShares) userDirection = "DOWN";

        if (userDirection !== "FLAT" && result !== "FLAT") {
            if (userDirection === result) user.wins += 1;
            else user.losses += 1;
        }
    }

    // Reset Game State
    gameState.candleStartTime = closeTime;
    gameState.candleOpen = closePrice;
    gameState.poolShares = { up: 100, down: 100 }; 
    gameState.bets = []; 

    saveData();
}

// --- ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'solana', vs_currencies: 'usd', x_cg_demo_api_key: COINGECKO_API_KEY }
        });
        
        if (response.data.solana) {
            const currentPrice = response.data.solana.usd;
            gameState.price = currentPrice;
            
            const currentWindowStart = getCurrentWindowStart();
            
            if (currentWindowStart > gameState.candleStartTime) {
                if (gameState.candleStartTime !== 0) {
                    closeFrame(currentPrice, currentWindowStart);
                } else {
                    gameState.candleStartTime = currentWindowStart;
                    gameState.candleOpen = currentPrice;
                    saveData();
                }
            }
        }
    } catch (e) { console.log("Oracle unstable"); }
}

setInterval(updatePrice, 30000); 
updatePrice(); 

// --- ENDPOINTS ---

app.get('/api/state', (req, res) => {
    const now = new Date();
    const currentWindowStart = getCurrentWindowStart();
    const nextWindowStart = currentWindowStart + (15 * 60 * 1000);
    const msUntilClose = nextWindowStart - now.getTime();

    const priceChange = gameState.price - gameState.candleOpen;
    const percentChange = gameState.candleOpen ? (priceChange / gameState.candleOpen) * 100 : 0;

    const totalShares = gameState.poolShares.up + gameState.poolShares.down;
    const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
    const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;

    const userKey = req.query.user;
    let myStats = null;
    if (userKey && userStats[userKey]) {
        myStats = userStats[userKey];
    }

    res.json({
        price: gameState.price,
        openPrice: gameState.candleOpen,
        change: percentChange,
        msUntilClose: msUntilClose,
        market: {
            priceUp, priceDown,
            sharesUp: gameState.poolShares.up,
            sharesDown: gameState.poolShares.down
        },
        history: frameHistory.slice(0, 3), 
        userStats: myStats
    });
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;

    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_DATA" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

        if (!tx) return res.status(404).json({ error: "TX_NOT_FOUND" });
        if (tx.meta.err) return res.status(400).json({ error: "TX_FAILED" });

        let lamports = 0;
        const instructions = tx.transaction.message.instructions;
        for (let ix of instructions) {
            if (ix.program === 'system' && ix.parsed.type === 'transfer') {
                if (ix.parsed.info.destination === HOUSE_ADDRESS) {
                    lamports = ix.parsed.info.lamports;
                    break;
                }
            }
        }

        if (lamports === 0) return res.status(400).json({ error: "NO_FUNDS" });
        const solAmount = lamports / 1000000000;

        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; 
        if (direction === 'UP') price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        else price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;

        if (direction === 'UP') gameState.poolShares.up += sharesReceived;
        else gameState.poolShares.down += sharesReceived;

        // --- UPDATE USER STATS IMMEDIATELY ---
        if (!userStats[userPubKey]) {
            userStats[userPubKey] = { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0 };
        }
        userStats[userPubKey].totalSol += solAmount; // Instant update

        gameState.bets.push({
            signature, user: userPubKey, direction,
            costSol: solAmount, entryPrice: price, shares: sharesReceived,
            timestamp: Date.now()
        });

        // --- PERSIST ALL DATA IMMEDIATELY ---
        saveData();
        
        console.log(`> TRADE: ${userPubKey} | ${direction} | ${sharesReceived.toFixed(2)} Shares`);
        res.json({ success: true, shares: sharesReceived, price: price });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Engine v4 (Vault Connected) running on ${PORT}`);
});
