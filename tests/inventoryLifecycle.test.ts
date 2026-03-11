import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PositionStore } from "../src/services/positionStore.js";
import { QuoteEngine } from "../src/services/quoteEngine.js";
import { PositionManager } from "../src/services/positionManager.js";
import { OrderService } from "../src/services/orderService.js";
import { env } from "../src/config/env.js";
import { Side } from "@polymarket/clob-client";

const makeTempDbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-lifecycle-"));
  return path.join(dir, "state.sqlite");
};

const createQuoteEngine = () =>
  new QuoteEngine({
    getSnapshot: () => ({
      tokenId: "token-1",
      bestBid: 0.48,
      bestAsk: 0.52,
      tickSize: 0.01,
      lastTradePrice: 0.5,
    }),
    getFeeRateBps: () => 0,
  } as any);

test("fractional exit sizes are preserved instead of being rounded down", async () => {
  const quoteEngine = createQuoteEngine();

  const quote = await quoteEngine.buildExitQuote({
    tokenId: "token-1",
    size: 5.75,
    entryPrice: 0.39,
  });

  assert.equal(quote.size, 5.75);
});

test("partial exit fills reduce inventory by fill delta instead of cumulative matched size", () => {
  const store = new PositionStore(makeTempDbPath());
  store.init();

  store.upsertPosition({
    positionId: "position-1",
    conditionId: "condition-1",
    marketId: "market-1",
    tokenId: "token-1",
    symbol: "BTC",
    leg: "YES",
    recurrence: "5m",
    startTimeMs: 1,
    endTimeMs: 2,
    entryTargetPrice: 0.39,
    entryTargetSize: 5,
    status: "exit_open",
    quoteReason: "dynamic-entry",
  });
  store.upsertOrder({
    orderId: "exit-order-1",
    positionId: "position-1",
    clientOrderKey: "exit:position-1",
    tokenId: "token-1",
    side: Side.SELL,
    price: 0.55,
    size: 5,
    orderRole: "exit",
    status: "open",
  });

  store.markPositionStatus("position-1", "exit_open");

  const db = (store as any).db;
  db.prepare(
    "UPDATE positions SET filled_size = ?, entry_price_actual = ?, realized_pnl = ?, realized_spread = ? WHERE id = ?",
  ).run(5, 0.39, 0, 0, "position-1");

  const first = store.recordFillProgress({
    orderId: "exit-order-1",
    fillSize: 2,
    cumulativeMatchedSize: 2,
    eventSource: "test",
    eventTimeMs: 1000,
  });
  assert.ok(first);
  assert.equal(first?.positionFilledSize, 3);

  const second = store.recordFillProgress({
    orderId: "exit-order-1",
    fillSize: 1,
    cumulativeMatchedSize: 3,
    eventSource: "test",
    eventTimeMs: 2000,
  });
  assert.ok(second);
  assert.equal(second?.positionFilledSize, 2);

  const position = store.getPositionForExit("position-1");
  assert.equal(position?.filledSize, 2);
});

test("realized pnl accumulates across partial exit fills", () => {
  const store = new PositionStore(makeTempDbPath());
  store.init();

  store.upsertPosition({
    positionId: "position-2",
    conditionId: "condition-2",
    marketId: "market-2",
    tokenId: "token-2",
    symbol: "ETH",
    leg: "NO",
    recurrence: "5m",
    startTimeMs: 1,
    endTimeMs: 2,
    entryTargetPrice: 0.39,
    entryTargetSize: 5,
    status: "exit_open",
    quoteReason: "dynamic-entry",
  });
  store.upsertOrder({
    orderId: "exit-order-2",
    positionId: "position-2",
    clientOrderKey: "exit:position-2",
    tokenId: "token-2",
    side: Side.SELL,
    price: 0.55,
    size: 5,
    orderRole: "exit",
    status: "open",
  });

  const db = (store as any).db;
  db.prepare(
    "UPDATE positions SET filled_size = ?, entry_price_actual = ?, realized_pnl = ?, realized_spread = ? WHERE id = ?",
  ).run(5, 0.39, 0, 0, "position-2");

  store.recordFillProgress({
    orderId: "exit-order-2",
    fillSize: 2,
    cumulativeMatchedSize: 2,
    eventSource: "test",
    eventTimeMs: 1000,
  });

  store.recordFillProgress({
    orderId: "exit-order-2",
    fillSize: 1,
    cumulativeMatchedSize: 3,
    eventSource: "test",
    eventTimeMs: 2000,
  });

  const position = store.getPositionForExit("position-2");
  assert.equal(position?.realizedPnl, (0.55 - 0.39) * 3);
});

