import type { OrderBookSummary, OrderSummary } from "@polymarket/clob-client";
import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { ClobClientService, type OrderBookSnapshot } from "./clobClient.js";

type SideBook = "bid" | "ask";

interface LocalBookState {
  tokenId: string;
  bids: Map<string, number>;
  asks: Map<string, number>;
  bestBid?: number;
  bestAsk?: number;
  tickSize: number;
  lastTradePrice?: number;
  feeRateBps?: number;
  lastUpdatedMs: number;
}

const parseNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseTokenId = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const parseSide = (value: unknown): SideBook | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (normalized === "buy" || normalized === "bid" || normalized === "bids") {
    return "bid";
  }

  if (normalized === "sell" || normalized === "ask" || normalized === "asks") {
    return "ask";
  }

  return undefined;
};

const sortDescending = (left: number, right: number): number => right - left;
const sortAscending = (left: number, right: number): number => left - right;

export class MarketBookService {
  private ws: WebSocket | null = null;
  private connected = false;
  private readonly trackedTokens = new Set<string>();
  private readonly primedTokens = new Set<string>();
  private readonly books = new Map<string, LocalBookState>();
  private repairHandle?: NodeJS.Timeout;

  constructor(private readonly clobClientService: ClobClientService) {}

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.connected = true;
    this.connectWs();
    this.repairHandle = setInterval(() => {
      void this.repairTrackedBooks();
    }, env.MARKET_BOOK_REPAIR_INTERVAL_SECONDS * 1_000);
  }

  close(): void {
    this.connected = false;

    if (this.repairHandle) {
      clearInterval(this.repairHandle);
      this.repairHandle = undefined;
    }

    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }

    this.trackedTokens.clear();
    this.primedTokens.clear();
    this.books.clear();
  }

  async subscribeTokens(tokenIds: string[]): Promise<void> {
    const uniqueTokenIds = [...new Set(tokenIds.filter((tokenId) => tokenId.trim().length > 0))];
    const newlyTracked = uniqueTokenIds.filter((tokenId) => !this.trackedTokens.has(tokenId));

    for (const tokenId of uniqueTokenIds) {
      this.trackedTokens.add(tokenId);
    }

    await Promise.all(newlyTracked.map(async (tokenId) => {
      await this.primeToken(tokenId);
      this.primedTokens.add(tokenId);
    }));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription();
    }
  }

  getSnapshot(tokenId: string): OrderBookSnapshot | null {
    const book = this.books.get(tokenId);
    if (!book) {
      return null;
    }

    return {
      tokenId,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      tickSize: book.tickSize,
      lastTradePrice: book.lastTradePrice,
    };
  }

  getFeeRateBps(tokenId: string): number {
    return this.books.get(tokenId)?.feeRateBps ?? env.DEFAULT_FEE_RATE_BPS;
  }

  private connectWs(): void {
    this.ws = new WebSocket(env.MARKET_WS_URL);

    this.ws.on("open", () => {
      logger.info({ trackedTokens: this.trackedTokens.size }, "Connected to Polymarket market data WS");
      this.sendSubscription();
    });

    this.ws.on("message", (data) => {
      const raw = data.toString();

      // Skip non-JSON control/error strings from the server (e.g. "INVALID OPERATION")
      const trimmed = raw.trim();
      if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
        logger.debug({ raw: trimmed.slice(0, 120) }, "Market data WS: ignoring non-JSON message");
        return;
      }

      try {
        const payload = JSON.parse(raw) as unknown;
        this.handlePayload(payload);
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Market data WS message parse error",
        );
      }
    });

    this.ws.on("close", () => {
      if (!this.connected) {
        return;
      }

      logger.warn("Market data WS disconnected. Reconnecting in 3s...");
      setTimeout(() => this.connectWs(), 3_000);
    });

    this.ws.on("error", (error: Error) => {
      logger.error({ error: error.message }, "Market data WS error");
    });
  }

  private sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.trackedTokens.size === 0) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: "market",
        assets_ids: [...this.trackedTokens],
        custom_feature_enabled: true,
      }),
    );
  }

  private handlePayload(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        this.handlePayload(item);
      }
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    const record = payload as Record<string, unknown>;
    const data = record.data;

    if (Array.isArray(data)) {
      for (const item of data) {
        this.handlePayload(item);
      }
      return;
    }

    const eventType = typeof record.event_type === "string"
      ? record.event_type
      : typeof record.type === "string"
        ? record.type
        : typeof record.event === "string"
          ? record.event
          : undefined;

    switch (eventType) {
      case "book":
        this.handleBook(record);
        return;
      case "price_change":
        this.handlePriceChange(record);
        return;
      case "best_bid_ask":
        this.handleBestBidAsk(record);
        return;
      case "tick_size_change":
        this.handleTickSizeChange(record);
        return;
      case "last_trade_price":
        this.handleLastTradePrice(record);
        return;
      default:
        if (record.bids || record.asks) {
          this.handleBook(record);
        }
    }
  }

  private handleBook(record: Record<string, unknown>): void {
    const tokenId = parseTokenId(record.asset_id ?? record.assetId ?? record.token_id ?? record.tokenId);
    if (!tokenId) {
      return;
    }

    const book = this.getOrCreateBook(tokenId);
    book.bids = this.levelsToMap(record.bids as unknown[] | undefined);
    book.asks = this.levelsToMap(record.asks as unknown[] | undefined);

    const tickSize = parseNumber(record.tick_size ?? record.tickSize);
    if (tickSize !== undefined && tickSize > 0) {
      book.tickSize = tickSize;
    }

    const lastTradePrice = parseNumber(record.last_trade_price ?? record.lastTradePrice);
    if (lastTradePrice !== undefined && lastTradePrice > 0) {
      book.lastTradePrice = lastTradePrice;
    }

    const feeRateBps = parseNumber(record.fee_rate_bps ?? record.feeRateBps);
    if (feeRateBps !== undefined && feeRateBps >= 0) {
      book.feeRateBps = feeRateBps;
      this.clobClientService.setCachedFeeRateBps(tokenId, feeRateBps);
    }

    this.refreshBestLevels(book);
  }

  private handlePriceChange(record: Record<string, unknown>): void {
    const changes = Array.isArray(record.changes)
      ? record.changes
      : Array.isArray(record.price_changes)
        ? record.price_changes
        : [record];

    for (const change of changes) {
      if (!change || typeof change !== "object") {
        continue;
      }

      const changeRecord = change as Record<string, unknown>;
      const tokenId = parseTokenId(
        changeRecord.asset_id ??
        changeRecord.assetId ??
        changeRecord.token_id ??
        changeRecord.tokenId ??
        record.asset_id ??
        record.assetId,
      );
      const side = parseSide(changeRecord.side ?? changeRecord.book_side ?? changeRecord.bid_ask);
      const price = parseNumber(changeRecord.price);
      const size = parseNumber(changeRecord.size);

      if (!tokenId || !side || price === undefined || size === undefined) {
        continue;
      }

      const book = this.getOrCreateBook(tokenId);
      const levels = side === "bid" ? book.bids : book.asks;
      const levelKey = price.toFixed(6);

      if (size <= 0) {
        levels.delete(levelKey);
      } else {
        levels.set(levelKey, size);
      }

      this.refreshBestLevels(book);
    }
  }

  private handleBestBidAsk(record: Record<string, unknown>): void {
    const tokenId = parseTokenId(record.asset_id ?? record.assetId ?? record.token_id ?? record.tokenId);
    if (!tokenId) {
      return;
    }

    const book = this.getOrCreateBook(tokenId);
    const bestBid = parseNumber(record.best_bid ?? record.bestBid ?? record.bid_price ?? record.bid);
    const bestAsk = parseNumber(record.best_ask ?? record.bestAsk ?? record.ask_price ?? record.ask);

    if (bestBid !== undefined && bestBid > 0) {
      book.bestBid = bestBid;
      book.bids.set(bestBid.toFixed(6), parseNumber(record.best_bid_size ?? record.bid_size) ?? 0);
    }

    if (bestAsk !== undefined && bestAsk > 0) {
      book.bestAsk = bestAsk;
      book.asks.set(bestAsk.toFixed(6), parseNumber(record.best_ask_size ?? record.ask_size) ?? 0);
    }

    book.lastUpdatedMs = Date.now();
  }

  private handleTickSizeChange(record: Record<string, unknown>): void {
    const tokenId = parseTokenId(record.asset_id ?? record.assetId ?? record.token_id ?? record.tokenId);
    const tickSize = parseNumber(record.tick_size ?? record.tickSize);
    if (!tokenId || tickSize === undefined || tickSize <= 0) {
      return;
    }

    const book = this.getOrCreateBook(tokenId);
    book.tickSize = tickSize;
    book.lastUpdatedMs = Date.now();
  }

  private handleLastTradePrice(record: Record<string, unknown>): void {
    const tokenId = parseTokenId(record.asset_id ?? record.assetId ?? record.token_id ?? record.tokenId);
    if (!tokenId) {
      return;
    }

    const book = this.getOrCreateBook(tokenId);
    const price = parseNumber(record.price ?? record.last_trade_price ?? record.lastTradePrice);
    if (price !== undefined && price > 0) {
      book.lastTradePrice = price;
    }

    const feeRateBps = parseNumber(record.fee_rate_bps ?? record.feeRateBps);
    if (feeRateBps !== undefined && feeRateBps >= 0) {
      book.feeRateBps = feeRateBps;
      this.clobClientService.setCachedFeeRateBps(tokenId, feeRateBps);
    }

    book.lastUpdatedMs = Date.now();
  }

  private getOrCreateBook(tokenId: string): LocalBookState {
    const existing = this.books.get(tokenId);
    if (existing) {
      return existing;
    }

    const created: LocalBookState = {
      tokenId,
      bids: new Map(),
      asks: new Map(),
      tickSize: 0.01,
      lastUpdatedMs: Date.now(),
    };
    this.books.set(tokenId, created);
    return created;
  }

  private refreshBestLevels(book: LocalBookState): void {
    const bidPrices = [...book.bids.keys()].map(Number).filter(Number.isFinite).sort(sortDescending);
    const askPrices = [...book.asks.keys()].map(Number).filter(Number.isFinite).sort(sortAscending);
    book.bestBid = bidPrices[0];
    book.bestAsk = askPrices[0];
    book.lastUpdatedMs = Date.now();
  }

  private levelsToMap(levels: unknown[] | undefined): Map<string, number> {
    const map = new Map<string, number>();
    if (!Array.isArray(levels)) {
      return map;
    }

    for (const level of levels) {
      const parsed = this.parseLevel(level);
      if (!parsed || parsed.size <= 0) {
        continue;
      }

      map.set(parsed.price.toFixed(6), parsed.size);
    }

    return map;
  }

  private parseLevel(level: unknown): { price: number; size: number } | null {
    if (Array.isArray(level) && level.length >= 2) {
      const price = parseNumber(level[0]);
      const size = parseNumber(level[1]);
      return price !== undefined && size !== undefined ? { price, size } : null;
    }

    const record = level as OrderSummary | undefined;
    if (!record || typeof record !== "object") {
      return null;
    }

    const price = parseNumber(record.price);
    const size = parseNumber(record.size);
    return price !== undefined && size !== undefined ? { price, size } : null;
  }

  private async repairTrackedBooks(): Promise<void> {
    if (!this.connected || this.trackedTokens.size === 0) {
      return;
    }

    await Promise.all([...this.trackedTokens].map((tokenId) => this.primeToken(tokenId)));
  }

  private async primeToken(tokenId: string): Promise<void> {
    const [summary, feeRateBps] = await Promise.all([
      this.clobClientService.getOrderBookSummary(tokenId),
      this.clobClientService.getFeeRateBps(tokenId),
    ]);

    if (summary) {
      this.seedFromSummary(summary, feeRateBps);
      return;
    }

    const book = this.getOrCreateBook(tokenId);
    book.bids.clear();
    book.asks.clear();
    book.bestBid = undefined;
    book.bestAsk = undefined;
    book.feeRateBps = feeRateBps;
    book.lastUpdatedMs = Date.now();
    logger.debug?.({ tokenId, feeRateBps }, "Initial orderbook snapshot not available yet; seeding empty local book");
  }

  private seedFromSummary(summary: OrderBookSummary, feeRateBps: number): void {
    const book = this.getOrCreateBook(summary.asset_id);
    book.bids = this.levelsToMap(summary.bids);
    book.asks = this.levelsToMap(summary.asks);
    book.tickSize = parseNumber(summary.tick_size) ?? book.tickSize;
    book.lastTradePrice = parseNumber(summary.last_trade_price) ?? book.lastTradePrice;
    book.feeRateBps = feeRateBps;
    book.lastUpdatedMs = Date.now();
    this.refreshBestLevels(book);
  }
}
