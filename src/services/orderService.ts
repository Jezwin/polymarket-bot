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
import { notify } from "../utils/notify.js";

interface DesiredOrder {
  leg: MarketLeg;
  tokenId: string;
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

const matchesTargetOrder = (order: OpenOrder, tokenId: string): boolean => {
  if (order.asset_id !== tokenId || order.side !== Side.BUY || !hasActiveRemainingSize(order)) {
    return false;
  }

  const orderPrice = Number(order.price);
  const orderSize = Number(order.original_size);

  return (
    Number.isFinite(orderPrice) &&
    Number.isFinite(orderSize) &&
    Math.abs(orderPrice - env.ORDER_PRICE) <= PRICE_TOLERANCE &&
    Math.abs(orderSize - env.ORDER_SIZE) <= PRICE_TOLERANCE
  );
};

export class OrderService {
  private readonly placementKeys = new Set<string>();
  private readonly tokenToMarketDetails = new Map<string, { startMs: number, endMs: number, recurrence: string }>();

  constructor(
    private readonly clobClientService: ClobClientService,
    private readonly fillListener: FillListener,
  ) { }

  private makePlacementKey(marketId: string, tokenId: string): string {
    return `${marketId}:${tokenId}:${env.ORDER_PRICE}:${env.ORDER_SIZE}`;
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

  async placeOrdersForMarket(market: DiscoveredMarket): Promise<TrackedOrder[]> {
    const client = this.clobClientService.getClient();
    const desiredOrders: DesiredOrder[] = [
      { leg: "YES", tokenId: market.yesTokenId },
      { leg: "NO", tokenId: market.noTokenId },
    ];

    const tokenIdsToWatch = desiredOrders.map(d => d.tokenId);
    this.fillListener.subscribeToTokens(tokenIdsToWatch);

    const requiredUsdc = env.ORDER_PRICE * env.ORDER_SIZE * desiredOrders.length;
    await this.clobClientService.assertSufficientBalance(requiredUsdc);

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

    for (const desired of desiredOrders) {
      const placementKey = this.makePlacementKey(market.conditionId, desired.tokenId);
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
        continue;
      }

      const existingOrder = openOrders.find((order) => matchesTargetOrder(order, desired.tokenId));
      if (existingOrder) {
        this.placementKeys.add(placementKey);
        trackedOrders.push({
          orderId: existingOrder.id,
          marketId: market.marketId,
          conditionId: market.conditionId,
          tokenId: desired.tokenId,
          price: env.ORDER_PRICE,
          size: env.ORDER_SIZE,
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
                price: env.ORDER_PRICE,
                size: env.ORDER_SIZE,
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
          price: env.ORDER_PRICE,
          size: env.ORDER_SIZE,
          leg: desired.leg,
        });

        logger.info(
          {
            marketId: market.marketId,
            conditionId: market.conditionId,
            orderId,
            tokenId: desired.tokenId,
            leg: desired.leg,
            price: env.ORDER_PRICE,
            size: env.ORDER_SIZE,
          },
          "Limit order placed",
        );

        void notify(
          "BUY Limit Order Placed 🟢",
          `Market: ${market.symbol}\nLeg: ${desired.leg}\nPrice: $${env.ORDER_PRICE}\nSize: ${env.ORDER_SIZE} shares\nTime: ${market.startTime}`,
          ["green_circle"]
        );
      } catch (error) {
        this.placementKeys.delete(placementKey);
        logger.error(
          {
            marketId: market.marketId,
            conditionId: market.conditionId,
            tokenId: desired.tokenId,
            leg: desired.leg,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to place limit order for leg",
        );
      }
    }

    if (trackedOrders.length === 0) {
      logger.info(
        { marketId: market.marketId, conditionId: market.conditionId },
        "All legs already placed or skipped for market",
      );
      return trackedOrders;
    }

    for (const order of trackedOrders) {
      this.fillListener.trackOrder(order.orderId, order.tokenId, order.size, Side.BUY);
    }

    return trackedOrders;
  }

  async placeSellOrder(tokenId: string, price: number, size: number): Promise<void> {
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

    logger.info({ tokenId, price, size, expirationTs }, "Placing SELL limit order via fill listener");

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

    void notify(
      "SELL Limit Order Placed 🔴",
      `Token: ${tokenId}\nPrice: $${price}\nSize: ${size} shares\nOrder ID: ${orderId.slice(0, 8)}...`,
      ["red_circle"]
    );

    console.log(`\n===========================================`);
    console.log(`🚀 SELL LIMIT ORDER PLACED!`);
    console.log(`Order ID: ${orderId}`);
    console.log(`Token: ${tokenId} | Size: ${size} | Price: $${price}`);
    console.log(`===========================================\n`);
  }
}
