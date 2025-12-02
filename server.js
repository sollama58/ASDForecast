const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

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

let gameState = {
    price: 0,
    priceChange: 0,
    lastUpdated: Date.now(),
    bets: [] 
};

// --- ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'solana',
                vs_currencies: 'usd',
                include_24hr_change: 'true',
                x_cg_demo_api_key: COINGECKO_API_KEY 
            }
        });
        
        if (response.data.solana) {
            gameState.price = response.data.solana.usd;
            gameState.priceChange = response.data.solana.usd_24h_change;
            gameState.lastUpdated = Date.now();
            console.log(`> [SYS] ORACLE_UPDATE: $${gameState.price}`);
        }
    } catch (e) {
        console.log("> [ERR] ORACLE_CONNECTION_STABLE");
    }
}

setInterval(updatePrice, 30000); 
updatePrice(); 

// --- ENDPOINTS ---

app.get('/api/state', (req, res) => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const msUntilClose = midnight - now;

    // --- DYNAMIC VOLUME CALCULATION ---
    // Filter bets
    const upBets = gameState.bets.filter(b => b.direction === 'UP');
    const downBets = gameState.bets.filter(b => b.direction === 'DOWN');

    // Sum Lamports and convert to SOL (1 SOL = 1,000,000,000 Lamports)
    // We default to 0 to prevent errors on empty arrays
    const upSol = upBets.reduce((acc, curr) => acc + (curr.amount / 1000000000), 0);
    const downSol = downBets.reduce((acc, curr) => acc + (curr.amount / 1000000000), 0);

    const upUsd = upSol * gameState.price;
    const downUsd = downSol * gameState.price;

    res.json({
        price: gameState.price,
        change: gameState.priceChange,
        msUntilClose: msUntilClose,
        totalBets: gameState.bets.length,
        poolStats: { upSol, downSol, upUsd, downUsd }
    });
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;

    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_PAYLOAD" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        
        // Fetch parsed transaction to read the amount
        const tx = await connection.getParsedTransaction(signature, { 
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0 
        });

        if (!tx) return res.status(404).json({ error: "TX_NOT_FOUND" });
        if (tx.meta.err) return res.status(400).json({ error: "TX_FAILED_ON_CHAIN" });

        // FIND THE AMOUNT SENT TO HOUSE
        // We look through instructions for a transfer to the House Address
        let amountLamports = 0;
        
        // Check inner instructions (simplified logic for demo)
        const instructions = tx.transaction.message.instructions;
        for (let ix of instructions) {
            // Check if it's a System Program transfer
            if (ix.program === 'system' && ix.parsed.type === 'transfer') {
                const info = ix.parsed.info;
                if (info.destination === HOUSE_ADDRESS) {
                    amountLamports = info.lamports;
                    break;
                }
            }
        }

        if (amountLamports === 0) {
            return res.status(400).json({ error: "NO_SOL_TRANSFER_DETECTED" });
        }

        gameState.bets.push({
            signature,
            user: userPubKey,
            direction,
            amount: amountLamports, // Save the actual amount
            timestamp: Date.now()
        });

        console.log(`> [SYS] BET_CONFIRMED: ${userPubKey} | ${direction} | ${(amountLamports/1e9).toFixed(2)} SOL`);
        res.json({ success: true, message: "BET_LOGGED" });

    } catch (e) {
        console.error("> [ERR] VERIFICATION_FAIL", e);
        res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> [BOOT] ASDForecast Terminal running on port ${PORT}`);
});