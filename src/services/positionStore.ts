import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env.js";

export type PersistedPositionStatus =
  | "entry_pending"
  | "entry_open"
  | "entry_expired"
  | "partially_filled"
  | "fully_filled"
  | "exit_pending"
  | "exit_open"
  | "dust_stranded"
  | "closed"
  | "error";

export type PersistedOrderRole = "entry" | "exit";
export type PersistedOrderStatus =
  | "pending_submit"
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "failed";

export interface UpsertPositionInput {
  positionId: string;
  conditionId: string;
  marketId: string;
  tokenId: string;
  symbol: string;
  leg: string;
  recurrence: string;
  startTimeMs: number;
  endTimeMs: number;
  entryTargetPrice: number;
  entryTargetSize: number;
  status: PersistedPositionStatus;
  quoteReason?: string;
}

export interface UpsertOrderInput {
  orderId: string;
  positionId: string;
  clientOrderKey: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
  orderRole: PersistedOrderRole;
  status: PersistedOrderStatus;
}

export interface PersistedOrderForTracking {
  orderId: string;
  positionId: string;
  tokenId: string;
  side: string;
  size: number;
  matchedSize: number;
  orderRole: PersistedOrderRole;
  conditionId: string;
  recurrence: string;
  startTimeMs: number;
  endTimeMs: number;
  price: number;
}

export interface PersistedOpenEntryOrder {
  orderId: string;
  positionId: string;
  tokenId: string;
  recurrence: string;
  startTimeMs: number;
  endTimeMs: number;
  price: number;
  size: number;
  matchedSize: number;
  filledSize: number;
  status: PersistedPositionStatus;
}

export interface PersistedExitCandidate {
  positionId: string;
  conditionId: string;
  marketId: string;
  tokenId: string;
  symbol: string;
  leg: string;
  recurrence: string;
  startTimeMs: number;
  endTimeMs: number;
  entryTargetPrice: number;
  entryTargetSize: number;
  filledSize: number;
  status: PersistedPositionStatus;
  quoteReason?: string | null;
  entryPriceActual?: number | null;
  exitPriceActual?: number | null;
  realizedPnl?: number | null;
  realizedSpread?: number | null;
  entryFillTimeMs?: number | null;
  exitFillTimeMs?: number | null;
}

export interface PersistedOpenExitOrder {
  orderId: string;
  positionId: string;
  tokenId: string;
  side: string;
  size: number;
  matchedSize: number;
  price: number;
  createdAtMs: number;
  updatedAtMs: number;
  conditionId: string;
  marketId: string;
  symbol: string;
  leg: string;
  recurrence: string;
  startTimeMs: number;
  endTimeMs: number;
  entryTargetPrice: number;
  filledSize: number;
  entryPriceActual?: number | null;
}

interface FillUpdateResult {
  positionId: string;
  orderRole: PersistedOrderRole;
  side: string;
  cumulativeMatchedSize: number;
  targetSize: number;
  positionFilledSize: number;
  positionStatus: PersistedPositionStatus;
}

interface UpsertPaperTradeEntryInput {
  positionId: string;
  conditionId: string;
  marketId: string;
  tokenId: string;
  marketName: string;
  symbol: string;
  leg: string;
  recurrence: string;
  schedulerTickId: string;
  schedulerCycleLabel: string;
  schedulerTickStartedMs: number;
  schedulerExpectedIntervalMs: number;
  schedulerActualIntervalMs?: number;
  targetCycleStartMs: number;
  entryQuotePrice: number;
  entryFillPrice: number;
  entrySize: number;
  quoteReason: string;
  entryTimeMs: number;
}

interface FinalizePaperTradeExitInput {
  positionId: string;
  exitQuotePrice: number;
  exitFillPrice: number;
  exitSize: number;
  exitReason: string;
  exitTimeMs: number;
  holdingTimeMs?: number | null;
  realizedSpread?: number | null;
  realizedPnl?: number | null;
}

export class PositionStore {
  private readonly db: Database.Database;

