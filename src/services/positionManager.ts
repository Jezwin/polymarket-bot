import { Side } from "@polymarket/clob-client";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { notify } from "../utils/notify.js";
import { ClobClientService } from "./clobClient.js";
import type { FillListener } from "./fillListener.js";
import type { OrderService } from "./orderService.js";
import { PolygonWsClient } from "./polygonWsClient.js";
import { QuoteEngine } from "./quoteEngine.js";
import {
  PositionStore,
  type PersistedOpenExitOrder,
} from "./positionStore.js";

interface RegisterEntryOrderInput {
  orderId: string;
  clientOrderKey: string;
  conditionId: string;
  marketId: string;
  tokenId: string;
  symbol: string;
  leg: string;
  recurrence: string;
  startTimeMs: number;
  endTimeMs: number;
  price: number;
  size: number;
  quoteReason?: string;
}

interface FillProgressInput {
  orderId: string;
  tokenId: string;
  side: Side;
  fillSize: number;
  cumulativeMatchedSize: number;
  targetSize: number;
}

interface SyntheticFillProgressInput extends FillProgressInput {
  eventSource: string;
  eventTimeMs: number;
}

interface PendingPaperExit {
  orderId: string;
  positionId: string;
  tokenId: string;
  size: number;
  targetPrice: number;
  exitReason: string;
}

interface PendingPaperEntry {
  orderId: string;
  positionId: string;
  conditionId: string;
  marketId: string;
  tokenId: string;
  marketName: string;
  symbol: string;
  leg: string;
  recurrence: string;
  size: number;
  targetPrice: number;
  quoteReason: string;
  schedulerTickId: string;
  schedulerCycleLabel: string;
  schedulerTickStartedMs: number;
  schedulerExpectedIntervalMs: number;
  schedulerActualIntervalMs?: number;
  targetCycleStartMs: number;
}

const PRICE_MATCH_EPSILON = 1e-9;

export class PositionManager {
  private readonly exitInFlight = new Set<string>();
  private readonly pendingPaperEntries = new Map<string, PendingPaperEntry>();
  private readonly pendingPaperExits = new Map<string, PendingPaperExit>();
  private orderService: OrderService | null = null;

  constructor(
    private readonly store: PositionStore,
    private readonly clobClientService: ClobClientService,
    private readonly polygonWsClient: PolygonWsClient,
    private readonly quoteEngine: QuoteEngine,
  ) {}

  init(): void {
    this.store.init();
  }

  setOrderService(orderService: OrderService): void {
    this.orderService = orderService;
  }

  getActiveEntryPlacementState(): Array<{
    placementKey: string;
    tokenId: string;
    conditionId: string;
    recurrence: string;
    startTimeMs: number;
    endTimeMs: number;
    price: number;
    size: number;
  }> {
    return this.store.getActiveEntryPlacementKeys();
  }

  registerEntryOrder(input: RegisterEntryOrderInput): void {
    const positionId = this.getPositionId(input.conditionId, input.tokenId);

    this.store.upsertPosition({
      positionId,
      conditionId: input.conditionId,
      marketId: input.marketId,
      tokenId: input.tokenId,
      symbol: input.symbol,
      leg: input.leg,
      recurrence: input.recurrence,
      startTimeMs: input.startTimeMs,
      endTimeMs: input.endTimeMs,
      entryTargetPrice: input.price,
      entryTargetSize: input.size,
      status: "entry_open",
      quoteReason: input.quoteReason,
    });

    this.store.upsertOrder({
      orderId: input.orderId,
      positionId,
      clientOrderKey: input.clientOrderKey,
      tokenId: input.tokenId,
      side: Side.BUY,
      price: input.price,
      size: input.size,
      orderRole: "entry",
      status: "open",
    });
  }

