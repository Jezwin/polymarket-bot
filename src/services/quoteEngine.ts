import { env } from "../config/env.js";
import type { DiscoveredMarket } from "../types/market.js";
import {
  calculateEffectiveBuyUnitCost,
  findMaxEntryPriceForTargetCost,
  findRequiredExitPriceForTargetProceeds,
} from "./feeModel.js";
import type { OrderBookSnapshot } from "./clobClient.js";
import { MarketBookService } from "./marketBookService.js";
import { logger } from "../utils/logger.js";

const clampPrice = (price: number, tickSize: number): number => {
  const clamped = Math.max(tickSize, Math.min(1 - tickSize, price));
  const decimals = String(tickSize).split(".")[1]?.length ?? 0;
  return Number(clamped.toFixed(decimals));
};

const normalizeSize = (size: number): number => Number(size.toFixed(6));

const midpoint = (book: OrderBookSnapshot): number => {
  if (book.bestBid !== undefined && book.bestAsk !== undefined) {
    return (book.bestBid + book.bestAsk) / 2;
  }
  if (book.bestBid !== undefined) {
    return book.bestBid;
  }
  if (book.bestAsk !== undefined) {
    return book.bestAsk;
  }
  return env.ORDER_PRICE;
};

export interface QuoteDecision {
  shouldPlace: boolean;
  price: number;
  size: number;
  quoteReason: string;
  fairValue: number;
  bestBid?: number;
  bestAsk?: number;
  feeRateBps: number;
}

interface ExitContext {
  tokenId: string;
  size: number;
  entryPrice: number;
}

export class QuoteEngine {
  constructor(private readonly marketBookService: MarketBookService) {}

  async buildEntryQuote(
    market: DiscoveredMarket,
    leg: "YES" | "NO",
    tokenId: string,
  ): Promise<QuoteDecision> {
    if (!env.DYNAMIC_QUOTING_ENABLED) {
      return {
        shouldPlace: true,
        price: env.ORDER_PRICE,
        size: env.ORDER_SIZE,
        quoteReason: "static-fallback",
        fairValue: env.ORDER_PRICE,
        feeRateBps: env.DEFAULT_FEE_RATE_BPS,
      };
    }

    const primaryTokenId = leg === "YES" ? market.yesTokenId : market.noTokenId;
    const oppositeTokenId = leg === "YES" ? market.noTokenId : market.yesTokenId;
    const primaryBook = this.marketBookService.getSnapshot(primaryTokenId);
    const oppositeBook = this.marketBookService.getSnapshot(oppositeTokenId);
    const feeRateBps = this.marketBookService.getFeeRateBps(primaryTokenId);

    if (!primaryBook || !oppositeBook) {
      logger.debug?.(
        {
          symbol: market.symbol,
          leg,
          tokenId,
          primaryBookAvailable: Boolean(primaryBook),
          oppositeBookAvailable: Boolean(oppositeBook),
        },
        "Entry quote skipped because local orderbook is not ready",
      );

      return {
        shouldPlace: false,
        price: env.ORDER_PRICE,
        size: env.ORDER_SIZE,
        quoteReason: "local-orderbook-not-ready",
        fairValue: env.ORDER_PRICE,
        feeRateBps,
      };
    }

    const primaryMid = midpoint(primaryBook);
    const oppositeMid = midpoint(oppositeBook);
    const fairValue = clampPrice(
      (primaryMid + (1 - oppositeMid)) / 2,
      primaryBook.tickSize,
    );

    const targetUnitCost = Math.max(primaryBook.tickSize, fairValue - env.ENTRY_EDGE_BUFFER - env.ADVERSE_SELECTION_BUFFER);
    const targetPrice = clampPrice(
      findMaxEntryPriceForTargetCost(targetUnitCost, feeRateBps, primaryBook.tickSize),
      primaryBook.tickSize,
    );
    const effectiveEntryUnitCost = calculateEffectiveBuyUnitCost(targetPrice, feeRateBps);

    if (primaryBook.bestBid !== undefined && targetPrice + primaryBook.tickSize < primaryBook.bestBid) {
      logger.info(
        {
          symbol: market.symbol,
          leg,
          tokenId,
          fairValue,
          targetPrice,
          targetUnitCost,
          effectiveEntryUnitCost,
          bestBid: primaryBook.bestBid,
          bestAsk: primaryBook.bestAsk,
          feeRateBps,
          quoteReason: "best-bid-too-rich",
        },
        "Entry quote skipped",
      );
      return {
        shouldPlace: false,
        price: targetPrice,
        size: env.ORDER_SIZE,
        quoteReason: "best-bid-too-rich",
        fairValue,
        bestBid: primaryBook.bestBid,
        bestAsk: primaryBook.bestAsk,
        feeRateBps,
      };
    }

    const improvedBid =
      primaryBook.bestBid !== undefined
        ? clampPrice(primaryBook.bestBid + primaryBook.tickSize, primaryBook.tickSize)
        : targetPrice;
    const passiveCap =
      primaryBook.bestAsk !== undefined
        ? clampPrice(primaryBook.bestAsk - primaryBook.tickSize, primaryBook.tickSize)
        : targetPrice;
    const quotePrice = clampPrice(
      Math.min(passiveCap, Math.max(targetPrice, improvedBid)),
      primaryBook.tickSize,
    );

    logger.info(
      {
        symbol: market.symbol,
        leg,
        tokenId,
        fairValue,
        targetPrice,
        targetUnitCost,
        effectiveEntryUnitCost,
        bestBid: primaryBook.bestBid,
        bestAsk: primaryBook.bestAsk,
        feeRateBps,
        quotePrice,
        quoteReason: "dynamic-entry",
      },
      "Entry quote decision",
    );

    return {
      shouldPlace: true,
      price: quotePrice,
      size: env.ORDER_SIZE,
      quoteReason: "dynamic-entry",
      fairValue,
      bestBid: primaryBook.bestBid,
      bestAsk: primaryBook.bestAsk,
      feeRateBps,
    };
  }