  constructor(dbPath = env.STATE_DB_PATH) {
    const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        leg TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        start_time_ms INTEGER NOT NULL,
        end_time_ms INTEGER NOT NULL,
        entry_target_price REAL NOT NULL,
        entry_target_size REAL NOT NULL,
        filled_size REAL NOT NULL DEFAULT 0,
        avg_entry_price REAL,
        entry_price_actual REAL,
        exit_price_actual REAL,
        realized_pnl REAL,
        realized_spread REAL,
        entry_fill_time_ms INTEGER,
        exit_fill_time_ms INTEGER,
        quote_reason TEXT,
        exit_reason TEXT,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        client_order_key TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        matched_size REAL NOT NULL DEFAULT 0,
        order_role TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(position_id) REFERENCES positions(id)
      );

      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        fill_size REAL NOT NULL,
        cumulative_matched_size REAL NOT NULL,
        event_source TEXT NOT NULL,
        event_time_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL UNIQUE,
        condition_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        market_name TEXT,
        symbol TEXT NOT NULL,
        leg TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        scheduler_tick_id TEXT NOT NULL,
        scheduler_cycle_label TEXT NOT NULL,
        scheduler_tick_started_ms INTEGER NOT NULL,
        scheduler_tick_completed_ms INTEGER,
        scheduler_expected_interval_ms INTEGER NOT NULL,
        scheduler_actual_interval_ms INTEGER,
        target_cycle_start_ms INTEGER NOT NULL,
        entry_quote_price REAL NOT NULL,
        entry_fill_price REAL NOT NULL,
        entry_size REAL NOT NULL,
        quote_reason TEXT NOT NULL,
        entry_time_ms INTEGER NOT NULL,
        exit_quote_price REAL,
        exit_fill_price REAL,
        exit_size REAL,
        exit_reason TEXT,
        exit_time_ms INTEGER,
        holding_time_ms INTEGER,
        realized_spread REAL,
        realized_pnl REAL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(position_id) REFERENCES positions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_orders_position_id ON orders(position_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_paper_trades_entry_time_ms ON paper_trades(entry_time_ms);
      CREATE INDEX IF NOT EXISTS idx_paper_trades_scheduler_tick_id ON paper_trades(scheduler_tick_id);
    `);

    this.ensureColumn("positions", "entry_price_actual", "REAL");
    this.ensureColumn("positions", "exit_price_actual", "REAL");
    this.ensureColumn("positions", "realized_pnl", "REAL");
    this.ensureColumn("positions", "realized_spread", "REAL");
    this.ensureColumn("positions", "entry_fill_time_ms", "INTEGER");
    this.ensureColumn("positions", "exit_fill_time_ms", "INTEGER");
    this.ensureColumn("positions", "quote_reason", "TEXT");
    this.ensureColumn("positions", "exit_reason", "TEXT");
    this.ensureColumn("paper_trades", "market_name", "TEXT");
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const columns = this.db.pragma(`table_info(${tableName})`) as Array<{ name: string }>;
    const hasColumn = columns.some((column) => column.name === columnName);

    if (hasColumn) {
      return;
    }

    try {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column name")) {
        throw error;
      }
    }
  }

  upsertPosition(input: UpsertPositionInput): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO positions (
          id, condition_id, market_id, token_id, symbol, leg, recurrence,
          start_time_ms, end_time_ms, entry_target_price, entry_target_size,
          status, quote_reason, created_at_ms, updated_at_ms
        ) VALUES (
          @positionId, @conditionId, @marketId, @tokenId, @symbol, @leg, @recurrence,
          @startTimeMs, @endTimeMs, @entryTargetPrice, @entryTargetSize,
          @status, @quoteReason, @createdAtMs, @updatedAtMs
        )
        ON CONFLICT(id) DO UPDATE SET
          condition_id = excluded.condition_id,
          market_id = excluded.market_id,
          token_id = excluded.token_id,
          symbol = excluded.symbol,
          leg = excluded.leg,
          recurrence = excluded.recurrence,
          start_time_ms = excluded.start_time_ms,
          end_time_ms = excluded.end_time_ms,
          entry_target_price = excluded.entry_target_price,
          entry_target_size = excluded.entry_target_size,
          status = excluded.status,
          quote_reason = excluded.quote_reason,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run({
        ...input,
        createdAtMs: now,
        updatedAtMs: now,
      });
  }

  upsertOrder(input: UpsertOrderInput): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO orders (
          id, position_id, client_order_key, token_id, side, price, size,
          order_role, status, created_at_ms, updated_at_ms
        ) VALUES (
          @orderId, @positionId, @clientOrderKey, @tokenId, @side, @price, @size,
          @orderRole, @status, @createdAtMs, @updatedAtMs
        )
        ON CONFLICT(id) DO UPDATE SET
          position_id = excluded.position_id,
          client_order_key = excluded.client_order_key,
          token_id = excluded.token_id,
          side = excluded.side,
          price = excluded.price,
          size = excluded.size,
          order_role = excluded.order_role,
          status = excluded.status,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run({
        ...input,
        createdAtMs: now,
        updatedAtMs: now,
      });
  }

  markOrderStatus(orderId: string, status: PersistedOrderStatus, lastError?: string): void {
    this.db
      .prepare(`
        UPDATE orders
        SET status = ?, last_error = ?, updated_at_ms = ?
        WHERE id = ?
      `)
      .run(status, lastError ?? null, Date.now(), orderId);
  }

  getTrackedOpenOrders(): PersistedOrderForTracking[] {
    return this.db
      .prepare(`
        SELECT
          o.id AS orderId,
          o.position_id AS positionId,
          o.token_id AS tokenId,
          o.side AS side,
          o.size AS size,
          o.matched_size AS matchedSize,
          o.order_role AS orderRole,
          p.condition_id AS conditionId,
          p.recurrence AS recurrence,
          p.start_time_ms AS startTimeMs,
          p.end_time_ms AS endTimeMs,
          o.price AS price
        FROM orders o
        INNER JOIN positions p ON p.id = o.position_id
        WHERE o.status IN ('open', 'partially_filled')
      `)
      .all() as PersistedOrderForTracking[];
  }

  getActiveZeroFillEntryOrders(): PersistedOpenEntryOrder[] {
    return this.db
      .prepare(`
        SELECT
          o.id AS orderId,
          o.position_id AS positionId,
          o.token_id AS tokenId,
          p.recurrence AS recurrence,
          p.start_time_ms AS startTimeMs,
          p.end_time_ms AS endTimeMs,
          o.price AS price,
          o.size AS size,
          o.matched_size AS matchedSize,
          p.filled_size AS filledSize,
          p.status AS status
        FROM orders o
        INNER JOIN positions p ON p.id = o.position_id
        WHERE o.order_role = 'entry'
          AND o.status IN ('open', 'pending_submit', 'partially_filled')
          AND p.status IN ('entry_pending', 'entry_open', 'partially_filled')
          AND o.matched_size = 0
          AND p.filled_size = 0
      `)
      .all() as PersistedOpenEntryOrder[];
  }

  getExitCandidates(): PersistedExitCandidate[] {
    return this.db
      .prepare(`
        SELECT
          id AS positionId,
          condition_id AS conditionId,
          market_id AS marketId,
          token_id AS tokenId,
          symbol,
          leg,
          recurrence,
          start_time_ms AS startTimeMs,
          end_time_ms AS endTimeMs,
          entry_target_price AS entryTargetPrice,
          entry_target_size AS entryTargetSize,
          filled_size AS filledSize,
          status,
          quote_reason AS quoteReason,
          entry_price_actual AS entryPriceActual,
          exit_price_actual AS exitPriceActual,
          realized_pnl AS realizedPnl,
          realized_spread AS realizedSpread,
          entry_fill_time_ms AS entryFillTimeMs,
          exit_fill_time_ms AS exitFillTimeMs
        FROM positions
        WHERE status IN ('fully_filled', 'exit_pending')
      `)
      .all() as PersistedExitCandidate[];
  }

  getOpenExitOrders(): PersistedOpenExitOrder[] {
    return this.db
      .prepare(`
        SELECT
          o.id AS orderId,
          o.position_id AS positionId,
          o.token_id AS tokenId,
          o.side AS side,
          o.size AS size,
          o.matched_size AS matchedSize,
          o.price AS price,
          o.created_at_ms AS createdAtMs,
          o.updated_at_ms AS updatedAtMs,
          p.condition_id AS conditionId,
          p.market_id AS marketId,
          p.symbol AS symbol,
          p.leg AS leg,
          p.recurrence AS recurrence,
          p.start_time_ms AS startTimeMs,
          p.end_time_ms AS endTimeMs,
          p.entry_target_price AS entryTargetPrice,
          p.filled_size AS filledSize,
          p.entry_price_actual AS entryPriceActual
        FROM orders o
        INNER JOIN positions p ON p.id = o.position_id
        WHERE o.order_role = 'exit' AND o.status IN ('open', 'partially_filled')
      `)
      .all() as PersistedOpenExitOrder[];
  }

  hasOpenExitOrder(positionId: string): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM orders
        WHERE position_id = ? AND order_role = 'exit' AND status IN ('open', 'partially_filled')
        LIMIT 1
      `)
      .get(positionId) as { 1: number } | undefined;

