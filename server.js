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
const HOUSE_ADDRESS = "H3tY5a5n7C5h2jK8n3m4n5b6v7c8x9z1a2s3d4f5g6h";
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const STORAGE_FILE = path.join(__dirname, 'storage.json');

// --- PERSISTENCE ---
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    bets: [],
    // Track Pool Volume in SOL for pricing
    poolVolume: { up: 0.1, down: 0.1 } // Start with dust to avoid div/0
};

function loadState() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE));
            gameState.bets = data.bets || [];
            gameState.candleOpen = data.candleOpen || 0;
            gameState.candleStartTime = data.candleStartTime || 0;
            gameState.poolVolume = data.poolVolume || { up: 0.1, down: 0.1 };
            console.log(`> [SYS] State loaded.`);
        }
    } catch (e) { console.error("Load Error", e); }
}

function saveState() {
    try {
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(gameState));
    } catch (e) { console.error("Save Error", e); }
}

loadState();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0);
    return start.getTime();
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
            
            // NEW CANDLE DETECTED
            if (currentWindowStart > gameState.candleStartTime) {
                console.log(`> [SYS] New 15m Candle: ${new Date(currentWindowStart).toISOString()}`);
                gameState.candleStartTime = currentWindowStart;
                gameState.candleOpen = currentPrice;
                // Reset Pools for new round? 
                // For this demo, we keep cumulative pools to show pricing dynamics, 
                // or you can reset: gameState.poolVolume = { up: 0.1, down: 0.1 };
                // Let's reset to keep it fresh for the timeframe.
                gameState.poolVolume = { up: 0.1, down: 0.1 }; 
                gameState.bets = []; // Clear old bets
                saveState();
            } else if (gameState.candleOpen === 0) {
                gameState.candleOpen = currentPrice;
                gameState.candleStartTime = currentWindowStart;
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

    // CALCULATE DYNAMIC PRICES
    // Price = Share of Pool. e.g. 90 SOL UP / 100 SOL Total = 0.90 Price
    const totalVol = gameState.poolVolume.up + gameState.poolVolume.down;
    const priceUp = gameState.poolVolume.up / totalVol;
    const priceDown = gameState.poolVolume.down / totalVol;

    res.json({
        price: gameState.price,
        openPrice: gameState.candleOpen,
        change: percentChange,
        msUntilClose: msUntilClose,
        market: {
            priceUp: priceUp,
            priceDown: priceDown,
            volUp: gameState.poolVolume.up,
            volDown: gameState.poolVolume.down
        }
    });
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body; // Removed 'amount' from body, we trust chain

    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_DATA" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

        if (!tx) return res.status(404).json({ error: "TX_NOT_FOUND" });
        if (tx.meta.err) return res.status(400).json({ error: "TX_FAILED" });

        // Extract SOL Amount
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

        if (lamports === 0) return res.status(400).json({ error: "NO_FUNDS_DETECTED" });

        const solAmount = lamports / 1000000000;

        // CALCULATE SHARES PURCHASED
        // Based on price AT EXECUTION time
        const totalVol = gameState.poolVolume.up + gameState.poolVolume.down;
        let price = 0.5; // default
        
        if (direction === 'UP') {
            price = gameState.poolVolume.up / totalVol;
            gameState.poolVolume.up += solAmount;
        } else {
            price = gameState.poolVolume.down / totalVol;
            gameState.poolVolume.down += solAmount;
        }

        // Avoid price=0 edge case
        if(price < 0.01) price = 0.01;

        const shares = solAmount / price;

        gameState.bets.push({
            signature,
            user: userPubKey,
            direction,
            costSol: solAmount,
            entryPrice: price,
            shares: shares,
            timestamp: Date.now()
        });

        saveState();
        
        console.log(`> TRADE: ${userPubKey} bought ${shares.toFixed(2)} ${direction} shares for ${solAmount} SOL`);
        res.json({ success: true, shares: shares, price: price });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Market Engine running on ${PORT}`);
});