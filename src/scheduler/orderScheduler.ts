import { env } from "../config/env.js";
import { MarketDiscoveryService } from "../services/marketDiscovery.js";
import { OrderService } from "../services/orderService.js";
import type { CryptoSymbol, DiscoveredMarket } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { floorToFiveMinuteBucketUtc, formatIso, toUtcMillis } from "../utils/time.js";

const REQUIRED_SYMBOLS: readonly CryptoSymbol[] = ["BTC", "ETH", "SOL", "XRP"];

export class OrderScheduler {
  private intervalHandle?: NodeJS.Timeout;
  private tickInProgress = false;

  private maxWalletStartTimeMs: number = 0;
  private currentCycleStartMs?: number;
  private lastMissingSymbolsSignature = "";

  private readonly cyclePlacedMarkets = new Set<string>();

  constructor(
    private readonly marketDiscoveryService: MarketDiscoveryService,
    private readonly orderService: OrderService,
  ) { }

  async start(): Promise<void> {
    logger.info(
      {
        pollIntervalSeconds: env.MARKET_POLL_INTERVAL_SECONDS,
        requiredSymbols: REQUIRED_SYMBOLS,
        lookaheadCycles: env.STARTUP_MARKET_LOOKAHEAD_CYCLES,
      },
      "Starting order scheduler",
    );

    const maxMs = await this.orderService.getMaxWalletOrderStartTimeMs(this.marketDiscoveryService);
    this.maxWalletStartTimeMs = maxMs ?? 0;

    logger.info(
      { maxWalletStartTimeIso: formatIso(this.maxWalletStartTimeMs) },
      "Wallet history order check complete",
    );

    await this.tick();

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, env.MARKET_POLL_INTERVAL_SECONDS * 1_000);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) {
      logger.warn("Skipping scheduler tick because previous tick is still running");
      return;
    }

    this.tickInProgress = true;

    try {
      const discoveredMarkets = await this.marketDiscoveryService.discoverMarkets();

      const now = Date.now();
      const currentSnapshotBucketMs = floorToFiveMinuteBucketUtc(now);
      const targetStartTimeMs = currentSnapshotBucketMs + env.STARTUP_MARKET_LOOKAHEAD_CYCLES * 5 * 60_000;

      const marketsForTargetCycle = this.selectTargetCycleMarkets(discoveredMarkets, targetStartTimeMs);

      if (marketsForTargetCycle.length < REQUIRED_SYMBOLS.length) {
        return;
      }

      if (this.currentCycleStartMs !== targetStartTimeMs) {
        this.currentCycleStartMs = targetStartTimeMs;
        this.cyclePlacedMarkets.clear();
      }

      if (targetStartTimeMs <= this.maxWalletStartTimeMs) {
        if (this.cyclePlacedMarkets.size === 0) {
          logger.info(
            {
              targetStartTimeIso: formatIso(targetStartTimeMs),
              maxWalletStartTimeIso: formatIso(this.maxWalletStartTimeMs)
            },
            "Skipping order placement for target cycle due to wallet history. Waiting for next snapshot market change."
          );
          this.cyclePlacedMarkets.add("SKIPPED");
        }
        return;
      }

      const unplacedMarkets = marketsForTargetCycle.filter(
        (market) => !this.cyclePlacedMarkets.has(market.conditionId)
      );

      if (unplacedMarkets.length > 0) {
        logger.info(
          {
            targetStartTimeIso: formatIso(targetStartTimeMs),
            unplacedCount: unplacedMarkets.length,
          },
          "Target cycle markets discovered. Placing orders immediately.",
        );

        for (const market of unplacedMarkets) {
          try {
            await this.orderService.placeOrdersForMarket(market);
            this.cyclePlacedMarkets.add(market.conditionId);
          } catch (error) {
            logger.error(
              {
                marketId: market.marketId,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to place orders for market",
            );
          }
        }

        if (this.cyclePlacedMarkets.size === REQUIRED_SYMBOLS.length) {
          this.maxWalletStartTimeMs = targetStartTimeMs;
          logger.info(
            { targetStartTimeIso: formatIso(targetStartTimeMs) },
            "Successfully placed all orders for target cycle. Waiting for next live market change snapshot.",
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Scheduler tick failed",
      );
    } finally {
      this.tickInProgress = false;
    }
  }

  private selectTargetCycleMarkets(discoveredMarkets: DiscoveredMarket[], targetStartTimeMs: number): DiscoveredMarket[] {
    const selectedBySymbol = new Map<CryptoSymbol, DiscoveredMarket>();

    for (const market of discoveredMarkets) {
      if (floorToFiveMinuteBucketUtc(toUtcMillis(market.startTime)) !== targetStartTimeMs) {
        continue;
      }

      if (!REQUIRED_SYMBOLS.includes(market.symbol)) {
        continue;
      }

      const current = selectedBySymbol.get(market.symbol);
      if (!current || Number(market.marketId) > Number(current.marketId)) {
        selectedBySymbol.set(market.symbol, market);
      }
    }

    const missingSymbols = REQUIRED_SYMBOLS.filter((symbol) => !selectedBySymbol.has(symbol));
    const missingSignature = missingSymbols.join(",");

    if (missingSignature !== this.lastMissingSymbolsSignature) {
      this.lastMissingSymbolsSignature = missingSignature;

      if (missingSymbols.length > 0) {
        logger.warn(
          {
            targetStartTimeIso: formatIso(targetStartTimeMs),
            missingSymbols,
            discoveredForTargetCycle: selectedBySymbol.size,
          },
          "Waiting for all target symbols to appear for cycle",
        );
      } else {
        logger.info(
          {
            targetStartTimeIso: formatIso(targetStartTimeMs),
            discoveredForTargetCycle: selectedBySymbol.size,
          },
          "All target symbols discovered for cycle",
        );
      }
    }

    return [...selectedBySymbol.values()];
  }
}
