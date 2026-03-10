import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
export class CancelService {
    clobClientService;
    constructor(clobClientService) {
        this.clobClientService = clobClientService;
    }
    async cancelOrdersForMarket(market, trackedOrders) {
        const client = this.clobClientService.getClient();
        const uniqueOrderIds = [...new Set(trackedOrders.map((order) => order.orderId))];
        if (uniqueOrderIds.length === 0) {
            logger.info({
                marketId: market.marketId,
                conditionId: market.conditionId,
            }, "No tracked open orders to cancel for market");
            return;
        }
        for (const orderId of uniqueOrderIds) {
            try {
                await withRetry(() => client.cancelOrder({ orderID: orderId }), {
                    attempts: env.MAX_RETRIES,
                    baseDelayMs: env.RETRY_BASE_DELAY_MS,
                    label: "cancel-order",
                    onRetry: (attempt, error, delayMs) => {
                        logger.warn({
                            marketId: market.marketId,
                            conditionId: market.conditionId,
                            orderId,
                            attempt,
                            delayMs,
                            error: error instanceof Error ? error.message : String(error),
                        }, "Cancel order failed; retrying");
                    },
                });
                logger.info({
                    marketId: market.marketId,
                    conditionId: market.conditionId,
                    orderId,
                }, "Order cancelled");
            }
            catch (error) {
                logger.error({
                    marketId: market.marketId,
                    conditionId: market.conditionId,
                    orderId,
                    error: error instanceof Error ? error.message : String(error),
                }, "Order cancellation failed");
            }
        }
    }
}
//# sourceMappingURL=cancelService.js.map