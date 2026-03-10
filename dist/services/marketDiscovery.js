import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { floorToFiveMinuteBucketUtc, isValidTimeRange, toUtcMillis } from "../utils/time.js";
import { withRetry } from "../utils/retry.js";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const FIVE_MINUTES_MS = 5 * 60_000;
const parseStringArray = (value) => {
    if (!value) {
        return [];
    }
    if (Array.isArray(value)) {
        return value;
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
const getOutcomeIndexes = (outcomes) => {
    const normalized = outcomes.map((outcome) => outcome.trim().toLowerCase());
    const yesIndex = normalized.findIndex((outcome) => outcome === "yes" || outcome === "up");
    const noIndex = normalized.findIndex((outcome) => outcome === "no" || outcome === "down");
    if (yesIndex >= 0 && noIndex >= 0) {
        return { yesIndex, noIndex };
    }
    return { yesIndex: 0, noIndex: 1 };
};
const getMarketSearchText = (market) => {
    const event = market.events?.[0];
    const series = event?.series?.[0];
    return [
        market.question,
        market.description ?? "",
        market.slug ?? "",
        series?.slug ?? "",
        event?.resolutionSource ?? "",
    ]
        .join(" ")
        .toLowerCase();
};
const detectCryptoSymbol = (market) => {
    const event = market.events?.[0];
    const series = event?.series?.[0];
    if (series?.recurrence !== "5m") {
        return null;
    }
    const text = getMarketSearchText(market);
    const hasUpDownPattern = text.includes("up or down") || text.includes("up-or-down");
    if (!hasUpDownPattern) {
        return null;
    }
    if (/\bbtc\b|\bbitcoin\b/.test(text)) {
        return "BTC";
    }
    if (/\beth\b|\bethereum\b/.test(text)) {
        return "ETH";
    }
    if (/\bsol\b|\bsolana\b/.test(text)) {
        return "SOL";
    }
    if (/\bxrp\b|\bripple\b/.test(text)) {
        return "XRP";
    }
    return null;
};
export class MarketDiscoveryService {
    http;
    constructor() {
        this.http = axios.create({
            baseURL: GAMMA_API_URL,
            timeout: 15_000,
        });
    }
    async discoverMarkets() {
        const markets = await withRetry(async () => {
            const now = new Date();
            const endMin = new Date(now.getTime() - 60 * 60_000).toISOString();
            const endMax = new Date(now.getTime() + 60 * 60_000).toISOString();
            const response = await this.http.get("/markets", {
                params: {
                    limit: env.DISCOVERY_MARKET_LIMIT,
                    order: "startDate",
                    ascending: "false",
                    active: "true",
                    closed: "false",
                    end_date_min: endMin,
                    end_date_max: endMax,
                },
            });
            return response.data;
        }, {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: "market-discovery",
            onRetry: (attempt, error, delayMs) => {
                logger.warn({
                    attempt,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                }, "Gamma market discovery failed; retrying");
            },
        });
        const now = Date.now();
        const discovered = [];
        for (const market of markets) {
            const symbol = detectCryptoSymbol(market);
            if (!market.active || market.closed || market.archived || !market.acceptingOrders) {
                continue;
            }
            if (!symbol) {
                continue;
            }
            const conditionId = market.conditionId;
            const endTime = market.endDate;
            const startTime = market.events?.[0]?.startTime ?? market.events?.[0]?.startDate;
            if (!conditionId || !startTime || !endTime || !isValidTimeRange(startTime, endTime)) {
                continue;
            }
            const tokenIds = parseStringArray(market.clobTokenIds);
            const outcomes = parseStringArray(market.outcomes);
            if (tokenIds.length < 2 || outcomes.length < 2) {
                continue;
            }
            const { yesIndex, noIndex } = getOutcomeIndexes(outcomes);
            const yesTokenId = tokenIds[yesIndex];
            const noTokenId = tokenIds[noIndex];
            if (!yesTokenId || !noTokenId) {
                continue;
            }
            const startMs = toUtcMillis(startTime);
            const endMs = toUtcMillis(endTime);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= now) {
                continue;
            }
            discovered.push({
                marketId: market.id,
                conditionId,
                question: market.question,
                symbol,
                recurrence: "5m",
                startTime,
                endTime,
                yesTokenId,
                noTokenId,
                yesLabel: outcomes[yesIndex] ?? "Yes",
                noLabel: outcomes[noIndex] ?? "No",
            });
        }
        discovered.sort((a, b) => {
            const startDiff = toUtcMillis(a.startTime) - toUtcMillis(b.startTime);
            if (startDiff !== 0) {
                return startDiff;
            }
            return Number(b.marketId) - Number(a.marketId);
        });
        logger.info({ discovered: discovered.length }, "Discovered qualifying 5-minute crypto markets");
        return discovered;
    }
    async detectStartupTargetStartTimeMs(discoveredMarkets) {
        if (discoveredMarkets.length === 0) {
            throw new Error("No qualifying BTC/ETH/SOL/XRP 5-minute markets discovered at startup");
        }
        const now = Date.now();
        const currentCycleStartMs = floorToFiveMinuteBucketUtc(now);
        const targetStartTimeMs = currentCycleStartMs + env.STARTUP_MARKET_LOOKAHEAD_CYCLES * FIVE_MINUTES_MS;
        const liveMarketsInCurrentBucket = discoveredMarkets.filter((market) => {
            const startMs = toUtcMillis(market.startTime);
            const endMs = toUtcMillis(market.endTime);
            return (Number.isFinite(startMs) &&
                Number.isFinite(endMs) &&
                floorToFiveMinuteBucketUtc(startMs) === currentCycleStartMs &&
                now < endMs);
        });
        logger.info({
            detectionSource: "rest-clock-bucket",
            liveMarketsInCurrentBucket: liveMarketsInCurrentBucket.length,
            activeStartTime: new Date(currentCycleStartMs).toISOString(),
            targetStartTimeIso: new Date(targetStartTimeMs).toISOString(),
            lookaheadCycles: env.STARTUP_MARKET_LOOKAHEAD_CYCLES,
        }, "Startup active cycle detected from initial REST market snapshot");
        return targetStartTimeMs;
    }
    async getMarketStartTimeByConditionId(conditionId) {
        const markets = await withRetry(async () => {
            const response = await this.http.get("/markets", {
                params: { condition_id: conditionId },
            });
            return response.data;
        }, {
            attempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            label: `market-start-time-${conditionId}`,
            onRetry: (attempt, error, delayMs) => {
                logger.warn({
                    conditionId,
                    attempt,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                }, "Gamma market fetch by conditionId failed; retrying");
            },
        });
        const market = markets[0];
        if (!market) {
            return undefined;
        }
        const startTime = market.events?.[0]?.startTime ?? market.events?.[0]?.startDate;
        if (!startTime) {
            return undefined;
        }
        const startMs = toUtcMillis(startTime);
        if (!Number.isFinite(startMs)) {
            return undefined;
        }
        return floorToFiveMinuteBucketUtc(startMs);
    }
}
//# sourceMappingURL=marketDiscovery.js.map