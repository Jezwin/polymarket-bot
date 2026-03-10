import { OrderType, Side } from "@polymarket/clob-client";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { toUtcMillis } from "../utils/time.js";
const PRICE_TOLERANCE = 1e-9;
const extractOrderId = (response) => {
    if (!response || typeof response !== "object") {
        return undefined;
    }
    const asRecord = response;
    if (typeof asRecord.orderID === "string") {
        return asRecord.orderID;
    }
    if (Array.isArray(asRecord.responses) && asRecord.responses.length > 0) {
        const nested = asRecord.responses[0];
        if (typeof nested?.orderID === "string") {
            return nested.orderID;
        }
    }
    return undefined;
};
const hasActiveRemainingSize = (order) => {
    const originalSize = Number(order.original_size);
    const matchedSize = Number(order.size_matched);
    return Number.isFinite(originalSize) && Number.isFinite(matchedSize) && originalSize - matchedSize > 0;
};
const matchesTargetOrder = (order, tokenId) => {
    if (order.asset_id !== tokenId || order.side !== Side.BUY || !hasActiveRemainingSize(order)) {
        return false;
    }
    const orderPrice = Number(order.price);
    const orderSize = Number(order.original_size);
    return (Number.isFinite(orderPrice) &&
        Number.isFinite(orderSize) &&
        Math.abs(orderPrice - env.ORDER_PRICE) <= PRICE_TOLERANCE &&
        Math.abs(orderSize - env.ORDER_SIZE) <= PRICE_TOLERANCE);
};
export class OrderService {
    clobClientService;
    fillListener;
    placementKeys = new Set();
    tokenToStartTime = new Map();
    constructor(clobClientService, fillListener) {
        this.clobClientService = clobClientService;
        this.fillListener = fillListener;
    }
    makePlacementKey(marketId, tokenId) {
        return `${marketId}:${tokenId}:${env.ORDER_PRICE}:${env.ORDER_SIZE}`;
    }
    async getMaxWalletOrderStartTimeMs(marketDiscoveryService) {
        const client = this.clobClientService.getClient();
        const conditionIds = new Set();
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
        }
        catch (error) {
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
        }
        catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to fetch trades for history check");
        }
        let maxStartTimeMs;
        for (const conditionId of conditionIds) {
            try {
                const startTimeMs = await marketDiscoveryService.getMarketStartTimeByConditionId(conditionId);
                if (startTimeMs !== undefined) {
                    if (maxStartTimeMs === undefined || startTimeMs > maxStartTimeMs) {
                        maxStartTimeMs = startTimeMs;
                    }
                }
            }
            catch (error) {
                logger.warn({ conditionId, error: error instanceof Error ? error.message : String(error) }, "Failed to fetch market start time for history check");
            }
        }
        return maxStartTimeMs;
    }
    async placeOrdersForMarket(market) {
        const client = this.clobClientService.getClient();
        const desiredOrders = [
            { leg: "YES", tokenId: market.yesTokenId },
            { leg: "NO", tokenId: market.noTokenId },
        ];
        const tokenIdsToWatch = desiredOrders.map(d => d.tokenId);
        this.fillListener.subscribeToTokens(tokenIdsToWatch);
        const requiredUsdc = env.ORDER_PRICE * env.ORDER_SIZE * desiredOrders.length;
        await this.clobClientService.assertSufficientBalance(requiredUsdc);
        const openOrders = await withRetry(() => client.getOpenOrders({ market: market.conditionId }), {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: "get-open-orders",
            onRetry: (attempt, error, delayMs) => {
                logger.warn({
                    marketId: market.marketId,
                    conditionId: market.conditionId,
                    attempt,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                }, "Failed to fetch open orders; retrying");
            },
        });
        const trackedOrders = [];
        for (const desired of desiredOrders) {
            const placementKey = this.makePlacementKey(market.conditionId, desired.tokenId);
            this.tokenToStartTime.set(desired.tokenId, toUtcMillis(market.startTime));
            if (this.placementKeys.has(placementKey)) {
                logger.info({
                    marketId: market.marketId,
                    tokenId: desired.tokenId,
                    leg: desired.leg,
                }, "Skipping duplicate placement (already tracked in-memory)");
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
                logger.info({
                    marketId: market.marketId,
                    conditionId: market.conditionId,
                    orderId: existingOrder.id,
                    tokenId: desired.tokenId,
                    leg: desired.leg,
                }, "Found existing matching open order; reusing for tracking");
                continue;
            }
            this.placementKeys.add(placementKey);
            try {
                const creationConfig = await this.clobClientService.getOrderCreationConfig(desired.tokenId);
                const expirationTs = Math.floor(toUtcMillis(market.startTime) / 1_000) + env.ORDER_EXPIRATION_SECONDS;
                const response = await withRetry(() => client.createAndPostOrder({
                    tokenID: desired.tokenId,
                    price: env.ORDER_PRICE,
                    size: env.ORDER_SIZE,
                    side: Side.BUY,
                    expiration: expirationTs,
                }, {
                    tickSize: creationConfig.tickSize,
                    negRisk: creationConfig.negRisk,
                }, OrderType.GTD), {
                    attempts: env.MAX_RETRIES,
                    baseDelayMs: env.RETRY_BASE_DELAY_MS,
                    label: "create-and-post-order",
                    onRetry: (attempt, error, delayMs) => {
                        logger.warn({
                            marketId: market.marketId,
                            conditionId: market.conditionId,
                            tokenId: desired.tokenId,
                            leg: desired.leg,
                            attempt,
                            delayMs,
                            error: error instanceof Error ? error.message : String(error),
                        }, "Order placement failed; retrying");
                    },
                });
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
                logger.info({
                    marketId: market.marketId,
                    conditionId: market.conditionId,
                    orderId,
                    tokenId: desired.tokenId,
                    leg: desired.leg,
                    price: env.ORDER_PRICE,
                    size: env.ORDER_SIZE,
                }, "Limit order placed");
            }
            catch (error) {
                this.placementKeys.delete(placementKey);
                logger.error({
                    marketId: market.marketId,
                    conditionId: market.conditionId,
                    tokenId: desired.tokenId,
                    leg: desired.leg,
                    error: error instanceof Error ? error.message : String(error),
                }, "Failed to place limit order for leg");
            }
        }
        if (trackedOrders.length === 0) {
            throw new Error(`No orders placed or reused for market ${market.marketId}`);
        }
        for (const order of trackedOrders) {
            this.fillListener.trackOrder(order.orderId, order.tokenId, order.size, Side.BUY);
        }
        return trackedOrders;
    }
    async placeSellOrder(tokenId, price, size) {
        const client = this.clobClientService.getClient();
        // We add 4 minutes to the market start time logic
        const marketStartMs = this.tokenToStartTime.get(tokenId);
        let expirationTs;
        if (marketStartMs !== undefined) {
            expirationTs = Math.floor(marketStartMs / 1000) + 4 * 60;
        }
        else {
            // Fallback if we don't have the startTime for some reason
            expirationTs = Math.floor(Date.now() / 1000) + env.ORDER_EXPIRATION_SECONDS;
            logger.warn({ tokenId }, "Market start time not found for token id, using fallback expiration");
        }
        const creationConfig = await this.clobClientService.getOrderCreationConfig(tokenId);
        logger.info({ tokenId, price, size, expirationTs }, "Placing SELL limit order via fill listener");
        const response = await withRetry(() => client.createAndPostOrder({
            tokenID: tokenId,
            price: price,
            size: size,
            side: Side.SELL, // Sell side to unload the filled purchase
            expiration: expirationTs,
        }, {
            tickSize: creationConfig.tickSize,
            negRisk: creationConfig.negRisk,
        }, OrderType.GTD), {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: "create-and-post-sell-order",
            onRetry: (attempt, error, delayMs) => {
                logger.warn({
                    tokenId,
                    price,
                    size,
                    attempt,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                }, "Sell order placement failed; retrying");
            },
        });
        const orderId = extractOrderId(response);
        if (!orderId) {
            const serialized = JSON.stringify(response);
            throw new Error(`Sell Order placement succeeded with unknown response format: ${serialized}`);
        }
        this.fillListener.trackOrder(orderId, tokenId, size, Side.SELL);
        logger.info({ orderId, tokenId, price, size }, "Sell limit order placed successfully");
        console.log(`\n===========================================`);
        console.log(`🚀 SELL LIMIT ORDER PLACED!`);
        console.log(`Order ID: ${orderId}`);
        console.log(`Token: ${tokenId} | Size: ${size} | Price: $${price}`);
        console.log(`===========================================\n`);
    }
}
//# sourceMappingURL=orderService.js.map