# ASDForecast

Prediction market platform on Solana for SOL price movements with ASDF token lottery system.

## Features

- **15-minute price prediction frames** - Bet UP or DOWN on SOL price
- **Dynamic pricing** - Share prices adjust based on market demand
- **ASDF Lottery** - Weekly draws for eligible ASDF holders
- **Referral Flywheel** - 552 SYMMETRY rewards for referrers and referred users
- **On-chain ASDF price** - Direct price calculation from PumpSwap pool reserves
- **Sentiment voting** - Daily community sentiment polls
- **Real-time updates** - Live price feeds via Pyth Oracle

## Quick Start

### Prerequisites
- Node.js >= 14.0.0
- Helius API key (for Solana RPC)

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file:

```env
# Required
HELIUS_API_KEY=your_helius_api_key

# Required for payouts (JSON string of Solana keypair)
SOLANA_WALLET_JSON={"privateKey":[...]}

# Required for admin endpoints
ADMIN_ACTION_PASSWORD=your_secure_password

# Optional
PORT=3000
COINGECKO_API_KEY=your_coingecko_key
```

### Running

```bash
# Production
npm start

# Development (with file server for frontend)
node server.js &
python3 -m http.server 8080
```

### Access

- **Frontend**: http://localhost:8080/frontend.html
- **Admin Panel**: http://localhost:8080/control_panel.html
- **Monitor Widget**: http://localhost:8080/status_monitor_widget.html
- **API**: http://localhost:3000/api/state

## API Endpoints

### Public
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Current game state |
| `/api/verify-bet` | POST | Verify a bet transaction |
| `/api/sentiment/vote` | POST | Submit sentiment vote |
| `/api/lottery/status` | GET | Lottery status |
| `/api/lottery/eligibility` | GET | Check wallet eligibility |
| `/api/lottery/history` | GET | Past lottery draws |

### Admin (requires `x-admin-secret` header)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/toggle-pause` | POST | Pause/unpause market |
| `/api/admin/cancel-frame` | POST | Cancel current frame |
| `/api/admin/broadcast` | POST | Set broadcast message |
| `/api/admin/lottery/draw` | POST | Trigger manual lottery draw |

## Lottery System

- **Eligibility**: Hold 0.00552% of ASDF circulating supply
- **Max Tickets**: 52 per holder
- **Activity Bonus**: 7-day activity window multiplier
- **Draw Interval**: Weekly (every 7 days)
- **Prizes**: Base 100,000 ASDF + 10,000 per ticket in pool

## Project Structure

```
├── server.js              # Main backend (Express + Solana)
├── frontend.html          # User interface
├── control_panel.html     # Admin dashboard
├── status_monitor_widget.html  # OBS/streaming widget
├── data/                  # Persistent data (gitignored)
│   ├── state.json
│   ├── history.json
│   ├── lottery_state.json
│   └── users/
└── package.json
```

## Version

- **Backend**: v147.0
- **Frontend**: v122.0

## License

Proprietary - All rights reserved
