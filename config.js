/**
 * ASDForecast Configuration
 * Centralized constants for the entire application
 *
 * Environment variables (HELIUS_API_KEY, etc.) remain in server.js
 */

module.exports = {
    // ===================
    // VERSION
    // ===================
    BACKEND_VERSION: "150.0",

    // ===================
    // SOLANA ADDRESSES
    // ===================
    ASDF_MINT: "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump",
    FEE_WALLET: "5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan",
    UPKEEP_WALLET: "BH8aAiEDgZGJo6pjh32d5b6KyrNt6zA9U8WTLZShmVXq",
    TRACKED_WALLET: "vcGYZbvDid6cRUkCCqcWpBxow73TLpmY6ipmDUtrTF8",
    PURCHASE_SOURCE_ADDRESS: "DuhRX5JTPtsWU5n44t8tcFEfmzy2Eu27p4y6z8Rhf2bb",

    // ===================
    // PUMPSWAP POOL (On-chain price source)
    // ===================
    PUMPSWAP_POOL: {
        POOL_ADDRESS: "DuhRX5JTPtsWU5n44t8tcFEfmzy2Eu27p4y6z8Rhf2bb",
        BASE_TOKEN_ACCOUNT: "9NXgzYh3ZhrqiLn994fhkGx7ikAUbEcWux9SGuxyXq2z",   // ASDF reserve
        QUOTE_TOKEN_ACCOUNT: "HmmH9j2BHmJHQDRGMswBMccMfsr6jknGTux3wFqmXrya",  // SOL reserve
        BASE_DECIMALS: 6,
        QUOTE_DECIMALS: 9
    },

    // ===================
    // GAME ECONOMY
    // ===================
    PRICE_SCALE: 0.1,
    PAYOUT_MULTIPLIER: 0.94,          // 94% to winners
    FEE_PERCENT: 0.0552,              // 5.52% fees (buyback & burn)
    UPKEEP_PERCENT: 0.0048,           // 0.48% upkeep (gas costs)
    FRAME_DURATION_MS: 15 * 60 * 1000, // 15 minutes
    PRIORITY_FEE_UNITS: 50000,

    // ===================
    // LOTTERY CONFIG
    // ===================
    LOTTERY_CONFIG: {
        ELIGIBILITY_PERCENT: 0.0000552,       // 0.00552% of circulating supply
        MAX_TICKETS: 52,
        DRAW_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
        ACTIVITY_WINDOW_DAYS: 7,
        BASE_PRIZE: 100000,                   // Legacy - now uses pool
        PRIZE_PER_TICKET: 10000,              // Legacy
        SUPPLY_CACHE_MS: 5 * 60 * 1000,       // 5 minutes
        PRIZE_POOL_THRESHOLD: 1_000_000,      // 1M ASDF to trigger draw
        ASDF_TO_POOL_PERCENT: 0.552           // 55.2% to lottery pool
    },

    // ===================
    // GOLDEN RATIO (φ)
    // ===================
    PHI: 1.618033988749895,

    // ===================
    // REFERRAL CONFIG (552 SYMMETRY + Golden Ratio Decay)
    // ===================
    REFERRAL_CONFIG: {
        USER_REBATE_PERCENT: 0.00552,         // 0.552% rebate to user (fixed)
        BASE_REFERRER_RATE: 0.00448,          // 0.448% base rate (decays with φ)
        MIN_ASDF_TO_REFER: 55200,             // Min ASDF to create code
        CODE_LENGTH: 8,
        MAX_REFERRALS_PER_USER: 100,
        REWARD_CURRENCY: 'ASDF',
        CLAIM_RATIO: 1.0
        // Rate decay: 0.448% → 0.277% → 0.171% → 0.106% → 0.065%...
        // Formula: baseRate / φ^floor(log_φ(n+1))
    },

    // ===================
    // EXTERNAL APIs
    // ===================
    PYTH_HERMES_URL: "https://hermes.pyth.network/v2/updates/price/latest",
    SOL_FEED_ID: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    HELIUS_ENHANCED_BASE: "https://api-mainnet.helius-rpc.com/v0",
    JUP_PRICE_URL: "https://lite-api.jup.ag/price/v3",

    // ===================
    // TOKEN SUPPLY
    // ===================
    TOKEN_TOTAL_SUPPLY: 1_000_000_000,

    // ===================
    // RATE LIMITING
    // ===================
    RATE_LIMITS: {
        BET: { windowMs: 60 * 1000, max: 10 },           // 10 bets/min
        STATE: { windowMs: 60 * 1000, max: 120 },        // 120 polls/min
        VOTE: { windowMs: 3600 * 1000, max: 1 },         // 1 vote/hour
        CLAIM: { windowMs: 5 * 60 * 1000, max: 3 },      // 3 claims/5min
        REGISTER: { windowMs: 60 * 1000, max: 5 }        // 5 registers/min
    },

    // ===================
    // WEBSOCKET
    // ===================
    WEBSOCKET: {
        HEARTBEAT_INTERVAL: 30000,      // 30s ping/pong
        STATE_BROADCAST_THROTTLE: 500,  // 500ms min between state broadcasts
        RECONNECT_BACKOFF_MAX: 30000    // 30s max reconnect delay
    },

    // ===================
    // ACHIEVEMENTS (Badges)
    // ===================
    ACHIEVEMENTS: {
        // Badge definitions: id -> { name, description, condition }
        BADGES: {
            FIRST_BET: { name: 'First Steps', description: 'Place your first bet', icon: '🎲' },
            FIRST_WIN: { name: 'Winner', description: 'Win your first frame', icon: '🏆' },
            WIN_STREAK_3: { name: 'Hot Streak', description: 'Win 3 frames in a row', icon: '🔥' },
            WINS_10: { name: 'Rising Star', description: 'Win 10 frames', icon: '⭐' },
            WINS_50: { name: 'Veteran', description: 'Win 50 frames', icon: '🎖️' },
            WINS_100: { name: 'Legend', description: 'Win 100 frames', icon: '👑' },
            FRAMES_100: { name: 'Dedicated', description: 'Play 100 frames', icon: '💪' },
            VOLUME_1: { name: 'Trader', description: 'Wager 1 SOL total', icon: '💰' },
            VOLUME_10: { name: 'High Roller', description: 'Wager 10 SOL total', icon: '💎' },
            REFERRER_5: { name: 'Ambassador', description: 'Refer 5 users', icon: '🤝' },
            HODLER: { name: 'Diamond Hands', description: 'Hold ASDF for 4+ weeks', icon: '💎' }
        }
    },

    // ===================
    // MISC
    // ===================
    MAX_LOGS: 100,
    RENDER_DISK_PATH: '/var/data'
};
