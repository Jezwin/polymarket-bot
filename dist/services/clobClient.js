import { AssetType, ClobClient, getContractConfig, } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
const USDC_DECIMALS = 1_000_000;
const normalizePrivateKey = (privateKey) => privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
const parseUsdcMaybe = (raw) => {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") {
        return null;
    }
    const value = String(raw).trim();
    if (!value) {
        return null;
    }
    if (value.includes(".")) {
        const parsedDecimal = Number(value);
        return Number.isFinite(parsedDecimal) ? parsedDecimal : null;
    }
    try {
        return Number(BigInt(value)) / USDC_DECIMALS;
    }
    catch {
        const fallback = Number(value);
        return Number.isFinite(fallback) ? fallback : null;
    }
};
const parseUsdcBalance = (raw, fieldName) => {
    const parsed = parseUsdcMaybe(raw);
    if (parsed === null) {
        throw new Error(`Invalid ${fieldName} in balance response. Expected string/number/bigint but received ${typeof raw}`);
    }
    return parsed;
};
const collectAllowanceCandidates = (input) => {
    const result = [];
    const stack = [{ value: input, depth: 0 }];
    const MAX_DEPTH = 8;
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        const parsed = parseUsdcMaybe(current.value);
        if (parsed !== null) {
            result.push(parsed);
            continue;
        }
        if (current.depth >= MAX_DEPTH) {
            continue;
        }
        if (Array.isArray(current.value)) {
            for (const item of current.value) {
                stack.push({ value: item, depth: current.depth + 1 });
            }
            continue;
        }
        if (current.value && typeof current.value === "object") {
            for (const nested of Object.values(current.value)) {
                stack.push({ value: nested, depth: current.depth + 1 });
            }
        }
    }
    return result;
};
export class ClobClientService {
    client;
    signerAddress;
    collateralTokenAddress;
    tickSizeCache = new Map();
    negRiskCache = new Map();
    zeroBalanceHintLogged = false;
    constructor() {
        const signer = new Wallet(normalizePrivateKey(env.POLY_PRIVATE_KEY));
        this.signerAddress = signer.address;
        this.collateralTokenAddress = getContractConfig(env.CHAIN_ID).collateral;
        const creds = {
            key: env.POLY_API_KEY,
            secret: env.POLY_API_SECRET,
            passphrase: env.POLY_PASSPHRASE,
        };
        this.client = new ClobClient(env.CLOB_API_URL, env.CHAIN_ID, signer, creds, env.POLY_SIGNATURE_TYPE, env.POLY_ADDRESS, undefined, undefined, undefined, undefined, true, undefined, true);
        if (env.POLY_SIGNATURE_TYPE === 0 &&
            this.signerAddress.toLowerCase() !== env.POLY_ADDRESS.toLowerCase()) {
            logger.warn({
                signerAddress: this.signerAddress,
                polyAddress: env.POLY_ADDRESS,
                signatureType: env.POLY_SIGNATURE_TYPE,
            }, "POLY_ADDRESS does not match private key signer for signature type 0");
        }
    }
    getClient() {
        return this.client;
    }
    getSignerAddress() {
        return this.signerAddress;
    }
    async healthcheck() {
        await withRetry(async () => {
            await this.client.getOk();
        }, {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: "clob-healthcheck",
            onRetry: (attempt, error, delayMs) => {
                logger.warn({
                    attempt,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                }, "CLOB healthcheck failed; retrying");
            },
        });
    }
    async getBalanceSnapshot() {
        const response = await withRetry(() => this.client.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        }), {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: "balance-check",
            onRetry: (attempt, error, delayMs) => {
                logger.warn({
                    attempt,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                }, "Balance check failed; retrying");
            },
        });
        if (!response || typeof response !== "object") {
            throw new Error("Invalid balance response from CLOB API");
        }
        const responseRecord = response;
        const balanceRaw = responseRecord.balance;
        const allowanceRaw = responseRecord.allowance;
        if (balanceRaw === undefined) {
            throw new Error(`Balance response missing 'balance' field. Received: ${JSON.stringify(response)}`);
        }
        let allowanceUsdc;
        if (allowanceRaw !== undefined) {
            allowanceUsdc = parseUsdcBalance(allowanceRaw, "allowance");
        }
        else {
            const candidates = collectAllowanceCandidates(responseRecord.allowances);
            if (candidates.length === 0) {
                throw new Error(`Balance response missing both 'allowance' and usable 'allowances' values. Received: ${JSON.stringify(response)}`);
            }
            allowanceUsdc = Math.max(...candidates);
            logger.warn({
                allowanceCandidates: candidates.length,
                selectedAllowanceUsdc: allowanceUsdc,
            }, "Using derived allowance from 'allowances' response field");
        }
        const snapshot = {
            balanceUsdc: parseUsdcBalance(balanceRaw, "balance"),
            allowanceUsdc,
        };
        if (!this.zeroBalanceHintLogged && snapshot.balanceUsdc === 0 && snapshot.allowanceUsdc === 0) {
            this.zeroBalanceHintLogged = true;
            logger.warn({
                signerAddress: this.signerAddress,
                polyAddress: env.POLY_ADDRESS,
                signatureType: env.POLY_SIGNATURE_TYPE,
                chainId: env.CHAIN_ID,
                collateralToken: this.collateralTokenAddress,
            }, "Zero USDC collateral balance/allowance. Check that this exact address is funded on Polygon with collateral token");
        }
        return snapshot;
    }
    async assertSufficientBalance(requiredUsdc) {
        let snapshot = await this.getBalanceSnapshot();
        if (snapshot.balanceUsdc < requiredUsdc) {
            throw new Error(`Insufficient USDC balance. Required=${requiredUsdc.toFixed(4)} available=${snapshot.balanceUsdc.toFixed(4)}`);
        }
        if (snapshot.allowanceUsdc < requiredUsdc) {
            logger.warn({
                requiredUsdc,
                currentAllowanceUsdc: snapshot.allowanceUsdc,
            }, "USDC allowance is below required amount; attempting allowance update");
            await withRetry(() => this.client.updateBalanceAllowance({
                asset_type: AssetType.COLLATERAL,
            }), {
                attempts: env.MAX_RETRIES,
                baseDelayMs: env.RETRY_BASE_DELAY_MS,
                label: "update-balance-allowance",
                onRetry: (attempt, error, delayMs) => {
                    logger.warn({
                        attempt,
                        delayMs,
                        error: error instanceof Error ? error.message : String(error),
                    }, "Allowance update failed; retrying");
                },
            });
            snapshot = await this.getBalanceSnapshot();
        }
        if (snapshot.allowanceUsdc < requiredUsdc) {
            throw new Error(`Insufficient USDC allowance. Required=${requiredUsdc.toFixed(4)} available=${snapshot.allowanceUsdc.toFixed(4)}`);
        }
    }
    async getOrderCreationConfig(tokenId) {
        const tickSize = this.tickSizeCache.get(tokenId) ??
            (await withRetry(() => this.client.getTickSize(tokenId), {
                attempts: env.MAX_RETRIES,
                baseDelayMs: env.RETRY_BASE_DELAY_MS,
                label: "tick-size",
                onRetry: (attempt, error, delayMs) => {
                    logger.warn({
                        tokenId,
                        attempt,
                        delayMs,
                        error: error instanceof Error ? error.message : String(error),
                    }, "Tick size fetch failed; retrying");
                },
            }));
        const negRisk = this.negRiskCache.get(tokenId) ??
            (await withRetry(() => this.client.getNegRisk(tokenId), {
                attempts: env.MAX_RETRIES,
                baseDelayMs: env.RETRY_BASE_DELAY_MS,
                label: "neg-risk",
                onRetry: (attempt, error, delayMs) => {
                    logger.warn({
                        tokenId,
                        attempt,
                        delayMs,
                        error: error instanceof Error ? error.message : String(error),
                    }, "Neg-risk fetch failed; retrying");
                },
            }));
        this.tickSizeCache.set(tokenId, tickSize);
        this.negRiskCache.set(tokenId, negRisk);
        return { tickSize, negRisk };
    }
}
//# sourceMappingURL=clobClient.js.map