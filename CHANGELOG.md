# ASDForecast Changelog

## Version 147.0 - On-chain ASDF Price (PumpSwap Pool)

### Overview

This update replaces the Jupiter Price API with direct on-chain price calculation from the PumpSwap liquidity pool. This provides more accurate, real-time pricing based on actual pool reserves.

---

## Changes

### 1. On-chain Price Source

**Pool Configuration:**
```javascript
const PUMPSWAP_POOL = {
    POOL_ADDRESS: "DuhRX5JTPtsWU5n44t8tcFEfmzy2Eu27p4y6z8Rhf2bb",
    BASE_TOKEN_ACCOUNT: "9NXgzYh3ZhrqiLn994fhkGx7ikAUbEcWux9SGuxyXq2z",   // ASDF reserve
    QUOTE_TOKEN_ACCOUNT: "HmmH9j2BHmJHQDRGMswBMccMfsr6jknGTux3wFqmXrya",  // SOL reserve
    BASE_DECIMALS: 6,
    QUOTE_DECIMALS: 9
};
```

**Price Calculation:**
```
priceInSol = quoteReserve / baseReserve
priceInUsd = priceInSol * solPriceUsd
```

### 2. Startup Validation

- **HELIUS_API_KEY** required at startup (fatal error if missing)
- **Pool accessibility** validated on boot with test price fetch
- Clear logging of price data and pool reserves

### 3. Enhanced Price Data

The `getASDF_PriceFromPool()` function now returns:
```javascript
{
    priceInSol: 0.000000870939,
    priceInUsd: 0.00011854,
    baseReserve: 181879310,  // ASDF in pool
    quoteReserve: 158.4,     // SOL in pool
    timestamp: Date.now()
}
```

### 4. API Enhancements

**`/api/referral/stats`** now includes:
- `priceAvailable: boolean` - Indicates if price is available
- `priceWarning: string | null` - Warning message if price unavailable

**External stats cache** now includes:
- `tokenPriceInSol` - ASDF price in SOL
- `poolReserves.asdf` - ASDF reserve amount
- `poolReserves.sol` - SOL reserve amount

---

## Files Modified

### server.js

**New Configuration (lines 40-52):**
- `PUMPSWAP_POOL` constant with pool addresses

**Modified Functions:**
| Function | Change |
|----------|--------|
| `getASDF_PriceFromPool()` | New - reads on-chain pool reserves |
| `getASDF_Price()` | Now wraps `getASDF_PriceFromPool()` for backward compatibility |
| `fetchTokenPricesStaggered()` | Uses on-chain price instead of Jupiter API |
| `loadAndInit()` | Validates pool accessibility on startup |

### New Files

- `scripts/find_asdf_pools.js` - Utility to discover ASDF pools
- `scripts/find_pumpswap_pool.js` - PumpSwap pool discovery utility

---

## Benefits

| Aspect | Before (Jupiter API) | After (On-chain) |
|--------|---------------------|------------------|
| Source | Third-party API | Direct blockchain |
| Latency | ~500ms | ~200ms |
| Reliability | API dependent | RPC dependent |
| Data | Price only | Price + reserves |
| Cache | 60 seconds | 30 seconds |

---

## Testing

```bash
# Server startup shows:
✓ HELIUS_API_KEY loaded (ac94987a...)
✓ PumpSwap pool validated: 0.000000870939 SOL/ASDF
> [PRICE] ASDF on-chain: 0.000000870939 SOL ($0.00011854) | Pool: 181,879,310 ASDF / 158.41 SOL
```

---

---

## Version 145.0 - Referral Flywheel System (552 SYMMETRY)

### Overview

This update introduces a referral rewards system designed to align gamblers and holders through economic incentives. The "552 SYMMETRY" design forces users to hold ASDF to claim rewards, creating a virtuous flywheel.

---

## Philosophy

**Goal:** Transform every gambler into a long-term ASDF holder via aligned incentives.

```
┌─────────────────────────────────────────────────────────────┐
│                    REFERRAL FLYWHEEL                        │
├─────────────────────────────────────────────────────────────┤
│  1. User joins via referral code                            │
│  2. User bets → accumulates 0.552% in ASDF (pending)        │
│  3. Referrer accumulates 0.448% in ASDF (pending)           │
│  4. To claim: must HOLD as much ASDF as pending             │
│  5. User buys ASDF → can claim → holds more                 │
│  6. Repeat: more play + hold → more earnings                │
└─────────────────────────────────────────────────────────────┘
```

---

## New Features

### 1. Referral Code System

**Requirements:**
- Hold >= 55,200 ASDF to create a referral code
- 8-character unique code per user

**Rewards (based on BET amount, not fees):**
| Role | Reward | Description |
|------|--------|-------------|
| Filleul (referred user) | 0.552% | Rebate on your own bets |
| Parrain (referrer) | 0.448% | Commission on referral's bets |

### 2. Proportional Claim Mechanism

```javascript
claimableAmount = min(pendingRewards, currentASDF_Balance)
```