  registerExitOrder(input: {
    orderId: string;
    positionId: string;
    tokenId: string;
    price: number;
    size: number;
  }): void {
    this.store.upsertOrder({
      orderId: input.orderId,
      positionId: input.positionId,
      clientOrderKey: `exit:${input.positionId}`,
      tokenId: input.tokenId,
      side: Side.SELL,
      price: input.price,
      size: input.size,
      orderRole: "exit",
      status: "open",
    });
    this.store.markPositionStatus(input.positionId, "exit_open");
  }

  markExitPlacementFailure(positionId: string, errorMessage: string): void {
    this.store.markPositionStatus(positionId, "error");
    logger.error({ positionId, error: errorMessage }, "Persisted exit placement failure");
    void notify(
      "Exit Placement Failure",
      `Position ${positionId} failed to place an exit order.`,
      ["warning"],
    );
  }

  async rehydrate(fillListener: FillListener): Promise<void> {
    const client = this.clobClientService.getClient();
    const openOrders = await client.getOpenOrders();
    const remoteOpenOrderIds = new Set(openOrders.map((order) => order.id));
    let restoredTrackedOrders = 0;
    let missingRemoteOrders = 0;
    let resumedExitCandidates = 0;

    for (const order of this.store.getTrackedOpenOrders()) {
      if (order.orderRole === "entry") {
        this.orderService?.hydrateTrackedEntryOrder(
          order.conditionId,
          order.tokenId,
          order.startTimeMs,
          order.endTimeMs,
          order.recurrence,
          order.price,
          order.size,
        );
      }

      if (!remoteOpenOrderIds.has(order.orderId)) {
        logger.warn({ orderId: order.orderId }, "Persisted open order missing from exchange open orders during rehydrate");
        missingRemoteOrders += 1;
        continue;
      }

      fillListener.trackOrder(order.orderId, order.tokenId, order.size, order.side as Side, order.matchedSize);
      restoredTrackedOrders += 1;
    }

    for (const position of this.store.getExitCandidates()) {
      if (this.store.hasOpenExitOrder(position.positionId)) {
        continue;
      }

      void this.triggerExitForPosition(position.positionId, position.tokenId, position.filledSize);
      resumedExitCandidates += 1;
    }

    logger.info(
      {
        restoredTrackedOrders,
        missingRemoteOrders,
        resumedExitCandidates,
      },
      "Position manager rehydrate summary",
    );
  }

  async simulateOrderFill(input: SyntheticFillProgressInput): Promise<void> {
    await this.applyFillProgress(input, input.eventSource, input.eventTimeMs);
  }

  async onOrderFillProgress(input: FillProgressInput): Promise<void> {
    await this.applyFillProgress(input, "polymarket-user-ws", Date.now());
  }

  async onDryRunMarketTrade(input: {
    tokenId: string;
    price: number;
    eventTimeMs: number;
  }): Promise<void> {
    if (!env.DRY_RUN) {
      return;
    }

    const matchingEntries = [...this.pendingPaperEntries.values()].filter(
      (order) => order.tokenId === input.tokenId && input.price <= order.targetPrice + PRICE_MATCH_EPSILON,
    );
    const matchingExits = [...this.pendingPaperExits.values()].filter(
      (order) => order.tokenId === input.tokenId && input.price + PRICE_MATCH_EPSILON >= order.targetPrice,
    );

    for (const pendingOrder of matchingEntries) {
      if (!this.pendingPaperEntries.delete(pendingOrder.orderId)) {
        continue;
      }

      await this.completePendingPaperEntry(pendingOrder, input.eventTimeMs, "paper-trade-cross");
    }

    for (const pendingOrder of matchingExits) {
      if (!this.pendingPaperExits.delete(pendingOrder.orderId)) {
        continue;
      }

      await this.completePendingPaperExit(pendingOrder, input.eventTimeMs, "paper-trade-cross");
    }
  }

  registerPendingPaperEntry(input: PendingPaperEntry): void {
    this.pendingPaperEntries.set(input.orderId, input);

    logger.info(
      {
        orderId: input.orderId,
        positionId: input.positionId,
        tokenId: input.tokenId,
        targetPrice: input.targetPrice,
        size: input.size,
        quoteReason: input.quoteReason,
      },
      "Registered pending paper entry order",
    );
  }

