import { OrderType, Side, type OpenOrder } from "@polymarket/clob-client";
import { env } from "../config/env.js";
import type { DiscoveredMarket } from "../types/market.js";
import type { MarketLeg, TrackedOrder } from "../types/order.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { toUtcMillis } from "../utils/time.js";
import { ClobClientService } from "./clobClient.js";
import type { FillListener } from "./fillListener.js";
import type { MarketDiscoveryService } from "./marketDiscovery.js";
import type { PositionManager } from "./positionManager.js";
import { QuoteEngine } from "./quoteEngine.js";
import { notify } from "../utils/notify.js";

interface DesiredOrder {
  leg: MarketLeg;
  tokenId: string;
  price: number;
  size: number;
  quoteReason: string;
}

const roundOrderSize = (size: number): number => Number(size.toFixed(6));

export type PlacementLegStatus = "placed" | "reused" | "already_tracked" | "failed";

export interface PlacementLegResult {
  leg: MarketLeg;
  tokenId: string;
  status: PlacementLegStatus;
  orderId?: string;
  reason?: string;
}

export interface PlaceOrdersForMarketResult {
  marketId: string;
  conditionId: string;
  legs: PlacementLegResult[];
}

const PRICE_TOLERANCE = 1e-9;

const extractOrderId = (response: unknown): string | undefined => {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const asRecord = response as Record<string, unknown>;

  if (typeof asRecord.orderID === "string") {
    return asRecord.orderID;
  }

  if (Array.isArray(asRecord.responses) && asRecord.responses.length > 0) {
    const nested = asRecord.responses[0] as Record<string, unknown>;
    if (typeof nested?.orderID === "string") {
      return nested.orderID;
    }
  }

  return undefined;
};

const hasActiveRemainingSize = (order: OpenOrder): boolean => {
  const originalSize = Number(order.original_size);
  const matchedSize = Number(order.size_matched);
  return Number.isFinite(originalSize) && Number.isFinite(matchedSize) && originalSize - matchedSize > 0;
};

const matchesTargetOrder = (order: OpenOrder, tokenId: string, price: number, size: number): boolean => {
  if (order.asset_id !== tokenId || order.side !== Side.BUY || !hasActiveRemainingSize(order)) {
    return false;
  }

  const orderPrice = Number(order.price);
  const orderSize = Number(order.original_size);

  return (
    Number.isFinite(orderPrice) &&
    Number.isFinite(orderSize) &&
    Math.abs(orderPrice - price) <= PRICE_TOLERANCE &&
    Math.abs(orderSize - size) <= PRICE_TOLERANCE
  );
};

export class OrderService {
  private readonly placementKeys = new Set<string>();
  private readonly tokenToMarketDetails = new Map<string, { startMs: number, endMs: number, recurrence: string }>();

  constructor(
    private readonly clobClientService: ClobClientService,
    private readonly fillListener: FillListener,
    private readonly positionManager: PositionManager,
    private readonly quoteEngine: QuoteEngine,
  ) { }

  private makePlacementKey(marketId: string, tokenId: string, price: number, size: number): string {
    return `${marketId}:${tokenId}:${price}:${size}`;
  }

  hydrateTrackedEntryOrder(
    conditionId: string,
    tokenId: string,
    startMs: number,
    endMs: number,
    recurrence: string,
    price: number,
    size: number,
  ): void {
    this.placementKeys.add(this.makePlacementKey(conditionId, tokenId, price, size));
    this.tokenToMarketDetails.set(tokenId, {
      startMs,
      endMs,
      recurrence,
    });
  }

  async getMaxWalletOrderStartTimeMs(marketDiscoveryService: MarketDiscoveryService): Promise<number | undefined> {
    const client = this.clobClientService.getClient();
    const conditionIds = new Set<string>();

    try {
      const openOrders = await withRetry(() => client.getOpenOrders(), {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "get-all-open-orders",
      });

      for (const order of openOrders) {
        if (order.market) {
          conditionIds.add(order.market);
        }
      }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to fetch open orders for history check");
    }

    try {
      const trades = await withRetry(() => client.getTrades({ maker_address: env.POLY_ADDRESS }), {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "get-all-trades",
      });

      for (const trade of trades) {
        if (trade.market) {
          conditionIds.add(trade.market);
        }
      }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to fetch trades for history check");
    }

    let maxStartTimeMs: number | undefined;

    for (const conditionId of conditionIds) {
      try {
        const startTimeMs = await marketDiscoveryService.getMarketStartTimeByConditionId(conditionId);
        if (startTimeMs !== undefined) {
          if (maxStartTimeMs === undefined || startTimeMs > maxStartTimeMs) {
            maxStartTimeMs = startTimeMs;
          }
        }
      } catch (error) {
        logger.warn({ conditionId, error: error instanceof Error ? error.message : String(error) }, "Failed to fetch market start time for history check");
      }
    }

    return maxStartTimeMs;
  }

