// Find all DEX pools containing ASDF token
require('dotenv').config({ override: true });
const axios = require('axios');

const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const ASDF_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';

// Known DEX program IDs
const DEX_PROGRAMS = {
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca V1',
    'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S': 'Lifinity',
};

async function main() {
    console.log('Looking for ASDF token pools...\n');

    // Method 1: Use Helius searchAssets to find all token accounts for ASDF
    console.log('Method 1: Finding largest ASDF token accounts via searchAssets...');
    try {
        const response = await axios.post(HELIUS_URL, {
            jsonrpc: '2.0',
            id: 'search-assets',
            method: 'searchAssets',
            params: {
                ownerAddress: null,
                tokenType: 'fungible',
                mint: ASDF_MINT,
                limit: 50,
                sortBy: { sortBy: 'none' }
            }
        });

        if (response.data.result?.items) {
            console.log(`Found ${response.data.result.items.length} token accounts`);
            // This won't work as expected, searchAssets is for NFTs primarily
        }
    } catch (e) {
        console.log('  searchAssets error:', e.response?.data?.error?.message || e.message);
    }

    // Method 2: Get token accounts via getTokenAccountsByMint-like query
    console.log('\nMethod 2: Using getProgramAccounts to find ASDF token accounts...');
    try {
        const response = await axios.post(HELIUS_URL, {
            jsonrpc: '2.0',
            id: 'get-token-accounts',
            method: 'getProgramAccounts',
            params: [
                'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
                {
                    encoding: 'jsonParsed',
                    filters: [
                        { dataSize: 165 }, // Token account size
                        { memcmp: { offset: 0, bytes: ASDF_MINT } }
                    ]
                }
            ]
        }, { timeout: 30000 });

        if (response.data.result) {
            const accounts = response.data.result;
            console.log(`Found ${accounts.length} ASDF token accounts`);

            // Sort by balance
            const sorted = accounts
                .map(acc => ({
                    address: acc.pubkey,
                    owner: acc.account.data.parsed?.info?.owner,
                    amount: parseFloat(acc.account.data.parsed?.info?.tokenAmount?.uiAmount || 0)
                }))
                .filter(a => a.amount > 0)
                .sort((a, b) => b.amount - a.amount)
                .slice(0, 20);

            console.log('\nTop 20 ASDF holders:');
            for (const acc of sorted) {
                const dexName = DEX_PROGRAMS[acc.owner] || '';
                const marker = dexName ? ` <-- ${dexName} POOL!` : '';
                console.log(`  ${acc.amount.toLocaleString()} ASDF - Owner: ${acc.owner.slice(0,8)}...${marker}`);
            }

            // Check if any owner is a known DEX
            const dexAccounts = sorted.filter(acc => DEX_PROGRAMS[acc.owner]);
            if (dexAccounts.length > 0) {
                console.log('\n=== DEX POOLS FOUND ===');
                for (const acc of dexAccounts) {
                    console.log(`${DEX_PROGRAMS[acc.owner]}: ${acc.address}`);
                    console.log(`  ASDF Reserve: ${acc.amount.toLocaleString()}`);
                }
            }
        }
    } catch (e) {
        console.log('  Error:', e.response?.data?.error?.message || e.message);
    }

    // Method 3: Try getSignaturesForAddress to find pool creation
    console.log('\nMethod 3: Looking for recent ASDF transactions on DEXes...');
    try {
        const response = await axios.post(HELIUS_URL, {
            jsonrpc: '2.0',
            id: 'get-signatures',
            method: 'getSignaturesForAddress',
            params: [ASDF_MINT, { limit: 20 }]
        });

        if (response.data.result?.length > 0) {
            console.log(`Found ${response.data.result.length} recent transactions`);
            // Just show we found some activity
        }
    } catch (e) {
        console.log('  Error:', e.message);
    }
}

main().catch(console.error);