test("partial entry fills trigger exit handling instead of being stranded", async () => {
  const storeStub = {
    init() {},
    recordFillProgress: () => ({
      positionId: "position-3",
      orderRole: "entry",
      side: Side.BUY,
      cumulativeMatchedSize: 2.5,
      targetSize: 5,
      positionFilledSize: 2.5,
      positionStatus: "partially_filled",
    }),
  };

  const manager = new PositionManager(
    storeStub as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const calls: Array<{ positionId: string; tokenId: string; size: number }> = [];
  (manager as any).classifyRemainingInventory = async () => "exit";
  (manager as any).triggerExitForPosition = async (positionId: string, tokenId: string, size: number) => {
    calls.push({ positionId, tokenId, size });
  };

  await manager.onOrderFillProgress({
    orderId: "entry-order-3",
    tokenId: "token-3",
    side: Side.BUY,
    fillSize: 2.5,
    cumulativeMatchedSize: 2.5,
    targetSize: 5,
  });

  assert.deepEqual(calls, [{ positionId: "position-3", tokenId: "token-3", size: 2.5 }]);
});

test("expired zero-fill entry orders are cancelled and positions become entry_expired", async () => {
  const store = new PositionStore(makeTempDbPath());
  store.init();

  store.upsertPosition({
    positionId: "position-expired-entry",
    conditionId: "condition-expired-entry",
    marketId: "market-expired-entry",
    tokenId: "token-expired-entry",
    symbol: "BTC",
    leg: "YES",
    recurrence: "5m",
    startTimeMs: 100_000,
    endTimeMs: 400_000,
    entryTargetPrice: 0.42,
    entryTargetSize: 3,
    status: "entry_open",
    quoteReason: "initial-entry",
  });
  store.upsertOrder({
    orderId: "entry-order-expired",
    positionId: "position-expired-entry",
    clientOrderKey: "entry:position-expired-entry",
    tokenId: "token-expired-entry",
    side: Side.BUY,
    price: 0.42,
    size: 3,
    orderRole: "entry",
    status: "open",
  });

  const manager = new PositionManager(
    store,
    {
      getClient: () => ({
        cancelOrder: async () => undefined,
      }),
    } as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const expirationMs = 100_000 + env.ORDER_EXPIRATION_SECONDS * 1_000;
  await manager.manageExpiredEntries(expirationMs + 1);

  const db = (store as any).db;
  const row = db.prepare(
    "SELECT o.status AS orderStatus, p.status AS positionStatus, p.quote_reason AS quoteReason FROM orders o INNER JOIN positions p ON p.id = o.position_id WHERE o.id = ?",
  ).get("entry-order-expired") as
    | {
        orderStatus: string;
        positionStatus: string;
        quoteReason: string | null;
      }
    | undefined;

  assert.ok(row);
  assert.equal(row?.orderStatus, "cancelled");
  assert.equal(row?.positionStatus, "entry_expired");
  assert.equal(row?.quoteReason, "expired-unfilled-entry");
});

test("position manager exposes an active stale-exit management loop", async () => {
  const manager = new PositionManager({ init() {} } as any, {} as any, {} as any, {} as any, {} as any);
  assert.equal(typeof (manager as any).manageOpenExits, "function");
});

const makeMarket = () => ({
  marketId: "market-1",
  conditionId: "condition-1",
  question: "BTC?",
  yesTokenId: "yes-token",
  noTokenId: "no-token",
  startTime: new Date("2026-03-11T10:00:00.000Z").toISOString(),
  endTime: new Date("2026-03-11T10:05:00.000Z").toISOString(),
  symbol: "BTC",
  recurrence: "5m",
});

test("entry sizing skips orders when balance minus reserve cannot fund the minimum order size", async () => {
  const originalDryRun = env.DRY_RUN;
  const originalReserveBalance = env.RESERVE_BALANCE_USDC;
  const originalMinOrderSize = env.MIN_ORDER_SIZE;

  env.DRY_RUN = false;
  env.RESERVE_BALANCE_USDC = 5;
  env.MIN_ORDER_SIZE = 5;

  const placedOrders: Array<{ tokenID: string; size: number }> = [];
  const service = new OrderService(
    {
      getClient: () => ({
        getOpenOrders: async () => [],
        createAndPostOrder: async (order: { tokenID: string; size: number }) => {
          placedOrders.push(order);
          return { orderID: "entry-order-1" };
        },
      }),
      getBalanceSnapshot: async () => ({ balanceUsdc: 6 }),
      getOrderCreationConfig: async () => ({ tickSize: 0.01, negRisk: false }),
    } as any,
    {
      subscribeToTokens() {},
      trackOrder() {},
    } as any,
    {
      subscribeTokens: async () => undefined,
      getSnapshot: () => undefined,
      getFeeRateBps: () => 0,
    } as any,
    {
      registerEntryOrder() {},
      registerPendingPaperEntry() {},
    } as any,
    {
      buildEntryQuote: async (_market: unknown, leg: "YES" | "NO") =>
        leg === "YES"
          ? { shouldPlace: true, price: 1, size: 5, quoteReason: "test-reserve" }
          : { shouldPlace: false, price: 1, size: 5, quoteReason: "skip-other-leg" },
    } as any,
    {
      getMockBalance: () => 6,
    } as any,
  );

  try {
    const result = await service.placeOrdersForMarket(makeMarket() as any);
    assert.equal(placedOrders.length, 0);
    assert.equal(result.legs[0]?.reason, "insufficient-balance-for-min-order-size");
  } finally {
    env.DRY_RUN = originalDryRun;
    env.RESERVE_BALANCE_USDC = originalReserveBalance;
    env.MIN_ORDER_SIZE = originalMinOrderSize;
  }
});

test("entry sizing still allows orders when balance minus reserve can fund the minimum order size", async () => {
  const originalDryRun = env.DRY_RUN;
  const originalReserveBalance = env.RESERVE_BALANCE_USDC;
  const originalMinOrderSize = env.MIN_ORDER_SIZE;

  env.DRY_RUN = false;
  env.RESERVE_BALANCE_USDC = 2;
  env.MIN_ORDER_SIZE = 5;

  const placedOrders: Array<{ tokenID: string; size: number }> = [];
  const service = new OrderService(
    {
      getClient: () => ({
        getOpenOrders: async () => [],
        createAndPostOrder: async (order: { tokenID: string; size: number }) => {
          placedOrders.push(order);
          return { orderID: "entry-order-2" };
        },
      }),
      getBalanceSnapshot: async () => ({ balanceUsdc: 7.2 }),
      getOrderCreationConfig: async () => ({ tickSize: 0.01, negRisk: false }),
    } as any,
    {
      subscribeToTokens() {},
      trackOrder() {},
    } as any,
    {
      subscribeTokens: async () => undefined,
      getSnapshot: () => undefined,
      getFeeRateBps: () => 0,
    } as any,
    {
      registerEntryOrder() {},
      registerPendingPaperEntry() {},
    } as any,
    {
      buildEntryQuote: async (_market: unknown, leg: "YES" | "NO") =>
        leg === "YES"
          ? { shouldPlace: true, price: 1, size: 5, quoteReason: "test-reserve" }
          : { shouldPlace: false, price: 1, size: 5, quoteReason: "skip-other-leg" },
    } as any,
    {
      getMockBalance: () => 7.2,
    } as any,
  );

  try {
    const result = await service.placeOrdersForMarket(makeMarket() as any);
    assert.equal(placedOrders.length, 1);
    assert.equal(placedOrders[0]?.size, 5);
    assert.equal(result.legs[0]?.status, "placed");
  } finally {
    env.DRY_RUN = originalDryRun;
    env.RESERVE_BALANCE_USDC = originalReserveBalance;
    env.MIN_ORDER_SIZE = originalMinOrderSize;
  }
});