  async buildExitQuote(input: ExitContext): Promise<QuoteDecision> {
    if (!env.DYNAMIC_QUOTING_ENABLED) {
      return {
        shouldPlace: true,
        price: env.ORDER_PRICE * 2,
        size: normalizeSize(input.size),
        quoteReason: "static-fallback",
        fairValue: env.ORDER_PRICE * 2,
        feeRateBps: env.DEFAULT_FEE_RATE_BPS,
      };
    }

    const book = this.marketBookService.getSnapshot(input.tokenId);
    const feeRateBps = this.marketBookService.getFeeRateBps(input.tokenId);

    if (!book) {
      logger.debug?.(
        {
          tokenId: input.tokenId,
          entryPrice: input.entryPrice,
        },
        "Exit quote skipped because local orderbook is not ready",
      );

      return {
        shouldPlace: false,
        price: input.entryPrice,
        size: normalizeSize(input.size),
        quoteReason: "local-orderbook-not-ready",
        fairValue: input.entryPrice,
        feeRateBps,
      };
    }

    const fairValue = midpoint(book);
    const effectiveEntryUnitCost = calculateEffectiveBuyUnitCost(input.entryPrice, feeRateBps);
    const minAggressiveExit = clampPrice(
      findRequiredExitPriceForTargetProceeds(
        effectiveEntryUnitCost + env.EXIT_EDGE_BUFFER,
        feeRateBps,
        book.tickSize,
      ),
      book.tickSize,
    );
    const minPassiveExit = clampPrice(
      findRequiredExitPriceForTargetProceeds(
        effectiveEntryUnitCost + env.EXIT_EDGE_BUFFER + env.ADVERSE_SELECTION_BUFFER,
        feeRateBps,
        book.tickSize,
      ),
      book.tickSize,
    );

    if (book.bestBid !== undefined && book.bestBid >= minAggressiveExit) {
      const aggressivePrice = clampPrice(book.bestBid, book.tickSize);

      logger.info(
        {
          tokenId: input.tokenId,
          entryPrice: input.entryPrice,
          effectiveEntryUnitCost,
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
          fairValue,
          feeRateBps,
          minAggressiveExit,
          minPassiveExit,
          quotePrice: aggressivePrice,
          quoteReason: "aggressive-exit-best-bid",
          quoteMode: "aggressive",
        },
        "Exit quote decision",
      );

      return {
        shouldPlace: true,
        price: aggressivePrice,
        size: normalizeSize(input.size),
        quoteReason: "aggressive-exit-best-bid",
        fairValue,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        feeRateBps,
      };
    }

    const improvedAsk =
      book.bestAsk !== undefined
        ? clampPrice(Math.max(minPassiveExit, book.bestAsk - book.tickSize), book.tickSize)
        : minPassiveExit;
    const bookAwareAsk =
      book.bestBid !== undefined
        ? clampPrice(Math.max(improvedAsk, book.bestBid + book.tickSize), book.tickSize)
        : improvedAsk;

    logger.info(
      {
        tokenId: input.tokenId,
        entryPrice: input.entryPrice,
        effectiveEntryUnitCost,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        fairValue,
        feeRateBps,
        minAggressiveExit,
        minPassiveExit,
        quotePrice: bookAwareAsk,
        quoteReason: "dynamic-exit-passive",
        quoteMode: "passive",
      },
      "Exit quote decision",
    );

    return {
      shouldPlace: true,
      price: bookAwareAsk,
      size: normalizeSize(input.size),
      quoteReason: "dynamic-exit-passive",
      fairValue,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      feeRateBps,
    };
  }
}