    return row !== undefined;
  }

  getActiveEntryPlacementKeys(): Array<{
    placementKey: string;
    tokenId: string;
    conditionId: string;
    recurrence: string;
    startTimeMs: number;
    endTimeMs: number;
    price: number;
    size: number;
  }> {
    const rows = this.db
      .prepare(`
        SELECT
          o.token_id AS tokenId,
          p.condition_id AS conditionId,
          p.recurrence AS recurrence,
          p.start_time_ms AS startTimeMs,
          p.end_time_ms AS endTimeMs,
          o.price AS price,
          o.size AS size
        FROM orders o
        INNER JOIN positions p ON p.id = o.position_id
        WHERE o.order_role = 'entry' AND o.status IN ('open', 'partially_filled')
      `)
      .all() as Array<{
      tokenId: string;
      conditionId: string;
      recurrence: string;
      startTimeMs: number;
      endTimeMs: number;
      price: number;
      size: number;
    }>;

    return rows.map((row) => ({
      ...row,
      placementKey: `${row.conditionId}:${row.tokenId}:${row.price}:${row.size}`,
    }));
  }

  recordFillProgress(params: {
    orderId: string;
    fillSize: number;
    cumulativeMatchedSize: number;
    eventSource: string;
    eventTimeMs: number;
  }): FillUpdateResult | null {
    const tx = this.db.transaction((input: typeof params): FillUpdateResult | null => {
      const orderRow = this.db
        .prepare(`
          SELECT
            o.id AS orderId,
            o.position_id AS positionId,
            o.order_role AS orderRole,
            o.side AS side,
            o.size AS targetSize,
            o.price AS orderPrice,
            p.filled_size AS positionFilledSize,
            p.entry_price_actual AS entryPriceActual,
            p.realized_pnl AS realizedPnl
          FROM orders o
          INNER JOIN positions p ON p.id = o.position_id
          WHERE o.id = ?
        `)
        .get(input.orderId) as
        | {
            orderId: string;
            positionId: string;
            orderRole: PersistedOrderRole;
            side: string;
            targetSize: number;
            orderPrice: number;
            positionFilledSize: number;
            entryPriceActual: number | null;
            realizedPnl: number | null;
          }
        | undefined;

      if (!orderRow) {
        return null;
      }

      const orderStatus: PersistedOrderStatus =
        input.cumulativeMatchedSize >= orderRow.targetSize ? "filled" : "partially_filled";

      this.db
        .prepare(`
          UPDATE orders
          SET matched_size = ?, status = ?, updated_at_ms = ?
          WHERE id = ?
        `)
        .run(input.cumulativeMatchedSize, orderStatus, Date.now(), input.orderId);

      this.db
        .prepare(`
          INSERT OR REPLACE INTO fills (
            id, order_id, fill_size, cumulative_matched_size, event_source, event_time_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          `${input.orderId}:${input.cumulativeMatchedSize}`,
          input.orderId,
          input.fillSize,
          input.cumulativeMatchedSize,
          input.eventSource,
          input.eventTimeMs,
          Date.now(),
        );

      let positionFilledSize = orderRow.positionFilledSize;
      let positionStatus: PersistedPositionStatus;

      if (orderRow.orderRole === "entry") {
        positionFilledSize = input.cumulativeMatchedSize;
        positionStatus =
          input.cumulativeMatchedSize >= orderRow.targetSize ? "fully_filled" : "partially_filled";

        this.db
          .prepare(`
            UPDATE positions
            SET filled_size = ?, status = ?, entry_price_actual = ?, entry_fill_time_ms = ?, updated_at_ms = ?
            WHERE id = ?
          `)
          .run(
            positionFilledSize,
            positionStatus,
            orderRow.orderPrice,
            input.cumulativeMatchedSize >= orderRow.targetSize ? input.eventTimeMs : null,
            Date.now(),
            orderRow.positionId,
          );
      } else {
        positionFilledSize = Math.max(0, orderRow.positionFilledSize - input.fillSize);
        positionStatus = input.cumulativeMatchedSize >= orderRow.targetSize ? "closed" : "exit_open";
        const entryPrice = orderRow.entryPriceActual ?? 0;
        const realizedSpread = orderRow.orderPrice - entryPrice;
        const realizedPnl = (orderRow.realizedPnl ?? 0) + realizedSpread * input.fillSize;

        this.db
          .prepare(`
            UPDATE positions
            SET filled_size = ?, status = ?, exit_price_actual = ?, realized_spread = ?, realized_pnl = ?, exit_fill_time_ms = ?, updated_at_ms = ?
            WHERE id = ?
          `)
          .run(
            positionFilledSize,
            positionStatus,
            orderRow.orderPrice,
            realizedSpread,
            realizedPnl,
            input.cumulativeMatchedSize >= orderRow.targetSize ? input.eventTimeMs : null,
            Date.now(),
            orderRow.positionId,
          );
      }

      return {
        positionId: orderRow.positionId,
        orderRole: orderRow.orderRole,
        side: orderRow.side,
        cumulativeMatchedSize: input.cumulativeMatchedSize,
        targetSize: orderRow.targetSize,
        positionFilledSize,
        positionStatus,
      };
    });

    return tx(params);
  }

  markPositionStatus(positionId: string, status: PersistedPositionStatus): void {
    this.db
      .prepare(`
        UPDATE positions
        SET status = ?, updated_at_ms = ?
        WHERE id = ?
      `)
      .run(status, Date.now(), positionId);
  }

  markEntryExpired(positionId: string, reason: string): void {
    this.db
      .prepare(`
        UPDATE positions
        SET status = 'entry_expired', quote_reason = ?, updated_at_ms = ?
        WHERE id = ?
      `)
      .run(reason, Date.now(), positionId);
  }

  getMockBalance(startingBalance = 5): number {
    const totals = this.db
      .prepare(`
        SELECT
          COALESCE(SUM(entry_fill_price * entry_size), 0) AS total_entry_notional,
          COALESCE(
            SUM(
              CASE
                WHEN exit_fill_price IS NOT NULL AND exit_size IS NOT NULL
                  THEN exit_fill_price * exit_size
                ELSE 0
              END
            ),
            0
          ) AS total_exit_notional
        FROM paper_trades
      `)
      .get() as
      | {
        total_entry_notional?: number | null;
        total_exit_notional?: number | null;
      }
      | undefined;

    const totalEntryNotional = Number(totals?.total_entry_notional ?? 0);
    const totalExitNotional = Number(totals?.total_exit_notional ?? 0);

    return Number((startingBalance - totalEntryNotional + totalExitNotional).toFixed(4));
  }

  upsertPaperTradeEntry(input: UpsertPaperTradeEntryInput): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO paper_trades (
          id,
          position_id,
          condition_id,
          market_id,
          token_id,
          market_name,
          symbol,
          leg,
          recurrence,
          scheduler_tick_id,
          scheduler_cycle_label,
          scheduler_tick_started_ms,
          scheduler_expected_interval_ms,
          scheduler_actual_interval_ms,
          target_cycle_start_ms,
          entry_quote_price,
          entry_fill_price,
          entry_size,
          quote_reason,
          entry_time_ms,
          created_at_ms,
          updated_at_ms
        ) VALUES (
          @positionId,
          @positionId,
          @conditionId,
          @marketId,
          @tokenId,
          @marketName,
          @symbol,
          @leg,
          @recurrence,
          @schedulerTickId,
          @schedulerCycleLabel,
          @schedulerTickStartedMs,
          @schedulerExpectedIntervalMs,
          @schedulerActualIntervalMs,
          @targetCycleStartMs,
          @entryQuotePrice,
          @entryFillPrice,
          @entrySize,
          @quoteReason,
          @entryTimeMs,
          @createdAtMs,
          @updatedAtMs
        )
        ON CONFLICT(position_id) DO UPDATE SET
          condition_id = excluded.condition_id,
          market_id = excluded.market_id,
          token_id = excluded.token_id,
          market_name = excluded.market_name,
          symbol = excluded.symbol,
          leg = excluded.leg,
          recurrence = excluded.recurrence,
          scheduler_tick_id = excluded.scheduler_tick_id,
          scheduler_cycle_label = excluded.scheduler_cycle_label,
          scheduler_tick_started_ms = excluded.scheduler_tick_started_ms,
          scheduler_expected_interval_ms = excluded.scheduler_expected_interval_ms,
          scheduler_actual_interval_ms = excluded.scheduler_actual_interval_ms,
          target_cycle_start_ms = excluded.target_cycle_start_ms,
          entry_quote_price = excluded.entry_quote_price,
          entry_fill_price = excluded.entry_fill_price,
          entry_size = excluded.entry_size,
          quote_reason = excluded.quote_reason,
          entry_time_ms = excluded.entry_time_ms,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run({
        ...input,
        createdAtMs: now,
        updatedAtMs: now,
      });
  }

  finalizePaperTradeExit(input: FinalizePaperTradeExitInput): void {
    this.db
      .prepare(`
        UPDATE paper_trades
        SET
          exit_quote_price = ?,
          exit_fill_price = ?,
          exit_size = ?,
          exit_reason = ?,
          exit_time_ms = ?,
          holding_time_ms = ?,
          realized_spread = ?,
          realized_pnl = ?,
          updated_at_ms = ?
        WHERE position_id = ?
      `)
      .run(
        input.exitQuotePrice,
        input.exitFillPrice,
        input.exitSize,
        input.exitReason,
        input.exitTimeMs,
        input.holdingTimeMs ?? null,
        input.realizedSpread ?? null,
        input.realizedPnl ?? null,
        Date.now(),
        input.positionId,
      );
  }

  finalizePaperSchedulerTick(tickId: string, completedAtMs: number): void {
    this.db
      .prepare(`
        UPDATE paper_trades
        SET scheduler_tick_completed_ms = ?, updated_at_ms = ?
        WHERE scheduler_tick_id = ? AND scheduler_tick_completed_ms IS NULL
      `)
      .run(completedAtMs, Date.now(), tickId);
  }

  markExitReason(positionId: string, exitReason: string): void {
    this.db
      .prepare(`
        UPDATE positions
        SET exit_reason = ?, updated_at_ms = ?
        WHERE id = ?
      `)
      .run(exitReason, Date.now(), positionId);
  }

  markDustStranded(positionId: string, exitReason: string): void {
    this.db
      .prepare(`
        UPDATE positions
        SET status = 'dust_stranded', exit_reason = ?, updated_at_ms = ?
        WHERE id = ?
      `)
      .run(exitReason, Date.now(), positionId);
  }

  getPositionForExit(positionId: string): PersistedExitCandidate | undefined {
    return this.db
      .prepare(`
        SELECT
          id AS positionId,
          condition_id AS conditionId,
          market_id AS marketId,
          token_id AS tokenId,
          symbol,
          leg,
          recurrence,
          start_time_ms AS startTimeMs,
          end_time_ms AS endTimeMs,
          entry_target_price AS entryTargetPrice,
          entry_target_size AS entryTargetSize,
          filled_size AS filledSize,
          status,
          quote_reason AS quoteReason,
          entry_price_actual AS entryPriceActual,
          exit_price_actual AS exitPriceActual,
          realized_pnl AS realizedPnl,
          realized_spread AS realizedSpread,
          entry_fill_time_ms AS entryFillTimeMs,
          exit_fill_time_ms AS exitFillTimeMs
        FROM positions
        WHERE id = ?
      `)
      .get(positionId) as PersistedExitCandidate | undefined;
  }
}
