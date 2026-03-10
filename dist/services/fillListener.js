import { logger } from "../utils/logger.js";
import { Side } from "@polymarket/clob-client";
import WebSocket from "ws";
import { env } from "../config/env.js";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
export class FillListener {
    placeSellFn;
    polygonWsClient;
    isConnected = false;
    ws = null;
    activeOrders = new Map();
    clobClientService = null; // Kept for interface compatibility
    constructor(placeSellFn, polygonWsClient) {
        this.placeSellFn = placeSellFn;
        this.polygonWsClient = polygonWsClient;
    }
    setClobClient(clobClient) {
        this.clobClientService = clobClient;
    }
    async connect() {
        if (this.isConnected)
            return;
        this.isConnected = true;
        logger.info("Connecting to Polymarket WS for Fill Tracking...");
        this.connectWs();
    }
    connectWs() {
        this.ws = new WebSocket(WS_URL);
        this.ws.on("open", () => {
            logger.info("Connected to Polymarket WS (User Channel)");
            // Subscribe to the user channel directly with raw credentials
            this.ws?.send(JSON.stringify({
                type: "user",
                auth: {
                    apiKey: env.POLY_API_KEY,
                    secret: env.POLY_API_SECRET,
                    passphrase: env.POLY_PASSPHRASE
                }
            }));
        });
        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            }
            catch (err) {
                logger.error({ error: String(err) }, "WS message parse error");
            }
        });
        this.ws.on("close", () => {
            if (this.isConnected) {
                logger.warn("WS disconnected. Reconnecting in 3s...");
                setTimeout(() => this.connectWs(), 3000);
            }
        });
        this.ws.on("error", (err) => {
            logger.error({ error: err.message }, "WS error");
        });
    }
    subscribeToTokens(tokenIds) {
        // Obsolete in user channel model
    }
    trackOrder(orderId, tokenId, size, side) {
        if (this.activeOrders.has(orderId))
            return;
        this.activeOrders.set(orderId, {
            orderId,
            tokenId,
            targetSize: size,
            matchedSize: 0,
            side
        });
        logger.info({ orderId, tokenId, size, side }, "Added order to WS FillTracker");
    }
    handleMessage(msg) {
        if (msg.event === "error" || msg.type === "error") {
            logger.error({ msg }, "WS error message");
            return;
        }
        if (msg.event === "auth_success" || msg.type === "auth_success") {
            logger.info("WS authenticated successfully");
            return;
        }
        // Polymarket user channel events use 'event_type' instead of 'type' for fills
        if (msg.event_type !== "trade" && msg.event_type !== "order")
            return;
        this.handleFill(msg);
    }
    handleFill(msg) {
        let orderId = "";
        let fillSize = 0;
        let tokenId = msg.asset_id; // Polymarket uses asset_id for the token
        // Extract orderId and fill size based on whether it's a trade match or order update
        if (msg.event_type === "trade") {
            const isTaker = this.activeOrders.has(msg.taker_order_id);
            if (isTaker) {
                orderId = msg.taker_order_id;
                fillSize = Number(msg.size);
            }
            else if (msg.maker_orders && Array.isArray(msg.maker_orders)) {
                // If we were the maker, search through maker_orders
                const makerOrder = msg.maker_orders.find((m) => this.activeOrders.has(m.order_id));
                if (makerOrder) {
                    orderId = makerOrder.order_id;
                    fillSize = Number(makerOrder.matched_amount);
                }
                else {
                    return; // Not tracking this order
                }
            }
            else {
                return;
            }
        }
        else if (msg.event_type === "order") {
            orderId = msg.id; // For 'order' events, id is the orderId
            const tracked = this.activeOrders.get(orderId);
            if (!tracked)
                return;
            // 'size_matched' is the cumulative total, calculate incremental fill 
            const newMatchedSize = Number(msg.size_matched);
            fillSize = newMatchedSize - tracked.matchedSize;
            // Ignore updates that don't increase matched size (e.g. initial placement)
            if (fillSize <= 0)
                return;
        }
        const tracked = this.activeOrders.get(orderId);
        if (!tracked)
            return;
        tracked.matchedSize += fillSize;
        logger.info({ orderId, tokenId, fillSize, totalMatched: tracked.matchedSize, side: tracked.side }, "WS Order Fill Detected!");
        console.log(`\n===========================================`);
        console.log(`💰 ${tracked.side} ORDER FILL DETECTED (WS)!`);
        console.log(`Token: ${tokenId} | Fill Size: ${fillSize}`);
        console.log(`===========================================\n`);
        const isFullyFilled = tracked.matchedSize >= tracked.targetSize;
        // trigger sell at 0.20 if it was a buy order that completely filled
        if (tracked.side === Side.BUY && isFullyFilled) {
            const SELL_PRICE = 0.20;
            const SELL_SIZE = 5;
            // Note: handleFill is synchronous but we can fire and forget an async operation for the sell flow
            (async () => {
                try {
                    logger.info({ orderId }, "Waiting for final order confirmation on Polygon...");
                    await this.polygonWsClient.awaitOrderFill(orderId);
                    await this.placeSellFn(tokenId, SELL_PRICE, SELL_SIZE);
                }
                catch (error) {
                    logger.error({
                        orderId,
                        error: error instanceof Error ? error.message : String(error)
                    }, "Failed to confirm and trigger sell after WS fill detection");
                }
            })();
        }
        if (isFullyFilled) {
            fetch('https://ntfy.sh/polymarketOrderFill', { method: 'POST', body: 'Order filled' }).catch(console.error);
            this.activeOrders.delete(orderId);
            logger.info({ orderId }, "Tracking removed (Order Closed/Filled via WS)");
            console.log("Order fully filled, removed from WS tracking\n");
        }
    }
    close() {
        this.isConnected = false;
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.activeOrders.clear();
    }
}
//# sourceMappingURL=fillListener.js.map