  async manageOpenEntries(now = Date.now()): Promise<void> {
    if (!env.DRY_RUN || this.pendingPaperEntries.size === 0) {
      return;
    }

    const pendingEntriesByToken = new Map<string, PendingPaperEntry[]>();
    for (const pendingEntry of this.pendingPaperEntries.values()) {
      const existing = pendingEntriesByToken.get(pendingEntry.tokenId);
      if (existing) {
        existing.push(pendingEntry);
      } else {
        pendingEntriesByToken.set(pendingEntry.tokenId, [pendingEntry]);
      }
    }

    for (const [tokenId, pendingEntries] of pendingEntriesByToken.entries()) {
      try {
        const book = await this.clobClientService.getOrderBookSnapshot(tokenId);
        if (book.bestAsk === undefined) {
          continue;
        }

        const fillableEntries = pendingEntries.filter(
          (entry) => book.bestAsk !== undefined && book.bestAsk <= entry.targetPrice + PRICE_MATCH_EPSILON,
        );

        for (const pendingEntry of fillableEntries) {
          if (!this.pendingPaperEntries.delete(pendingEntry.orderId)) {
            continue;
          }

          await this.completePendingPaperEntry(pendingEntry, now, "paper-orderbook-cross");
        }
      } catch (error) {
        logger.warn(
          {
            tokenId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to validate pending paper entry against live order book",
        );
      }
    }
  }

  private async applyFillProgress(
    input: FillProgressInput,
    eventSource: string,
    eventTimeMs: number,
  ): Promise<void> {
    const update = this.store.recordFillProgress({
      orderId: input.orderId,
      fillSize: input.fillSize,
      cumulativeMatchedSize: input.cumulativeMatchedSize,
      eventSource,
      eventTimeMs,
    });

    if (!update) {
      logger.warn({ orderId: input.orderId }, "Received fill progress for unknown persisted order");
      return;
    }

    if (update.orderRole === "entry" && input.side === Side.BUY && update.positionFilledSize > 0) {
      if (update.cumulativeMatchedSize < update.targetSize) {
        await this.cancelOrder(input.orderId, "cancelled");
      }

      const disposition = await this.classifyRemainingInventory(update.positionId, input.tokenId, update.positionFilledSize);
      if (disposition === "exit") {
        await this.triggerExitForPosition(update.positionId, input.tokenId, update.positionFilledSize, input.orderId);
      }
      return;
    }

    if (update.orderRole === "exit" && input.side === Side.SELL) {
      this.pendingPaperExits.delete(input.orderId);
      await this.classifyRemainingInventory(update.positionId, input.tokenId, update.positionFilledSize, input.orderId);
    }
  }

  async manageOpenExits(now = Date.now()): Promise<void> {
    const openExits = this.store.getOpenExitOrders();

    for (const openExit of openExits) {
      if (openExit.filledSize <= 0 || this.exitInFlight.has(openExit.positionId)) {
        continue;
      }

      if (openExit.filledSize < env.MIN_ORDER_SIZE) {
        await this.markDustStranded(openExit.positionId, openExit.tokenId, openExit.filledSize, openExit.orderId);
        continue;
      }

      const ageMs = now - openExit.createdAtMs;
      const staleAgeMs = env.MARKET_POLL_INTERVAL_SECONDS * 2_000;
      const expiryDeadlineMs =
        openExit.recurrence === "15m"
          ? openExit.endTimeMs - 60_000
          : openExit.startTimeMs + 4 * 60_000;
      const nearDeadline = now >= expiryDeadlineMs - env.MARKET_POLL_INTERVAL_SECONDS * 1_000;

      const quote = await this.quoteEngine.buildExitQuote({
        tokenId: openExit.tokenId,
        size: openExit.filledSize,
        entryPrice: openExit.entryPriceActual ?? openExit.entryTargetPrice,
      });

      const shouldRefresh =
        ageMs >= staleAgeMs ||
        Math.abs(quote.price - openExit.price) > 1e-9 ||
        Math.abs(quote.size - openExit.size) > 1e-9 ||
        nearDeadline;

      if (!shouldRefresh) {
        continue;
      }

      const cancelled = await this.cancelOrder(openExit.orderId, "cancelled");
      if (!cancelled) {
        continue;
      }

      const replacementPrice =
        nearDeadline && quote.bestBid !== undefined ? quote.bestBid : quote.price;
      const replacementOrderId = await this.orderService?.placeSellOrder(
        openExit.tokenId,
        replacementPrice,
        quote.size,
        openExit.positionId,
      );

      if (!replacementOrderId) {
        continue;
      }

      this.registerExitOrder({
        orderId: replacementOrderId,
        positionId: openExit.positionId,
        tokenId: openExit.tokenId,
        price: replacementPrice,
        size: quote.size,
      });
      const exitReason = nearDeadline ? "forced-unwind" : quote.quoteReason;
      this.store.markExitReason(openExit.positionId, exitReason);

      if (env.DRY_RUN) {
        await this.handleDryRunExitOrder({
          orderId: replacementOrderId,
          positionId: openExit.positionId,
          tokenId: openExit.tokenId,
          size: quote.size,
          price: replacementPrice,
          bestBid: quote.bestBid,
          exitReason,
        });
      }

      logger.info(
        {
          positionId: openExit.positionId,
          previousOrderId: openExit.orderId,
          replacementOrderId,
          tokenId: openExit.tokenId,
          previousPrice: openExit.price,
          replacementPrice,
          remainingSize: openExit.filledSize,
          nearDeadline,
        },
        "Refreshed stale exit order",
      );
    }
  }

  private async triggerExitForPosition(
    positionId: string,
    tokenId: string,
    size: number,
    entryOrderId?: string,
  ): Promise<void> {
    if (this.exitInFlight.has(positionId)) {
      return;
    }

    if (!this.orderService) {
      logger.error({ positionId }, "OrderService not configured for PositionManager exit flow");
      return;
    }

    if (size <= 0) {
      this.store.markPositionStatus(positionId, "closed");
      logger.warn({ positionId, tokenId, size }, "Skipping exit trigger because persisted size is non-positive");
      return;
    }

    if (size < env.MIN_ORDER_SIZE) {
      await this.markDustStranded(positionId, tokenId, size);
      return;
    }

    if (this.store.hasOpenExitOrder(positionId)) {
      return;
    }

    this.exitInFlight.add(positionId);

    this.store.markPositionStatus(positionId, "exit_pending");

    const position = this.store.getPositionForExit(positionId);
    if (!position) {
      logger.error({ positionId }, "Persisted position not found for exit placement");
      this.exitInFlight.delete(positionId);
      return;
    }

    if (entryOrderId && !env.DRY_RUN) {
      try {
        await this.polygonWsClient.awaitOrderFill(entryOrderId);
      } catch (error) {
        logger.warn(
          {
            positionId,
            entryOrderId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Polygon confirmation failed before exit placement; continuing with persisted exit workflow",
        );
      }
    }

    try {
      const quote = await this.quoteEngine.buildExitQuote({
        tokenId,
        size,
        entryPrice: position.entryPriceActual ?? position.entryTargetPrice,
      });
      const orderId = await this.orderService.placeSellOrder(tokenId, quote.price, quote.size, positionId);

      this.registerExitOrder({
        orderId,
        positionId,
        tokenId,
        price: quote.price,
        size: quote.size,
      });
      this.store.markExitReason(positionId, quote.quoteReason);

      if (env.DRY_RUN) {
        await this.handleDryRunExitOrder({
          orderId,
          positionId,
          tokenId,
          size: quote.size,
          price: quote.price,
          bestBid: quote.bestBid,
          exitReason: quote.quoteReason,
        });
      }

      const updatedPosition = this.store.getPositionForExit(positionId);
      logger.info(
        {
          positionId,
          tokenId,
          entryPrice: position.entryPriceActual ?? position.entryTargetPrice,
          exitQuotePrice: quote.price,
          quoteReason: quote.quoteReason,
          bestBid: quote.bestBid,
          bestAsk: quote.bestAsk,
          fairValue: quote.fairValue,
          realizedPnl: updatedPosition?.realizedPnl,
          realizedSpread: updatedPosition?.realizedSpread,
          holdingTimeMs:
            updatedPosition?.entryFillTimeMs && updatedPosition?.exitFillTimeMs
              ? updatedPosition.exitFillTimeMs - updatedPosition.entryFillTimeMs
              : undefined,
        },
        "Exit lifecycle summary",
      );
    } catch (error) {
      this.markExitPlacementFailure(positionId, error instanceof Error ? error.message : String(error));
    } finally {
      this.exitInFlight.delete(positionId);
    }
  }

  private getPositionId(conditionId: string, tokenId: string): string {
    return `${conditionId}:${tokenId}`;
  }

  private async cancelOrder(orderId: string, nextStatus: "cancelled" | "failed"): Promise<boolean> {
    if (env.DRY_RUN && orderId.startsWith("paper:")) {
      this.pendingPaperEntries.delete(orderId);
      this.pendingPaperExits.delete(orderId);
      this.store.markOrderStatus(orderId, nextStatus);
      return true;
    }

    try {
      await this.clobClientService.getClient().cancelOrder({ orderID: orderId } as any);
      this.store.markOrderStatus(orderId, nextStatus);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.toLowerCase();
      if (
        normalized.includes("not found") ||
        normalized.includes("no such order") ||
        normalized.includes("does not exist")
      ) {
        this.store.markOrderStatus(orderId, "cancelled", message);
        return true;
      }

      logger.warn({ orderId, error: message }, "Failed to cancel order during lifecycle management");
      return false;
    }
  }

  private async handleDryRunExitOrder(input: {
    orderId: string;
    positionId: string;
    tokenId: string;
    size: number;
    price: number;
    bestBid?: number;
    exitReason: string;
  }): Promise<void> {
    if (input.bestBid !== undefined && input.price <= input.bestBid + 1e-9) {
      await this.completePendingPaperExit(
        {
          orderId: input.orderId,
          positionId: input.positionId,
          tokenId: input.tokenId,
          size: input.size,
          targetPrice: input.price,
          exitReason: input.exitReason,
        },
        Date.now(),
        "paper-exit",
      );
      return;
    }

    this.pendingPaperExits.set(input.orderId, {
      orderId: input.orderId,
      positionId: input.positionId,
      tokenId: input.tokenId,
      size: input.size,
      targetPrice: input.price,
      exitReason: input.exitReason,
    });

    logger.info(
      {
        orderId: input.orderId,
        positionId: input.positionId,
        tokenId: input.tokenId,
        targetPrice: input.price,
        size: input.size,
        exitReason: input.exitReason,
      },
      "Registered pending paper exit order",
    );
  }

  private async completePendingPaperEntry(
    pendingOrder: PendingPaperEntry,
    eventTimeMs: number,
    eventSource: string,
  ): Promise<void> {
    this.store.upsertPaperTradeEntry({
      positionId: pendingOrder.positionId,
      conditionId: pendingOrder.conditionId,
      marketId: pendingOrder.marketId,
      tokenId: pendingOrder.tokenId,
      marketName: pendingOrder.marketName,
      symbol: pendingOrder.symbol,
      leg: pendingOrder.leg,
      recurrence: pendingOrder.recurrence,
      schedulerTickId: pendingOrder.schedulerTickId,
      schedulerCycleLabel: pendingOrder.schedulerCycleLabel,
      schedulerTickStartedMs: pendingOrder.schedulerTickStartedMs,
      schedulerExpectedIntervalMs: pendingOrder.schedulerExpectedIntervalMs,
      schedulerActualIntervalMs: pendingOrder.schedulerActualIntervalMs,
      targetCycleStartMs: pendingOrder.targetCycleStartMs,
      entryQuotePrice: pendingOrder.targetPrice,
      entryFillPrice: pendingOrder.targetPrice,
      entrySize: pendingOrder.size,
      quoteReason: pendingOrder.quoteReason,
      entryTimeMs: eventTimeMs,
    });

    await this.simulateOrderFill({
      orderId: pendingOrder.orderId,
      tokenId: pendingOrder.tokenId,
      side: Side.BUY,
      fillSize: pendingOrder.size,
      cumulativeMatchedSize: pendingOrder.size,
      targetSize: pendingOrder.size,
      eventSource,
      eventTimeMs,
    });

    logger.info(
      {
        orderId: pendingOrder.orderId,
        positionId: pendingOrder.positionId,
        tokenId: pendingOrder.tokenId,
        targetPrice: pendingOrder.targetPrice,
        eventSource,
        eventTimeMs,
      },
      "Completed pending paper entry order",
    );
  }

  private async completePendingPaperExit(
    pendingOrder: PendingPaperExit,
    eventTimeMs: number,
    eventSource: string,
  ): Promise<void> {
    await this.simulateOrderFill({
      orderId: pendingOrder.orderId,
      tokenId: pendingOrder.tokenId,
      side: Side.SELL,
      fillSize: pendingOrder.size,
      cumulativeMatchedSize: pendingOrder.size,
      targetSize: pendingOrder.size,
      eventSource,
      eventTimeMs,
    });

    const paperExitPosition = this.store.getPositionForExit(pendingOrder.positionId);
    this.store.finalizePaperTradeExit({
      positionId: pendingOrder.positionId,
      exitQuotePrice: pendingOrder.targetPrice,
      exitFillPrice: pendingOrder.targetPrice,
      exitSize: pendingOrder.size,
      exitReason: pendingOrder.exitReason,
      exitTimeMs: eventTimeMs,
      holdingTimeMs:
        paperExitPosition?.entryFillTimeMs && paperExitPosition?.exitFillTimeMs
          ? paperExitPosition.exitFillTimeMs - paperExitPosition.entryFillTimeMs
          : null,
      realizedSpread: paperExitPosition?.realizedSpread,
      realizedPnl: paperExitPosition?.realizedPnl,
    });

    logger.info(
      {
        orderId: pendingOrder.orderId,
        positionId: pendingOrder.positionId,
        tokenId: pendingOrder.tokenId,
        targetPrice: pendingOrder.targetPrice,
        eventSource,
        eventTimeMs,
      },
      "Completed pending paper exit order",
    );
  }

  private async classifyRemainingInventory(
    positionId: string,
    tokenId: string,
    remainingSize: number,
    currentExitOrderId?: string,
  ): Promise<"closed" | "dust" | "exit"> {
    if (remainingSize <= 0) {
      this.store.markPositionStatus(positionId, "closed");
      return "closed";
    }

    if (remainingSize < env.MIN_ORDER_SIZE) {
      await this.markDustStranded(positionId, tokenId, remainingSize, currentExitOrderId);
      return "dust";
    }

    return "exit";
  }

  private async markDustStranded(
    positionId: string,
    tokenId: string,
    remainingSize: number,
    currentExitOrderId?: string,
  ): Promise<void> {
    const exitOrderIds = new Set<string>();
    if (currentExitOrderId) {
      exitOrderIds.add(currentExitOrderId);
    }

    for (const openExit of this.store.getOpenExitOrders()) {
      if (openExit.positionId === positionId) {
        exitOrderIds.add(openExit.orderId);
      }
    }

    for (const orderId of exitOrderIds) {
      await this.cancelOrder(orderId, "cancelled");
    }

    this.store.markDustStranded(positionId, "below-min-order-size");
    logger.warn(
      {
        positionId,
        tokenId,
        remainingSize,
        minOrderSize: env.MIN_ORDER_SIZE,
      },
      "Position stranded as dust inventory below minimum order size",
    );
  }
}