**Example Flywheel:**
1. User referred bets 10 SOL → accumulates ~0.0552 SOL worth of ASDF
2. User holds 0 ASDF → can claim 0 (must buy first)
3. User buys 1000 ASDF → can claim up to 1000 ASDF rewards
4. User claims → now holds more ASDF
5. Continues playing → accumulates more → buys more to claim more

### 3. Live ASDF Price Conversion

- Rewards tracked in SOL value
- Converted to ASDF at claim time using Jupiter Price API
- Ensures fair conversion regardless of price volatility

---

## Files Modified

### server.js

**New Configuration (line 56-67):**
```javascript
const REFERRAL_CONFIG = {
    USER_REBATE_PERCENT: 0.00552,     // 0.552% of bet → Filleul
    REFERRER_REWARD_PERCENT: 0.00448, // 0.448% of bet → Parrain
    MIN_ASDF_TO_REFER: 55200,
    CODE_LENGTH: 8,
    MAX_REFERRALS_PER_USER: 100,
    REWARD_CURRENCY: 'ASDF',
    CLAIM_RATIO: 1.0
};
```

**New Data Structure:**
```javascript
referralData = {
    links: {},           // referrer -> {code, referredUsers[], ...}
    codeToReferrer: {},  // code -> referrer
    userToReferrer: {},  // user -> referrer
    pendingRewards: {}   // user -> {asReferrer, asUser, totalClaimedASDF}
};
```

**New Functions:**
| Function | Purpose |
|----------|---------|
| `getASDF_Price()` | Fetches live ASDF/SOL price from Jupiter API |
| `getOrCreateReferralCode(pubKey)` | Creates referral code if eligible |
| `processReferralRewards(bet)` | Calculates rewards based on bet amount |
| `transferASDF(recipient, amount)` | SPL token transfer for claims |

**New API Endpoints:**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/referral/code?user=` | GET | Get or create referral code |
| `/api/referral/register` | POST | Register with a referral code |
| `/api/referral/stats?user=` | GET | User's referral stats & pending rewards |
| `/api/referral/claim` | POST | Claim pending ASDF rewards |

**New Data File:**
- `data/referral_data.json` - Referral links and pending rewards

---

### frontend.html

**New UI Section (lines 391-487):**
- Referral code display with copy button
- Pending rewards / Balance / Claimable grid
- Claim button with transaction link
- Stats grid (referred users, volume, total claimed)
- Register with code section
- 552 SYMMETRY explanation

**New JavaScript Functions (lines 1010-1238):**
| Function | Purpose |
|----------|---------|
| `fetchReferralStats()` | Fetches user's referral data from API |
| `startReferralPolling()` | Polls every 30 seconds when connected |
| `copyReferralCode()` | Copies code to clipboard |
| `createReferralCode()` | Requests code creation |
| `registerReferralCode()` | Registers user with referral code |
| `claimReferralRewards()` | Claims pending ASDF rewards |

**New UI Element IDs:**
- `#referral-code-display`, `#referral-code-status`
- `#referral-pending-asdf`, `#referral-your-balance`, `#referral-claimable`
- `#claim-btn`, `#claim-message`
- `#referral-users-count`, `#referral-volume`, `#referral-total-claimed`
- `#register-code-input`, `#register-btn`, `#register-message`

---

### package.json

**New Dependency:**
```json
"@solana/spl-token": "^0.4.14"
```

---

## API Response Examples

**GET /api/referral/stats:**
```json
{
  "isReferrer": true,
  "referralCode": "ASDF1234",
  "referredUsers": 5,
  "totalVolumeGenerated": 125.5,
  "referredBy": "FuLg...miPn",
  "pending": {
    "asReferrerSOL": 0.125,
    "asUserSOL": 0.055,
    "totalASDF": 18000,
    "totalClaimedASDF": 5000
  },
  "claim": {
    "userASDF_Balance": 50000,
    "claimableASDF": 18000,
    "asdfPriceSOL": 0.00001
  }
}
```

---

## Testing

```bash
# Test referral stats
curl "http://localhost:3000/api/referral/stats?user=YOUR_PUBKEY"

# Create/get referral code
curl "http://localhost:3000/api/referral/code?user=YOUR_PUBKEY"

# Register with code
curl -X POST http://localhost:3000/api/referral/register \
  -H "Content-Type: application/json" \
  -d '{"user":"YOUR_PUBKEY","code":"ASDF1234"}'

# Claim rewards
curl -X POST http://localhost:3000/api/referral/claim \
  -H "Content-Type: application/json" \
  -d '{"user":"YOUR_PUBKEY"}'
```

---

## Migration Notes

- No database migration needed - uses JSON file storage
- Referral data auto-initializes on first run
- Existing users can create referral codes if they hold enough ASDF
- Rewards start accumulating immediately for referred users

---

---

## Version 121.0 - Lottery System with Activity Requirement

### Overview

This update introduces a weekly ASDF lottery system designed to reward long-term holders who actively participate in the platform. The system is built to be ungameable and follows a libertarian philosophy - no artificial barriers, just organic engagement.

---

## New Features

### 1. Weekly ASDF Lottery

