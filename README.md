# PolyBot

PolyBot is a TypeScript microstructure trading engine for Polymarket CLOB. It is designed to capture spread and queue-position edge through dynamic quoting, not to express directional market views. The bot continuously evaluates short-duration crypto markets, computes a fair value from the live YES/NO books, and selectively posts passive liquidity only when the expected edge remains attractive after fees, adverse selection, and inventory constraints.

## System Overview

The trading model is spread-capture first:

- It does not predict market direction.
- It derives a fair value from live order-book state.
- It quotes only when the expected edge clears configured buffers.
- It manages open inventory as a position lifecycle, not as disconnected orders.

In practice, that means PolyBot behaves more like a market microstructure engine than a simple scripting bot. Entry quotes are dynamic, exit quotes are actively managed, and state survives crashes and restarts.

## Core Architecture

### Quote Engine

`src/services/quoteEngine.ts` drives the quoting logic. It:

- reads live order-book state from the Polymarket CLOB,
- derives fair value from the YES/NO market pair,
- applies fee-adjusted edge thresholds,
- adds an adverse-selection buffer,
- outputs quote decisions for entries and exits.

### Durable State

`src/services/positionStore.ts` is the SQLite-backed source of truth for:

- positions,
- entry and exit orders,
- fill progression,
- realized PnL and spread telemetry.

This is what makes the bot crash-resilient. Open orders and inventory are not held only in memory anymore.

### Position Lifecycle

`src/services/positionManager.ts` owns the transition logic between:

- entry pending,
- entry open,
- partially filled,
- exit pending,
- exit open,
- closed.

It also handles crash recovery, exit orchestration, and active stale-exit management.

### Scheduler

`src/scheduler/orderScheduler.ts` runs the core trading loop on a 15-second cadence. Each tick can:

- discover eligible markets,
- run the quote engine,
- place or skip new entry orders,
- manage open exits,
- reprice or unwind stale inventory.

## Execution And Risk Management

PolyBot now includes the controls required for live operation:

- 15-second polling interval for faster market response without observed scheduler overlap in the clean single-instance benchmark.
- Exact fractional-share handling through the full position lifecycle. Fractional fills are preserved and exited precisely; they are not rounded down and stranded.
- Active stale-exit management. Open exits can be cancelled, repriced, or force-unwound when the quote becomes stale or inventory risk rises.
- Balance-aware dynamic sizing. New orders are sized against live wallet cash instead of assuming full fixed size is always affordable.
- Hard wallet reserve. The bot always keeps 2 USDC untouched, even when sizing otherwise-affordable trades.
- Durable recovery. Restarting the bot does not lose its knowledge of positions, orders, fills, or pending exit work.

## Environment Configuration

The current runtime is controlled through `.env`. The table below highlights the important strategy and execution settings.

| Variable | Current Value | Purpose |
|---|---:|---|
| `MARKET_POLL_INTERVAL_SECONDS` | `15` | Scheduler wake-up cadence for market discovery, quote evaluation, and stale-exit management. |
| `ENTRY_MIN_EDGE_BPS` | `250` | Strategy threshold for minimum entry edge. In the current implementation this is expressed as `ENTRY_EDGE_BUFFER=0.025`. |
| `ADVERSE_SELECTION_BUFFER` | `0.015` | Additional protection against quoting too close to fair value in hostile order books. |
| `ORDER_EXPIRATION_SECONDS` | `45` | Resting lifetime for new entry orders before they become stale. |
| `MIN_RESERVE_USDC` | `2` | Cash buffer that must remain untouched in the wallet at all times. |

Other important live settings:

| Variable | Current Value | Purpose |
|---|---:|---|
| `ORDER_SIZE` | `5` | Default target order size before affordability scaling. |
| `MIN_ORDER_SIZE` | `5` | Exchange-aligned minimum size below which orders are skipped. |
| `ENTRY_EDGE_BUFFER` | `0.025` | Current implementation of the entry edge threshold used by the quote engine. |
| `EXIT_EDGE_BUFFER` | `0.01` | Minimum exit edge target before posting passive sells. |
| `DYNAMIC_QUOTING_ENABLED` | `true` | Enables live fair-value driven quoting instead of static prices. |

## Setup

1. Install dependencies.

```bash
npm install
```

2. Configure `.env` with your wallet and Polymarket API credentials.

Required credentials:

- `POLY_PRIVATE_KEY`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`
- `POLY_ADDRESS`

3. Start the bot.

```bash
npm start
```

## Useful Commands

```bash
npm test
npm run typecheck
```

## Operational Notes

- Run only a single bot instance against the same wallet and SQLite database.
- Treat provider URLs and API credentials as secrets.
- Keep notifications private if you enable them; public topics leak strategy timing and inventory behavior.
- Do not evaluate performance only from quoted orders. Use the SQLite telemetry to measure realized spread, PnL, holding time, and fill quality.

## Deployment Status

PolyBot is no longer a fixed-price prototype. It is a resilient, stateful microstructure engine with:

- dynamic fair-value quoting,
- SQLite-backed durability,
- crash recovery,
- active exit management,
- fractional precision,
- balance-aware sizing,
- strict wallet reserve enforcement.

That is the baseline required before allocating real capital.
