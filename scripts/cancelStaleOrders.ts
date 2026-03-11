import Database from "better-sqlite3";
import path from "node:path";
import { env } from "../src/config/env.js";
import { ClobClientService } from "../src/services/clobClient.js";

type CandidateRow = {
  orderId: string;
  positionId: string;
  orderRole: string;
  orderStatus: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
  positionStatus: string;
};

const isDryRun = process.env.DRY_RUN !== "false";
const dbPath = path.isAbsolute(env.STATE_DB_PATH)
  ? env.STATE_DB_PATH
  : path.resolve(process.cwd(), env.STATE_DB_PATH);

const db = new Database(dbPath);

const candidateRows = db
  .prepare(
    `
      SELECT
        o.id AS orderId,
        o.position_id AS positionId,
        o.order_role AS orderRole,
        o.status AS orderStatus,
        o.token_id AS tokenId,
        o.side AS side,
        o.price AS price,
        o.size AS size,
        p.status AS positionStatus
      FROM orders o
      INNER JOIN positions p ON p.id = o.position_id
      WHERE o.status IN ('open', 'pending_submit', 'partially_filled')
      ORDER BY o.created_at_ms ASC
    `,
  )
  .all() as CandidateRow[];

const countBy = <T>(items: T[], keyFn: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

console.log(`Cleanup mode: ${isDryRun ? "DRY_RUN" : "LIVE"}`);
console.log(`SQLite DB: ${dbPath}`);
console.log(`Candidate orders: ${candidateRows.length}`);
console.log(`By role/status: ${JSON.stringify(countBy(candidateRows, (row) => `${row.orderRole}:${row.orderStatus}`))}`);

if (candidateRows.length === 0) {
  console.log("No stale orders found.");
  process.exit(0);
}

for (const row of candidateRows) {
  console.log(
    `[TARGET] orderId=${row.orderId} positionId=${row.positionId} role=${row.orderRole} status=${row.orderStatus} side=${row.side} tokenId=${row.tokenId} price=${row.price} size=${row.size} positionStatus=${row.positionStatus}`,
  );
}

if (isDryRun) {
  console.log("DRY_RUN enabled. No exchange cancellations or database updates were performed.");
  process.exit(0);
}

const clobClientService = new ClobClientService();
const client = clobClientService.getClient();

const markOrderCancelled = db.prepare(
  `
    UPDATE orders
    SET status = 'cancelled', updated_at_ms = ?, last_error = NULL
    WHERE id = ?
  `,
);

const countRemainingActiveOrders = db.prepare(
  `
    SELECT COUNT(*) AS count
    FROM orders
    WHERE position_id = ? AND status IN ('open', 'pending_submit', 'partially_filled')
  `,
);

const closePosition = db.prepare(
  `
    UPDATE positions
    SET status = 'closed', updated_at_ms = ?
    WHERE id = ?
  `,
);

let cancelled = 0;
let alreadyMissing = 0;
let failed = 0;
let positionsClosed = 0;

for (const row of candidateRows) {
  try {
    await client.cancelOrder({ orderID: row.orderId });
    markOrderCancelled.run(Date.now(), row.orderId);
    cancelled += 1;
    console.log(`[CANCELLED] orderId=${row.orderId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    const notFound =
      normalized.includes("not found") ||
      normalized.includes("no such") ||
      normalized.includes("already") ||
      normalized.includes("does not exist") ||
      normalized.includes("invalid order");

    if (notFound) {
      markOrderCancelled.run(Date.now(), row.orderId);
      alreadyMissing += 1;
      console.log(`[MISSING-REMOTELY] orderId=${row.orderId} message=${message}`);
    } else {
      failed += 1;
      console.log(`[FAILED] orderId=${row.orderId} message=${message}`);
      continue;
    }
  }

  const remaining = countRemainingActiveOrders.get(row.positionId) as { count: number };
  if (remaining.count === 0) {
    closePosition.run(Date.now(), row.positionId);
    positionsClosed += 1;
    console.log(`[POSITION-CLOSED] positionId=${row.positionId}`);
  }
}

console.log(
  `Summary: cancelled=${cancelled} alreadyMissing=${alreadyMissing} failed=${failed} positionsClosed=${positionsClosed}`,
);