  async placeOrdersForMarket(market: DiscoveredMarket): Promise<PlaceOrdersForMarketResult> {
    const client = this.clobClientService.getClient();
    const entryQuotes = await Promise.all([
      this.quoteEngine.buildEntryQuote(market, "YES", market.yesTokenId),
      this.quoteEngine.buildEntryQuote(market, "NO", market.noTokenId),
    ]);
    const desiredOrders: DesiredOrder[] = [
      {
        leg: "YES",
        tokenId: market.yesTokenId,
        price: entryQuotes[0].price,
        size: entryQuotes[0].size,
        quoteReason: entryQuotes[0].quoteReason,
      },
      {
        leg: "NO",
        tokenId: market.noTokenId,
        price: entryQuotes[1].price,
        size: entryQuotes[1].size,
        quoteReason: entryQuotes[1].quoteReason,
      },
    ];

    const tokenIdsToWatch = desiredOrders.map(d => d.tokenId);
    this.fillListener.subscribeToTokens(tokenIdsToWatch);

    const balanceSnapshot = await this.clobClientService.getBalanceSnapshot();
    const tradableBalance = balanceSnapshot.balanceUsdc - env.RESERVE_BALANCE_USDC;
    if (tradableBalance <= 0) {
      logger.warn(
        {
          marketId: market.marketId,
          conditionId: market.conditionId,
          availableUsdc: balanceSnapshot.balanceUsdc,
          reserveBalanceUsdc: env.RESERVE_BALANCE_USDC,
          tradableBalance,
        },
        "Skipped entry placement: Account balance is at or below the reserve limit.",
      );
      return {
        marketId: market.marketId,
        conditionId: market.conditionId,
        legs: [],
      };
    }

    let remainingUsdc = tradableBalance;

    for (const [index, desired] of desiredOrders.entries()) {
      const quoteDecision = entryQuotes[index];
      if (!quoteDecision.shouldPlace) {
        continue;
      }

      if (desired.price <= 0) {
        continue;
      }

      const maxAffordableSize = remainingUsdc / desired.price;
      const adjustedSize = roundOrderSize(Math.min(desired.size, maxAffordableSize));

      if (adjustedSize < env.MIN_ORDER_SIZE) {
        entryQuotes[index] = {
          ...quoteDecision,
          shouldPlace: false,
          quoteReason: "insufficient-balance-for-min-order-size",
        };
        logger.info(
          {
            marketId: market.marketId,
            conditionId: market.conditionId,
            tokenId: desired.tokenId,
            leg: desired.leg,
            availableUsdc: balanceSnapshot.balanceUsdc,
            tradableBalance: remainingUsdc,
            reserveBalanceUsdc: env.RESERVE_BALANCE_USDC,
            quotePrice: desired.price,
            targetSize: desired.size,
            maxAffordableSize: roundOrderSize(maxAffordableSize),
            minOrderSize: env.MIN_ORDER_SIZE,
          },
          "Skipped entry placement: insufficient balance for minimum order size",
        );
        continue;
      }

      desired.size = adjustedSize;
      remainingUsdc = Math.max(0, remainingUsdc - desired.price * adjustedSize);
    }

    const activeDesiredOrders = desiredOrders.filter((desired, index) => entryQuotes[index].shouldPlace);
    if (activeDesiredOrders.length === 0) {
      logger.info(
        {
          marketId: market.marketId,
          conditionId: market.conditionId,
          availableUsdc: balanceSnapshot.balanceUsdc,
          tradableBalance,
          minOrderSize: env.MIN_ORDER_SIZE,
          reserveBalanceUsdc: env.RESERVE_BALANCE_USDC,
        },
        "Skipping market placement because no entry legs are affordable",
      );
    }

    const openOrders = await withRetry(
      () => client.getOpenOrders({ market: market.conditionId }),
      {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "get-open-orders",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              marketId: market.marketId,
              conditionId: market.conditionId,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to fetch open orders; retrying",
          );
        },
      },
    );

    const trackedOrders: TrackedOrder[] = [];
    const legResults: PlacementLegResult[] = [];

    for (const desired of desiredOrders) {
      const quoteDecision = desired.leg === "YES" ? entryQuotes[0] : entryQuotes[1];
      if (!quoteDecision.shouldPlace) {
        legResults.push({
          leg: desired.leg,
          tokenId: desired.tokenId,
          status: "already_tracked",
          reason: quoteDecision.quoteReason,
        });
        continue;
      }

      const placementKey = this.makePlacementKey(market.conditionId, desired.tokenId, desired.price, desired.size);
      this.tokenToMarketDetails.set(desired.tokenId, {
        startMs: toUtcMillis(market.startTime),
        endMs: toUtcMillis(market.endTime),
        recurrence: market.recurrence,
      });

      if (this.placementKeys.has(placementKey)) {
        logger.info(
          {
            marketId: market.marketId,
            tokenId: desired.tokenId,
            leg: desired.leg,
          },
          "Skipping duplicate placement (already tracked in-memory)",
        );
        legResults.push({
          leg: desired.leg,
          tokenId: desired.tokenId,
          status: "already_tracked",
          reason: "placement-key-already-tracked",
        });
        continue;
      }

      const existingOrder = openOrders.find((order) =>
        matchesTargetOrder(order, desired.tokenId, desired.price, desired.size),
      );
      if (existingOrder) {
        this.placementKeys.add(placementKey);
        trackedOrders.push({
          orderId: existingOrder.id,
          marketId: market.marketId,
          conditionId: market.conditionId,
          tokenId: desired.tokenId,
          price: desired.price,
          size: desired.size,
          leg: desired.leg,
        });

        logger.info(
          {
            marketId: market.marketId,
            conditionId: market.conditionId,
            orderId: existingOrder.id,
            tokenId: desired.tokenId,
            leg: desired.leg,
          },
          "Found existing matching open order; reusing for tracking",
        );

        legResults.push({
          leg: desired.leg,
          tokenId: desired.tokenId,
          status: "reused",
          orderId: existingOrder.id,
        });

        this.positionManager.registerEntryOrder({
          orderId: existingOrder.id,
          clientOrderKey: placementKey,
          conditionId: market.conditionId,
          marketId: market.marketId,
          tokenId: desired.tokenId,
          symbol: market.symbol,
          leg: desired.leg,
          recurrence: market.recurrence,
          startTimeMs: toUtcMillis(market.startTime),
          endTimeMs: toUtcMillis(market.endTime),
          price: desired.price,
          size: desired.size,
          quoteReason: desired.quoteReason,
        });

        continue;
      }

      this.placementKeys.add(placementKey);

      try {
        const creationConfig = await this.clobClientService.getOrderCreationConfig(desired.tokenId);
        let expirationTs: number;
        if (market.recurrence === "15m") {
          expirationTs = Math.floor(toUtcMillis(market.endTime) / 1000) - 4 * 60;
        } else {
          expirationTs = Math.floor(toUtcMillis(market.startTime) / 1000) + env.ORDER_EXPIRATION_SECONDS;
        }

        const response = await withRetry(
          () =>
            client.createAndPostOrder(
              {
                tokenID: desired.tokenId,
                price: desired.price,
                size: desired.size,
                side: Side.BUY,
                expiration: expirationTs,
              },
              {
                tickSize: creationConfig.tickSize,
                negRisk: creationConfig.negRisk,
              },
              OrderType.GTD,
            ),
          {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: "create-and-post-order",
            onRetry: (attempt, error, delayMs) => {
              logger.warn(
                {
                  marketId: market.marketId,
                  conditionId: market.conditionId,
                  tokenId: desired.tokenId,
                  leg: desired.leg,
                  attempt,
                  delayMs,
                  error: error instanceof Error ? error.message : String(error),
                },
                "Order placement failed; retrying",
              );
            },
          },
        );

        const orderId = extractOrderId(response);
        if (!orderId) {
          const serialized = JSON.stringify(response);
          throw new Error(`Order placement succeeded with unknown response format: ${serialized}`);
        }

        trackedOrders.push({
          orderId,
          marketId: market.marketId,
          conditionId: market.conditionId,
          tokenId: desired.tokenId,
          price: desired.price,
          size: desired.size,
          leg: desired.leg,
        });

        logger.info(
          {
            marketId: market.marketId,
            conditionId: market.conditionId,
            orderId,
            tokenId: desired.tokenId,
            leg: desired.leg,
            price: desired.price,
            size: desired.size,
            quoteReason: desired.quoteReason,
          },
          "Limit order placed",
        );

        legResults.push({
          leg: desired.leg,
          tokenId: desired.tokenId,
          status: "placed",
          orderId,
        });

        this.positionManager.registerEntryOrder({
          orderId,
          clientOrderKey: placementKey,
          conditionId: market.conditionId,
          marketId: market.marketId,
          tokenId: desired.tokenId,
          symbol: market.symbol,
          leg: desired.leg,
          recurrence: market.recurrence,
          startTimeMs: toUtcMillis(market.startTime),
          endTimeMs: toUtcMillis(market.endTime),
          price: desired.price,
          size: desired.size,
          quoteReason: desired.quoteReason,
        });
      } catch (error) {
        this.placementKeys.delete(placementKey);
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            marketId: market.marketId,
            conditionId: market.conditionId,
            tokenId: desired.tokenId,
            leg: desired.leg,
            error: errorMessage,
          },
          "Failed to place limit order for leg",
        );

        legResults.push({
          leg: desired.leg,
          tokenId: desired.tokenId,
          status: "failed",
          reason: errorMessage,
        });
      }
    }

    if (trackedOrders.length === 0) {
      logger.info(
        { marketId: market.marketId, conditionId: market.conditionId },
        "All legs already placed or skipped for market",
      );
      return {
        marketId: market.marketId,
        conditionId: market.conditionId,
        legs: legResults,
      };
    }

    for (const order of trackedOrders) {
      this.fillListener.trackOrder(order.orderId, order.tokenId, order.size, Side.BUY);
    }

    return {
      marketId: market.marketId,
      conditionId: market.conditionId,
      legs: legResults,
    };
  }

  async placeSellOrder(tokenId: string, price: number, size: number, positionId?: string): Promise<string> {
    const client = this.clobClientService.getClient();

    const marketDetails = this.tokenToMarketDetails.get(tokenId);
    let expirationTs: number;

    if (marketDetails !== undefined) {
      if (marketDetails.recurrence === "15m") {
        expirationTs = Math.floor(marketDetails.endMs / 1000) - 1 * 60;
      } else {
        expirationTs = Math.floor(marketDetails.startMs / 1000) + 4 * 60;
      }
    } else {
      // Fallback if we don't have the details for some reason
      expirationTs = Math.floor(Date.now() / 1000) + env.ORDER_EXPIRATION_SECONDS;
      logger.warn({ tokenId }, "Market details not found for token id, using fallback expiration");
    }

    const creationConfig = await this.clobClientService.getOrderCreationConfig(tokenId);

    logger.info({ tokenId, price, size, expirationTs, positionId }, "Placing SELL limit order");

    const response = await withRetry(
      () =>
        client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: price,
            size: size,
            side: Side.SELL, // Sell side to unload the filled purchase
            expiration: expirationTs,
          },
          {
            tickSize: creationConfig.tickSize,
            negRisk: creationConfig.negRisk,
          },
          OrderType.GTD,
        ),
      {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "create-and-post-sell-order",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              tokenId,
              price,
              size,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Sell order placement failed; retrying",
          );
        },
      },
    );

    const orderId = extractOrderId(response);
    if (!orderId) {
      const serialized = JSON.stringify(response);
      throw new Error(`Sell Order placement succeeded with unknown response format: ${serialized}`);
    }

    this.fillListener.trackOrder(orderId, tokenId, size, Side.SELL);

    logger.info(
      { orderId, tokenId, price, size },
      "Sell limit order placed successfully",
    );

    return orderId;
  }
}
