import { env } from "../config/env.js";
import { MarketDiscoveryService } from "../services/marketDiscovery.js";
import { OrderService, type PaperTradeSchedulerContext } from "../services/orderService.js";
import type { PositionManager } from "../services/positionManager.js";
import type { CryptoSymbol, DiscoveredMarket } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { floorToFiveMinuteBucketUtc, floorToFifteenMinuteBucketUtc, formatIso, toUtcMillis } from "../utils/time.js";

const REQUIRED_SYMBOLS: readonly CryptoSymbol[] = ["BTC", "ETH", "SOL", "XRP"];

export class OrderScheduler {
  private intervalHandle?: NodeJS.Timeout;
  private tickInProgress = false;
  private lastTickStartedMs?: number;

  // ─── 5-minute cycle state (original) ───
  private maxWalletStartTimeMs: number = 0;
  private currentCycleStartMs?: number;
  private lastMissingSymbolsSignature = "";
  private readonly cyclePlacedMarkets = new Set<string>();

  // ─── 15-minute cycle state ───
  private maxWallet15mStartTimeMs: number = 0;
  private current15mCycleStartMs?: number;
  private lastMissing15mSymbolsSignature = "";
  private readonly cycle15mPlacedMarkets = new Set<string>();

  constructor(
    private readonly marketDiscoveryService: MarketDiscoveryService,
    private readonly orderService: OrderService,
    private readonly positionManager?: PositionManager,
  ) { }

