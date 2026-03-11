import { logger, fillsLogger } from "../utils/logger.js";
import { Side } from "@polymarket/clob-client";
import WebSocket from "ws";
import { env } from "../config/env.js";
import type { PositionManager } from "./positionManager.js";
import { notify } from "../utils/notify.js";

interface TrackedOrder {
    orderId: string;
    tokenId: string;
    targetSize: number;
    matchedSize: number;
    side: Side;
}

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";

export class FillListener {
    private isConnected = false;
    private ws: WebSocket | null = null;
    private activeOrders = new Map<string, TrackedOrder>();

    constructor(
        private readonly positionManager: PositionManager
    ) { }

    public async connect(): Promise<void> {
        if (this.isConnected) return;
        this.isConnected = true;

        logger.info("Connecting to Polymarket WS for Fill Tracking...");
        this.connectWs();
    }

    private connectWs() {
        this.ws = new WebSocket(WS_URL);

        this.ws.on("open", () => {
            logger.info("Connected to Polymarket WS (User Channel)");

            // Subscribe to the user channel directly with raw credentials
            this.ws?.send(
                JSON.stringify({
                    type: "user",
                    auth: {
                        apiKey: env.POLY_API_KEY,
                        secret: env.POLY_API_SECRET,
                        passphrase: env.POLY_PASSPHRASE
                    }
                })
            );
        });

        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch (err) {
                logger.error({ error: String(err) }, "WS message parse error");
            }
        });

        this.ws.on("close", () => {
            if (this.isConnected) {
                logger.warn("WS disconnected. Reconnecting in 3s...");
                setTimeout(() => this.connectWs(), 3000);
            }
        });

        this.ws.on("error", (err: Error) => {
            logger.error({ error: err.message }, "WS error");
        });
    }

    public subscribeToTokens(tokenIds: string[]): void {
        // Obsolete in user channel model
    }

    public trackOrder(orderId: string, tokenId: string, size: number, side: Side, matchedSize = 0) {
        if (this.activeOrders.has(orderId)) return;

        this.activeOrders.set(orderId, {
            orderId,
            tokenId,
            targetSize: size,
            matchedSize,
            side
        });

        logger.info({ orderId, tokenId, size, side, matchedSize }, "Added order to WS FillTracker");
    }

    private handleMessage(msg: any) {
        if (msg.event === "error" || msg.type === "error") {
            logger.error(
              {
                event: msg.event,
                type: msg.type,
                eventType: msg.event_type,
                message: typeof msg.message === "string" ? msg.message : undefined,
              },
              "WS error message",
            );
            return;
        }

        if (msg.event === "auth_success" || msg.type === "auth_success") {
            logger.info("WS authenticated successfully");
            return;
        }

        // Polymarket user channel events use 'event_type' instead of 'type' for fills
        if (msg.event_type !== "trade" && msg.event_type !== "order") return;

        this.handleFill(msg);
    }

    private handleFill(msg: any) {
        let orderId = "";
        let fillSize = 0;

        // Order updates are the canonical fill source because size_matched is cumulative.
        if (msg.event_type === "trade") {
            return;
        }

        if (msg.event_type === "order") {
            orderId = msg.id;

            const tracked = this.activeOrders.get(orderId);
            if (!tracked) return;

            const newMatchedSize = Number(msg.size_matched);
            fillSize = newMatchedSize - tracked.matchedSize;

            if (fillSize <= 0) return;
            tracked.matchedSize = newMatchedSize;
        }

        const tracked = this.activeOrders.get(orderId);
        if (!tracked) return;

        const tokenId = tracked.tokenId;

        if (isNaN(fillSize) || fillSize <= 0) return;

        logger.info({ orderId, tokenId, fillSize, totalMatched: tracked.matchedSize, side: tracked.side }, "WS Order Fill Detected!");
        fillsLogger.info(
          { 
            orderId, 
            tokenId, 
            fillSize, 
            matchedSize: tracked.matchedSize, 
            targetSize: tracked.targetSize, 
            side: tracked.side,
            isFullyFilled: tracked.matchedSize >= tracked.targetSize
          },
          `Order ${tracked.matchedSize >= tracked.targetSize ? 'Fully' : 'Partially'} Filled: ${tracked.side} | Progress: ${tracked.matchedSize.toFixed(2)} / ${tracked.targetSize} Shares`
        );

        const isFullyFilled = tracked.matchedSize >= tracked.targetSize;

        if (isFullyFilled) {
          void notify(
            `Full Fill: ${tracked.side}`,
            `Order ${orderId.slice(0, 8)}... fully filled.`,
            ["check"],
          );
        }

        void this.positionManager.onOrderFillProgress({
            orderId,
            tokenId,
            side: tracked.side,
            fillSize,
            cumulativeMatchedSize: tracked.matchedSize,
            targetSize: tracked.targetSize,
        });

        if (isFullyFilled) {
            this.activeOrders.delete(orderId);
            logger.info({ orderId }, "Tracking removed (Order Closed/Filled via WS)");
        }
    }

    public close(): void {
        this.isConnected = false;
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.activeOrders.clear();
    }
}
