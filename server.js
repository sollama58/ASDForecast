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

// --- PERSISTENCE LAYER ---
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    bets: [] 
};

function loadState() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const raw = fs.readFileSync(STORAGE_FILE);
            const data = JSON.parse(raw);
            gameState.bets = data.bets || [];
            gameState.candleOpen = data.candleOpen || 0;
            gameState.candleStartTime = data.candleStartTime || 0;
            console.log(`> [SYS] State loaded. ${gameState.bets.length} active bets.`);
        }
    } catch (e) {
        console.error("> [ERR] Failed to load state", e);
    }
}

function saveState() {
    try {
        // Only save what we need to persist
        const dataToSave = {
            bets: gameState.bets,
            candleOpen: gameState.candleOpen,
            candleStartTime: gameState.candleStartTime
        };
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(dataToSave));
    } catch (e) {
        console.error("> [ERR] Failed to save state", e);
    }
}

// Load on startup
loadState();

// --- TIME & CANDLE LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = now.getMinutes();
    const windowStartMinutes = Math.floor(minutes / 15) * 15;
    
    const windowStart = new Date(now);
    windowStart.setMinutes(windowStartMinutes);
    windowStart.setSeconds(0);
    windowStart.setMilliseconds(0);
    
    return windowStart.getTime();
}

// --- ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'solana',
                vs_currencies: 'usd',
                x_cg_demo_api_key: COINGECKO_API_KEY 
            }
        });
        
        if (response.data.solana) {
            const currentPrice = response.data.solana.usd;
            gameState.price = currentPrice;
            
            // Check 15m Window Logic
            const currentWindowStart = getCurrentWindowStart();
            
            // If we moved into a new 15m window (or first run)
            if (currentWindowStart > gameState.candleStartTime) {
                console.log(`> [SYS] New 15m Candle Started: ${new Date(currentWindowStart).toISOString()}`);
                
                // Reset/Archive old bets could happen here, but for now we keep them
                // You might want to filter out old bets in a real app
                
                // Set new Candle Open
                gameState.candleStartTime = currentWindowStart;
                gameState.candleOpen = currentPrice;
                
                // Clear bets from previous round? 
                // For this demo, we'll keep them but usually you'd archive them here.
                // gameState.bets = []; 
                
                saveState();
            } else if (gameState.candleOpen === 0) {
                // First run initialization
                gameState.candleOpen = currentPrice;
                gameState.candleStartTime = currentWindowStart;
            }

            console.log(`> ORACLE: $${currentPrice} | Open: $${gameState.candleOpen}`);
        }
    } catch (e) {
        console.log("> [ERR] Oracle Connection Unstable");
    }
}

setInterval(updatePrice, 30000); 
updatePrice(); 

// --- ENDPOINTS ---

app.get('/api/state', (req, res) => {
    const now = new Date();
    const currentWindowStart = getCurrentWindowStart();
    const nextWindowStart = currentWindowStart + (15 * 60 * 1000);
    const msUntilClose = nextWindowStart - now.getTime();

    // Calculate Change relative to 15m Open
    const priceChange = gameState.price - gameState.candleOpen;
    const percentChange = (priceChange / gameState.candleOpen) * 100;

    // Filter bets for THIS window only (Optional, based on requirement)
    // We'll return all bets for volume calculation to keep it simple, 
    // or filter by timestamp >= candleStartTime if you only want fresh bets.
    // Let's filter for current candle bets to match the theme "15min timeframe"
    const activeBets = gameState.bets.filter(b => b.timestamp >= gameState.candleStartTime);

    const upBets = activeBets.filter(b => b.direction === 'UP');
    const downBets = activeBets.filter(b => b.direction === 'DOWN');

    const upSol = upBets.reduce((acc, curr) => acc + (curr.amount / 1000000000), 0);
    const downSol = downBets.reduce((acc, curr) => acc + (curr.amount / 1000000000), 0);

    const upUsd = upSol * gameState.price;
    const downUsd = downSol * gameState.price;

    res.json({
        price: gameState.price,
        openPrice: gameState.candleOpen,
        change: percentChange, // This is now 15m change
        msUntilClose: msUntilClose,
        totalBets: activeBets.length,
        poolStats: { upSol, downSol, upUsd, downUsd }
    });
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;

    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_PAYLOAD" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        const tx = await connection.getParsedTransaction(signature, { 
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0 
        });

        if (!tx) return res.status(404).json({ error: "TX_NOT_FOUND" });
        if (tx.meta.err) return res.status(400).json({ error: "TX_FAILED" });

        // FIND AMOUNT
        let amountLamports = 0;
        const instructions = tx.transaction.message.instructions;
        for (let ix of instructions) {
            if (ix.program === 'system' && ix.parsed.type === 'transfer') {
                const info = ix.parsed.info;
                if (info.destination === HOUSE_ADDRESS) {
                    amountLamports = info.lamports;
                    break;
                }
            }
        }

        if (amountLamports === 0) return res.status(400).json({ error: "NO_SOL_TRANSFER" });

        gameState.bets.push({
            signature,
            user: userPubKey,
            direction,
            amount: amountLamports,
            timestamp: Date.now()
        });

        saveState(); // Persist immediately
        
        console.log(`> [SYS] BET: ${userPubKey} | ${direction} | ${(amountLamports/1e9).toFixed(2)}`);
        res.json({ success: true, message: "BET_LOGGED" });

    } catch (e) {
        console.error("> [ERR] Verify Fail", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> [BOOT] ASDForecast Persistence Server on ${PORT}`);
});