# Polymarket 5-Minute Crypto Trading Bot

Production-ready TypeScript bot for Polymarket CLOB that:

- Discovers BTC/ETH/SOL/XRP 5-minute markets from Gamma API
- Uses the initial REST market snapshot at startup to detect the currently live cycle
- Targets the 4th upcoming cycle from startup detection
- Places 2 limit BUY orders per market (YES + NO outcome token)
- Uses price `$0.04` and size `5` shares
- Places at `startTime - 15 minutes`

## Project Structure

```text
polymarket-bot/
  src/
    config/
      env.ts
    services/
      clobClient.ts
      marketDiscovery.ts
      orderService.ts
    scheduler/
      orderScheduler.ts
    utils/
      logger.ts
      retry.ts
      time.ts
    types/
      market.ts
      order.ts
    index.ts
  .env
  package.json
  tsconfig.json
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Fill `.env` with your credentials:

```dotenv
POLY_PRIVATE_KEY=
POLY_API_KEY=
POLY_API_SECRET=
POLY_PASSPHRASE=
POLY_ADDRESS=

CLOB_API_URL=https://clob.polymarket.com
CHAIN_ID=137

MARKET_POLL_INTERVAL_SECONDS=30
DISCOVERY_MARKET_LIMIT=200
TARGET_MARKET_COUNT=4
STARTUP_MARKET_LOOKAHEAD_CYCLES=4

ORDER_PRICE=0.04
ORDER_SIZE=5
ORDER_PLACE_MINUTES_BEFORE_START=15

LOG_LEVEL=info
```

## Run

```bash
npm run start
```

## Useful Commands

```bash
npm run typecheck
npm run build
```

## Notes

- The bot uses official Polymarket CLOB client (`@polymarket/clob-client`) and authenticated Level-2 headers via your API credentials.
- Duplicate order protection is implemented through in-memory keys and open-order matching per market/token/price/size.
- API operations use retry with exponential backoff.
- Balance and allowance are checked before placement.
- Structured logs are emitted via `pino`.
