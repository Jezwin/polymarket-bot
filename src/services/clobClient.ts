import {
  AssetType,
  Chain,
  ClobClient,
  type OrderBookSummary,
  SignatureType,
  getContractConfig,
  type ApiKeyCreds,
  type TickSize,
} from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

const USDC_DECIMALS = 1_000_000;

const normalizePrivateKey = (privateKey: string): string =>
  privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;

const parseUsdcMaybe = (raw: unknown): number | null => {
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
  } catch {
    const fallback = Number(value);
    return Number.isFinite(fallback) ? fallback : null;
  }
};

const parseUsdcBalance = (raw: unknown, fieldName: string): number => {
  const parsed = parseUsdcMaybe(raw);
  if (parsed === null) {
    throw new Error(
      `Invalid ${fieldName} in balance response. Expected string/number/bigint but received ${typeof raw}`,
    );
  }

  return parsed;
};

const collectAllowanceCandidates = (input: unknown): number[] => {
  const result: number[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
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
      for (const nested of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }

  return result;
};

export interface BalanceSnapshot {
  balanceUsdc: number;
  allowanceUsdc: number;
}

export interface OrderBookSnapshot {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  tickSize: number;
  lastTradePrice?: number;
}

export class ClobClientService {
  private readonly client: ClobClient;
  private readonly signerAddress: string;
  private readonly collateralTokenAddress: string;
  private readonly tickSizeCache = new Map<string, TickSize>();
  private readonly negRiskCache = new Map<string, boolean>();
  private zeroBalanceHintLogged = false;

  constructor() {
    const signer = new Wallet(normalizePrivateKey(env.POLY_PRIVATE_KEY));
    this.signerAddress = signer.address;
    this.collateralTokenAddress = getContractConfig(env.CHAIN_ID).collateral;

    const creds: ApiKeyCreds = {
      key: env.POLY_API_KEY,
      secret: env.POLY_API_SECRET,
      passphrase: env.POLY_PASSPHRASE,
    };

    this.client = new ClobClient(
      env.CLOB_API_URL,
      env.CHAIN_ID as Chain,
      signer,
      creds,
      env.POLY_SIGNATURE_TYPE as SignatureType,
      env.POLY_ADDRESS,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      true,
    );

    if (
      env.POLY_SIGNATURE_TYPE === 0 &&
      this.signerAddress.toLowerCase() !== env.POLY_ADDRESS.toLowerCase()
    ) {
      logger.warn(
        {
          signerAddress: this.signerAddress,
          polyAddress: env.POLY_ADDRESS,
          signatureType: env.POLY_SIGNATURE_TYPE,
        },
        "POLY_ADDRESS does not match private key signer for signature type 0",
      );
    }
  }

  getClient(): ClobClient {
    return this.client;
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  async healthcheck(): Promise<void> {
    await withRetry(
      async () => {
        await this.client.getOk();
      },
      {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "clob-healthcheck",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "CLOB healthcheck failed; retrying",
          );
        },
      },
    );
  }

  async getBalanceSnapshot(): Promise<BalanceSnapshot> {
    const response = await withRetry(
      () =>
        this.client.getBalanceAllowance({
          asset_type: AssetType.COLLATERAL,
        }),
      {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "balance-check",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Balance check failed; retrying",
          );
        },
      },
    );

    if (!response || typeof response !== "object") {
      throw new Error("Invalid balance response from CLOB API");
    }

    const responseRecord = response as unknown as Record<string, unknown>;
    const balanceRaw = responseRecord.balance;
    const allowanceRaw = responseRecord.allowance;

    if (balanceRaw === undefined) {
      throw new Error(`Balance response missing 'balance' field. Received: ${JSON.stringify(response)}`);
    }

    let allowanceUsdc: number;
    if (allowanceRaw !== undefined) {
      allowanceUsdc = parseUsdcBalance(allowanceRaw, "allowance");
    } else {
      const candidates = collectAllowanceCandidates(responseRecord.allowances);
      if (candidates.length === 0) {
        throw new Error(
          `Balance response missing both 'allowance' and usable 'allowances' values. Received: ${JSON.stringify(response)}`,
        );
      }
      allowanceUsdc = Math.max(...candidates);
      logger.warn(
        {
          allowanceCandidates: candidates.length,
          selectedAllowanceUsdc: allowanceUsdc,
        },
        "Using derived allowance from 'allowances' response field",
      );
    }

    const snapshot = {
      balanceUsdc: parseUsdcBalance(balanceRaw, "balance"),
      allowanceUsdc,
    };

    if (!this.zeroBalanceHintLogged && snapshot.balanceUsdc === 0 && snapshot.allowanceUsdc === 0) {
      this.zeroBalanceHintLogged = true;
      logger.warn(
        {
          signerAddress: this.signerAddress,
          polyAddress: env.POLY_ADDRESS,
          signatureType: env.POLY_SIGNATURE_TYPE,
          chainId: env.CHAIN_ID,
          collateralToken: this.collateralTokenAddress,
        },
        "Zero USDC collateral balance/allowance. Check that this exact address is funded on Polygon with collateral token",
      );
    }

    return snapshot;
  }

  async assertSufficientBalance(requiredUsdc: number): Promise<void> {
    let snapshot = await this.getBalanceSnapshot();

    if (snapshot.balanceUsdc < requiredUsdc) {
      throw new Error(
        `Insufficient USDC balance. Required=${requiredUsdc.toFixed(4)} available=${snapshot.balanceUsdc.toFixed(4)}`,
      );
    }

    if (snapshot.allowanceUsdc < requiredUsdc) {
      logger.warn(
        {
          requiredUsdc,
          currentAllowanceUsdc: snapshot.allowanceUsdc,
        },
        "USDC allowance is below required amount; attempting allowance update",
      );

      await withRetry(
        () =>
          this.client.updateBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
          }),
        {
          attempts: env.MAX_RETRIES,
          baseDelayMs: env.RETRY_BASE_DELAY_MS,
          label: "update-balance-allowance",
          onRetry: (attempt, error, delayMs) => {
            logger.warn(
              {
                attempt,
                delayMs,
                error: error instanceof Error ? error.message : String(error),
              },
              "Allowance update failed; retrying",
            );
          },
        },
      );

      snapshot = await this.getBalanceSnapshot();
    }

    if (snapshot.allowanceUsdc < requiredUsdc) {
      throw new Error(
        `Insufficient USDC allowance. Required=${requiredUsdc.toFixed(4)} available=${snapshot.allowanceUsdc.toFixed(4)}`,
      );
    }
  }

  async getOrderCreationConfig(tokenId: string): Promise<{ tickSize: TickSize; negRisk: boolean }> {
    const tickSize =
      this.tickSizeCache.get(tokenId) ??
      (await withRetry(() => this.client.getTickSize(tokenId), {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "tick-size",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              tokenId,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Tick size fetch failed; retrying",
          );
        },
      }));

    const negRisk =
      this.negRiskCache.get(tokenId) ??
      (await withRetry(() => this.client.getNegRisk(tokenId), {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "neg-risk",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              tokenId,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Neg-risk fetch failed; retrying",
          );
        },
      }));

    this.tickSizeCache.set(tokenId, tickSize);
    this.negRiskCache.set(tokenId, negRisk);

    return { tickSize, negRisk };
  }

  async getOrderBookSnapshot(tokenId: string): Promise<OrderBookSnapshot> {
    const book = await withRetry(
      () => this.client.getOrderBook(tokenId),
      {
        attempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: "order-book",
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            {
              tokenId,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Order book fetch failed; retrying",
          );
        },
      },
    );

    return this.parseOrderBookSnapshot(tokenId, book);
  }

  async getFeeRateBps(tokenId: string): Promise<number> {
    try {
      return await withRetry(
        () => this.client.getFeeRateBps(tokenId),
        {
          attempts: env.MAX_RETRIES,
          baseDelayMs: env.RETRY_BASE_DELAY_MS,
          label: "fee-rate",
        },
      );
    } catch {
      return env.DEFAULT_FEE_RATE_BPS;
    }
  }

  private parseOrderBookSnapshot(tokenId: string, book: OrderBookSummary): OrderBookSnapshot {
    const bestBid = book.bids.length > 0 ? Number(book.bids[0]?.price) : undefined;
    const bestAsk = book.asks.length > 0 ? Number(book.asks[0]?.price) : undefined;
    const tickSize = Number(book.tick_size || "0.01");
    const lastTradePrice = book.last_trade_price ? Number(book.last_trade_price) : undefined;

    return {
      tokenId,
      bestBid: Number.isFinite(bestBid) ? bestBid : undefined,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : undefined,
      tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01,
      lastTradePrice: Number.isFinite(lastTradePrice) ? lastTradePrice : undefined,
    };
  }
}
