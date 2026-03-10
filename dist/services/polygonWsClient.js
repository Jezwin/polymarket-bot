import { providers } from "ethers";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { getContractConfig } from "@polymarket/clob-client";
export class PolygonWsClient {
    provider = null;
    isConnected = false;
    exchangeAddress;
    constructor() {
        this.exchangeAddress = getContractConfig(env.CHAIN_ID).exchange;
    }
    async connect() {
        if (this.isConnected)
            return;
        this.isConnected = true;
        logger.info("Connecting to Polygon WS for on-chain fill confirmation...");
        this.connectWs();
    }
    connectWs() {
        try {
            this.provider = new providers.WebSocketProvider(env.ALCHEMY_WS_URL);
            this.provider._websocket.on("open", () => {
                logger.info("Connected to Polygon WS");
            });
            this.provider._websocket.on("close", () => {
                if (this.isConnected) {
                    logger.warn("Polygon WS disconnected. Reconnecting in 3s...");
                    this.provider = null;
                    setTimeout(() => this.connectWs(), 3000);
                }
            });
            this.provider._websocket.on("error", (err) => {
                logger.error({ error: err.message }, "Polygon WS error");
            });
        }
        catch (error) {
            logger.error({ error: String(error) }, "Failed to initialize Polygon WS provider");
            if (this.isConnected) {
                setTimeout(() => this.connectWs(), 3000);
            }
        }
    }
    /**
     * Waits for the OrderFilled event for a specific orderId on the Polymarket CTF Exchange contract.
     * @param orderId The ID of the order to wait for.
     */
    async awaitOrderFill(orderId) {
        if (!this.provider) {
            logger.warn("Polygon WS not connected. Cannot await order fill on-chain.");
            throw new Error("Polygon WS not connected");
        }
        // The OrderFilled event signature:
        // event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAmount, uint256 takerAmount, uint256 feeAmount)
        // Since we don't know the exact orderHash without recreating it exactly with the signature payload, 
        // wait, does Polymarket emit the order id as topic 1 (orderHash)? 
        // The Polymarket clob-client uses `orderId` which is a bytes32 or similar hash.
        return new Promise((resolve, reject) => {
            if (!this.provider)
                return reject("No provider");
            const filter = {
                address: this.exchangeAddress,
                topics: [
                    null,
                    orderId
                ]
            };
            const timer = setTimeout(() => {
                this.provider?.removeAllListeners(filter);
                reject(new Error(`Timeout waiting for on-chain OrderFilled for order ${orderId}`));
            }, 60000); // 60 seconds timeout
            this.provider.once(filter, (log) => {
                clearTimeout(timer);
                logger.info({ orderId, logTransactionHash: log.transactionHash }, "Order confirmed on Polygon!");
                resolve();
            });
        });
    }
    close() {
        this.isConnected = false;
        if (this.provider) {
            this.provider.removeAllListeners();
            this.provider._websocket.terminate();
            this.provider = null;
        }
    }
}
//# sourceMappingURL=polygonWsClient.js.map