**Eligibility Requirements:**
- Hold >= 0.00552% of ASDF circulating supply (~52,255 ASDF at current supply)
- Play on the platform at least once in the last 7 days

**Ticket Calculation:**
```
baseTickets = 1 + weeksHolding (max 52)
activityMultiplier = activeDays / 7
effectiveTickets = baseTickets * activityMultiplier
```

**Example:**
| Holding Duration | Active Days | Base Tickets | Multiplier | Effective Tickets |
|-----------------|-------------|--------------|------------|-------------------|
| 10 weeks | 7/7 | 11 | 100% | 11 |
| 10 weeks | 5/7 | 11 | 71% | 8 |
| 10 weeks | 0/7 | 11 | 0% | 0 (ineligible) |

**Prize Pool:**
```
prize = BASE_PRIZE (100,000 ASDF) + (totalTickets * 10,000 ASDF)
```

---

## Files Modified

### server.js

**New Constants (lines 44-53):**
```javascript
const LOTTERY_CONFIG = {
    ELIGIBILITY_PERCENT: 0.0000552,  // 0.00552% of supply
    MAX_TICKETS: 52,
    DRAW_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,  // 7 days
    ACTIVITY_WINDOW_DAYS: 7,
    BASE_PRIZE: 100000,
    PRIZE_PER_TICKET: 10000,
    SUPPLY_CACHE_MS: 5 * 60 * 1000
};
```

**New Functions:**
| Function | Purpose |
|----------|---------|
| `recordUserActivity(pubKey)` | Records daily activity when user places bet |
| `calculateActivityMultiplier(activityDays)` | Returns 0-1 based on days active |
| `getCirculatingSupply()` | On-chain query for ASDF supply |
| `getUserASDFBalance(pubKey)` | On-chain query for user's ASDF balance |
| `checkLotteryEligibility(pubKey)` | Checks if user meets threshold |
| `calculateTickets(user)` | Returns base + effective tickets |
| `getTokenAccountFirstTransaction(connection, address)` | Finds first tx for holding duration |
| `getEligibleParticipants()` | Scans all on-chain holders with activity |
| `executeLotteryDraw()` | Runs the lottery draw with mutex protection |
| `checkLotterySchedule()` | Scheduled task for auto-draws |

**New API Endpoints:**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/lottery/status` | GET | Current round, countdown, config |
| `/api/lottery/eligibility?user=` | GET | User's eligibility, tickets, activity |
| `/api/lottery/history` | GET | Past draws |
| `/api/admin/lottery/draw` | POST | Manual draw trigger (admin only) |

**New Data Files:**
- `data/lottery_state.json` - Current round state
- `data/lottery_history.json` - Draw history

---

### frontend.html

**New UI Section (lines 250-305):**
- Lottery panel with round number, countdown timer
- Your tickets display with activity indicator
- Last winner display
- Eligibility status (ELIGIBLE / NEED ACTIVITY / NOT ELIGIBLE)
- "How it works" explanation

**New UI Elements:**
- `#lottery-round` - Current round number
- `#lottery-countdown` - Time until next draw
- `#lottery-tickets` - User's effective ticket count
- `#lottery-activity` - Activity status (X/7 days)
- `#lottery-winner` - Last winner address
- `#lottery-prize` - Last prize amount

---

### control_panel.html

**New Admin Section:**
- Manual lottery draw trigger button
- Displays lottery round, countdown, winner, prize

---

## Security Measures

| Measure | Implementation |
|---------|----------------|
| Race condition prevention | `lotteryMutex` for concurrent draw protection |
| Cryptographic randomness | `crypto.randomInt()` for winner selection |
| Input validation | All pubKeys validated with regex |
| Activity verification | On-chain tx required before activity recorded |
| Admin authentication | Environment variable password |
| Rate limiting | `stateLimiter` on lottery endpoints |

---

## Anti-Gaming Design

**Why it can't be exploited:**

1. **Activity requires real SOL** - Must send actual SOL to house wallet (verified on Solana blockchain)
2. **Wallet splitting loses duration** - New wallets start at 0 weeks
3. **Duration verified on-chain** - First transaction timestamp queried from Solana
4. **No Sybil advantage** - More wallets = less time per wallet = fewer tickets each

---

## Configuration

**Environment Variables:**
```bash
HELIUS_API_KEY=your_api_key      # For Solana RPC
ADMIN_ACTION_PASSWORD=your_pwd   # For admin endpoints
```

**Schedule:**
- Draws every 7 days automatically
- Checked every hour via `setInterval`
- Can be triggered manually via admin endpoint

---

## Testing

```bash
# Test lottery status
curl http://localhost:3000/api/lottery/status

# Test user eligibility
curl "http://localhost:3000/api/lottery/eligibility?user=YOUR_PUBKEY"

# Trigger manual draw (admin)
curl -X POST http://localhost:3000/api/admin/lottery/draw \
  -H "x-admin-secret: YOUR_ADMIN_PASSWORD"
```

---

## Migration Notes

- No database migration needed - uses JSON file storage
- Lottery state auto-initializes on first run
- Existing users automatically tracked on next bet