  async start(): Promise<void> {
    logger.info(
      {
        pollIntervalSeconds: env.MARKET_POLL_INTERVAL_SECONDS,
        requiredSymbols: REQUIRED_SYMBOLS,
        lookaheadCycles5m: env.STARTUP_MARKET_LOOKAHEAD_CYCLES,
        lookaheadCycles15m: env.FIFTEEN_MIN_LOOKAHEAD_CYCLES,
      },
      "Starting order scheduler (5m + 15m)",
    );

    const maxMs = await this.orderService.getMaxWalletOrderStartTimeMs(this.marketDiscoveryService);
    const walletMaxMs = maxMs ?? 0;
    this.maxWalletStartTimeMs = walletMaxMs;
    this.maxWallet15mStartTimeMs = walletMaxMs;

    logger.info(
      { maxWalletStartTimeIso: formatIso(walletMaxMs) },
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
    const tickStartedMs = Date.now();
    const tickId = `scheduler:${tickStartedMs}`;
    const actualIntervalMs =
      this.lastTickStartedMs === undefined ? undefined : tickStartedMs - this.lastTickStartedMs;
    this.lastTickStartedMs = tickStartedMs;
    const tickContext: Omit<PaperTradeSchedulerContext, "cycleLabel" | "targetCycleStartMs"> = {
      tickId,
      schedulerTickStartedMs: tickStartedMs,
      schedulerExpectedIntervalMs: env.MARKET_POLL_INTERVAL_SECONDS * 1_000,
      schedulerActualIntervalMs: actualIntervalMs,
    };

    try {
      const discoveredMarkets = await this.marketDiscoveryService.discoverMarkets();
      const now = tickStartedMs;

      await this.positionManager?.manageOpenEntries(now);
      await this.process5mCycle(discoveredMarkets, now, tickContext);
      await this.process15mCycle(discoveredMarkets, now, tickContext);
      await this.positionManager?.manageOpenExits(now);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Scheduler tick failed",
      );
    } finally {
      this.orderService.completePaperTick(tickId, Date.now());
      this.tickInProgress = false;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  5-minute cycle (original logic, unchanged)
  // ═══════════════════════════════════════════════════════
  private async process5mCycle(
    discoveredMarkets: DiscoveredMarket[],
    now: number,
    tickContext: Omit<PaperTradeSchedulerContext, "cycleLabel" | "targetCycleStartMs">,
  ): Promise<void> {
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
      logger.debug?.(
        {
          targetStartTimeIso: formatIso(targetStartTimeMs),
          unplacedCount: unplacedMarkets.length,
        },
        "Target cycle markets discovered. Placing orders immediately.",
      );

      for (const market of unplacedMarkets) {
        try {
          const placementResult = await this.orderService.placeOrdersForMarket(market, {
            ...tickContext,
            cycleLabel: "5m",
            targetCycleStartMs: targetStartTimeMs,
          });
          const failedLegs = placementResult.legs.filter((leg) => leg.status === "failed");

          if (failedLegs.length === 0) {
            this.cyclePlacedMarkets.add(market.conditionId);
          } else {
            logger.warn(
              {
                marketId: market.marketId,
                conditionId: market.conditionId,
                successfulLegs: placementResult.legs
                  .filter((leg) => leg.status !== "failed")
                  .map((leg) => ({ leg: leg.leg, status: leg.status })),
                failedLegs: failedLegs.map((leg) => ({
                  leg: leg.leg,
                  reason: leg.reason,
                })),
              },
              "Market placement incomplete; will retry failed legs on next tick",
            );
          }
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
  }

  /** Original 5m market selector (unchanged) */
  private selectTargetCycleMarkets(discoveredMarkets: DiscoveredMarket[], targetStartTimeMs: number): DiscoveredMarket[] {
    const selectedBySymbol = new Map<CryptoSymbol, DiscoveredMarket>();

    for (const market of discoveredMarkets) {
      if (market.recurrence !== "5m") {
        continue;
      }

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

  // ═══════════════════════════════════════════════════════
  //  15-minute cycle (new, parallel pipeline)
  // ═══════════════════════════════════════════════════════
  private async process15mCycle(
    discoveredMarkets: DiscoveredMarket[],
    now: number,
    tickContext: Omit<PaperTradeSchedulerContext, "cycleLabel" | "targetCycleStartMs">,
  ): Promise<void> {
    const currentSnapshotBucketMs = floorToFifteenMinuteBucketUtc(now);
    const targetStartTimeMs = currentSnapshotBucketMs + env.FIFTEEN_MIN_LOOKAHEAD_CYCLES * 15 * 60_000;

    const marketsForTargetCycle = this.select15mTargetCycleMarkets(discoveredMarkets, targetStartTimeMs);

    if (marketsForTargetCycle.length < REQUIRED_SYMBOLS.length) {
      return;
    }

    if (this.current15mCycleStartMs !== targetStartTimeMs) {
      this.current15mCycleStartMs = targetStartTimeMs;
      this.cycle15mPlacedMarkets.clear();
    }

    if (targetStartTimeMs <= this.maxWallet15mStartTimeMs) {
      if (this.cycle15mPlacedMarkets.size === 0) {
        logger.info(
          {
            label: "15m",
            targetStartTimeIso: formatIso(targetStartTimeMs),
            maxWalletStartTimeIso: formatIso(this.maxWallet15mStartTimeMs),
          },
          "Skipping 15m order placement for target cycle due to wallet history.",
        );
        this.cycle15mPlacedMarkets.add("SKIPPED");
      }
      return;
    }

    const unplacedMarkets = marketsForTargetCycle.filter(
      (market) => !this.cycle15mPlacedMarkets.has(market.conditionId),
    );

    if (unplacedMarkets.length > 0) {
      logger.debug?.(
        {
          label: "15m",
          targetStartTimeIso: formatIso(targetStartTimeMs),
          unplacedCount: unplacedMarkets.length,
        },
        "15m target cycle markets discovered. Placing orders immediately.",
      );

      for (const market of unplacedMarkets) {
        try {
          const placementResult = await this.orderService.placeOrdersForMarket(market, {
            ...tickContext,
            cycleLabel: "15m",
            targetCycleStartMs: targetStartTimeMs,
          });
          const failedLegs = placementResult.legs.filter((leg) => leg.status === "failed");

          if (failedLegs.length === 0) {
            this.cycle15mPlacedMarkets.add(market.conditionId);
          } else {
            logger.warn(
              {
                label: "15m",
                marketId: market.marketId,
                conditionId: market.conditionId,
                successfulLegs: placementResult.legs
                  .filter((leg) => leg.status !== "failed")
                  .map((leg) => ({ leg: leg.leg, status: leg.status })),
                failedLegs: failedLegs.map((leg) => ({
                  leg: leg.leg,
                  reason: leg.reason,
                })),
              },
              "15m market placement incomplete; will retry failed legs on next tick",
            );
          }
        } catch (error) {
          logger.error(
            {
              label: "15m",
              marketId: market.marketId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to place orders for 15m market",
          );
        }
      }

      if (this.cycle15mPlacedMarkets.size === REQUIRED_SYMBOLS.length) {
        this.maxWallet15mStartTimeMs = targetStartTimeMs;
        logger.info(
          { label: "15m", targetStartTimeIso: formatIso(targetStartTimeMs) },
          "Successfully placed all 15m orders for target cycle.",
        );
      }
    }
  }

  /** 15m market selector — filters by recurrence "15m" and uses 15-minute bucketing */
  private select15mTargetCycleMarkets(discoveredMarkets: DiscoveredMarket[], targetStartTimeMs: number): DiscoveredMarket[] {
    const selectedBySymbol = new Map<CryptoSymbol, DiscoveredMarket>();

    for (const market of discoveredMarkets) {
      if (market.recurrence !== "15m") {
        continue;
      }

      if (floorToFifteenMinuteBucketUtc(toUtcMillis(market.startTime)) !== targetStartTimeMs) {
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

    if (missingSignature !== this.lastMissing15mSymbolsSignature) {
      this.lastMissing15mSymbolsSignature = missingSignature;

      if (missingSymbols.length > 0) {
        logger.warn(
          {
            label: "15m",
            targetStartTimeIso: formatIso(targetStartTimeMs),
            missingSymbols,
            discoveredForTargetCycle: selectedBySymbol.size,
          },
          "Waiting for all 15m target symbols to appear for cycle",
        );
      } else {
        logger.info(
          {
            label: "15m",
            targetStartTimeIso: formatIso(targetStartTimeMs),
            discoveredForTargetCycle: selectedBySymbol.size,
          },
          "All 15m target symbols discovered for cycle",
        );
      }
    }

    return [...selectedBySymbol.values()];
  }
}
