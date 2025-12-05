// Script to find PumpSwap pool for ASDF token
require('dotenv').config({ override: true });
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const ASDF_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function findPool() {
    console.log('Searching for ASDF/SOL PumpSwap pool...\n');

    const connection = new Connection(HELIUS_URL);

    // Method 1: Try to derive the canonical pool PDA
    // Seeds: ["pool", index(u16), creator, base_mint, quote_mint]
    // For canonical pools migrated from pump.fun, index = 0

    // First, let's search for any pool accounts that contain ASDF mint
    // The pool account layout has base_mint at offset 35 (8 discriminator + 1 bump + 2 index + 32 creator - wait, let me recalculate)
    // Actually: 8 (discriminator) + 1 (pool_bump) + 2 (index) + 32 (creator) = 43 bytes before base_mint

    console.log('Method 1: Searching via getProgramAccounts with base_mint filter...');
    try {
        const accounts = await connection.getProgramAccounts(
            new PublicKey(PUMPSWAP_PROGRAM),
            {
                filters: [
                    { dataSize: 211 }, // Pool account size
                    { memcmp: { offset: 43, bytes: ASDF_MINT } }
                ]
            }
        );

        if (accounts.length > 0) {
            console.log(`Found ${accounts.length} pool(s) with ASDF as base:`);
            for (const acc of accounts) {
                console.log('  Pool address:', acc.pubkey.toBase58());
                await parsePoolAccount(connection, acc.pubkey.toBase58(), acc.account.data);
            }
        } else {
            console.log('  No pools found with ASDF as base_mint at offset 43');
        }
    } catch (e) {
        console.log('  Error:', e.message);
    }

    // Try with ASDF as quote_mint (offset 43 + 32 = 75)
    console.log('\nMethod 2: Searching with ASDF as quote_mint...');
    try {
        const accounts = await connection.getProgramAccounts(
            new PublicKey(PUMPSWAP_PROGRAM),
            {
                filters: [
                    { dataSize: 211 },
                    { memcmp: { offset: 75, bytes: ASDF_MINT } }
                ]
            }
        );

        if (accounts.length > 0) {
            console.log(`Found ${accounts.length} pool(s) with ASDF as quote:`);
            for (const acc of accounts) {
                console.log('  Pool address:', acc.pubkey.toBase58());
            }
        } else {
            console.log('  No pools found with ASDF as quote_mint');
        }
    } catch (e) {
        console.log('  Error:', e.message);
    }

    // Method 3: Try different account sizes
    console.log('\nMethod 3: Searching all PumpSwap pools (first 10)...');
    try {
        const accounts = await connection.getProgramAccounts(
            new PublicKey(PUMPSWAP_PROGRAM),
            {
                dataSlice: { offset: 0, length: 150 },
                filters: [{ dataSize: 211 }]
            }
        );
        console.log(`Total PumpSwap pools found: ${accounts.length}`);

        // Check each pool for ASDF
        for (let i = 0; i < Math.min(accounts.length, 100); i++) {
            const data = accounts[i].account.data;
            const dataStr = data.toString('base64');
            if (dataStr.includes('Lgzx')) { // Part of ASDF mint in base64
                console.log(`  Potential ASDF pool: ${accounts[i].pubkey.toBase58()}`);
                await parsePoolAccount(connection, accounts[i].pubkey.toBase58(), data);
            }
        }
    } catch (e) {
        console.log('  Error:', e.message);
    }
}

async function parsePoolAccount(connection, poolAddress, data) {
    try {
        // Parse pool data manually
        // Layout: discriminator(8) + pool_bump(1) + index(2) + creator(32) + base_mint(32) + quote_mint(32) + ...
        const poolBump = data[8];
        const index = data.readUInt16LE(9);
        const creator = new PublicKey(data.slice(11, 43)).toBase58();
        const baseMint = new PublicKey(data.slice(43, 75)).toBase58();
        const quoteMint = new PublicKey(data.slice(75, 107)).toBase58();
        const lpMint = new PublicKey(data.slice(107, 139)).toBase58();
        const poolBaseTokenAccount = new PublicKey(data.slice(139, 171)).toBase58();
        const poolQuoteTokenAccount = new PublicKey(data.slice(171, 203)).toBase58();

        console.log('    Pool Bump:', poolBump);
        console.log('    Index:', index);
        console.log('    Creator:', creator);
        console.log('    Base Mint:', baseMint);
        console.log('    Quote Mint:', quoteMint);
        console.log('    LP Mint:', lpMint);
        console.log('    Base Token Account:', poolBaseTokenAccount);
        console.log('    Quote Token Account:', poolQuoteTokenAccount);

        // Get reserves
        if (baseMint === ASDF_MINT || quoteMint === ASDF_MINT) {
            console.log('\n    === ASDF POOL FOUND! ===');

            // Fetch token account balances
            const baseBalance = await connection.getTokenAccountBalance(new PublicKey(poolBaseTokenAccount));
            const quoteBalance = await connection.getTokenAccountBalance(new PublicKey(poolQuoteTokenAccount));

            console.log('    Base Reserve:', baseBalance.value.uiAmount);
            console.log('    Quote Reserve:', quoteBalance.value.uiAmount);

            // Calculate price
            const price = quoteBalance.value.uiAmount / baseBalance.value.uiAmount;
            console.log('    Price (quote/base):', price, 'SOL per ASDF');
        }

    } catch (e) {
        console.log('    Parse error:', e.message);
    }
}

findPool().catch(console.error);
