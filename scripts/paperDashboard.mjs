import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import express from "express";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const dbPath = path.resolve(projectRoot, process.env.STATE_DB_PATH ?? "data/state.sqlite");
const port = Number(process.env.PAPER_DASHBOARD_PORT ?? 3001);
const startingMockBalance = 5;
const app = express();

let db = null;
let hasPaperTradesTable = false;

try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  hasPaperTradesTable = Boolean(
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_trades' LIMIT 1",
    ).get(),
  );
} catch (error) {
  console.warn(`Paper dashboard startup warning: ${error instanceof Error ? error.message : String(error)}`);
}

const json = (handler) => (_req, res) => {
  try {
    res.json(handler());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
};

const getActionRows = () => {
  if (!db || !hasPaperTradesTable) {
    return [];
  }

  const positions = db.prepare(`
    SELECT
      position_id AS positionId,
      market_name AS marketName,
      symbol,
      leg,
      entry_fill_price AS entryPrice,
      entry_size AS entrySize,
      quote_reason AS quoteReason,
      entry_time_ms AS entryTimeMs,
      exit_fill_price AS exitPrice,
      exit_size AS exitSize,
      exit_reason AS exitReason,
      exit_time_ms AS exitTimeMs,
      realized_pnl AS realizedPnl
    FROM paper_trades
  `).all();

  const actions = [];

  for (const row of positions) {
    actions.push({
      positionId: row.positionId,
      time: row.entryTimeMs,
      action: "BUY",
      marketName: row.marketName ?? row.symbol,
      symbol: row.symbol,
      leg: row.leg,
      price: row.entryPrice,
      size: row.entrySize,
      fulfilled: row.entrySize,
      reason: row.quoteReason,
      realizedPnl: null,
    });

    if (row.exitTimeMs !== null && row.exitPrice !== null) {
      actions.push({
        positionId: row.positionId,
        time: row.exitTimeMs,
        action: "SELL",
        marketName: row.marketName ?? row.symbol,
        symbol: row.symbol,
        leg: row.leg,
        price: row.exitPrice,
        size: row.exitSize ?? row.entrySize,
        fulfilled: row.exitSize ?? 0,
        reason: row.exitReason,
        realizedPnl: row.realizedPnl,
      });
    }
  }

  actions.sort((left, right) => {
    if (left.time !== right.time) {
      return left.time - right.time;
    }

    if (left.action !== right.action) {
      return left.action === "BUY" ? -1 : 1;
    }

    return left.positionId.localeCompare(right.positionId);
  });

  let runningBalance = startingMockBalance;

  return actions.map((row) => {
    const notional = Number((row.price * row.size).toFixed(4));
    runningBalance += row.action === "BUY" ? -notional : notional;

    return {
      ...row,
      mockBalance: Number(runningBalance.toFixed(4)),
    };
  });
};

const getPendingRows = () => {
  if (!db) {
    return [];
  }

  const selectPendingRows = hasPaperTradesTable
    ? `
      SELECT
        o.id AS orderId,
        o.position_id AS positionId,
        COALESCE(pt.market_name, p.symbol || ' ' || p.recurrence || ' market') AS marketName,
        p.symbol AS symbol,
        p.leg AS leg,
        CASE WHEN o.order_role = 'exit' THEN 'SELL' ELSE 'BUY' END AS action,
        o.price AS targetPrice,
        o.size AS size,
        CASE
          WHEN o.order_role = 'exit' THEN COALESCE(p.exit_reason, 'pending-exit')
          ELSE COALESCE(p.quote_reason, 'pending-entry')
        END AS reason,
        p.start_time_ms AS marketOpenMs,
        p.end_time_ms AS marketCloseMs
      FROM orders o
      INNER JOIN positions p ON p.id = o.position_id
      LEFT JOIN paper_trades pt ON pt.position_id = o.position_id
      WHERE o.id LIKE 'paper:%'
        AND o.status IN ('open', 'pending_submit', 'partially_filled')
      ORDER BY p.start_time_ms ASC, o.created_at_ms ASC, o.id ASC
    `
    : `
      SELECT
        o.id AS orderId,
        o.position_id AS positionId,
        p.symbol || ' ' || p.recurrence || ' market' AS marketName,
        p.symbol AS symbol,
        p.leg AS leg,
        CASE WHEN o.order_role = 'exit' THEN 'SELL' ELSE 'BUY' END AS action,
        o.price AS targetPrice,
        o.size AS size,
        CASE
          WHEN o.order_role = 'exit' THEN COALESCE(p.exit_reason, 'pending-exit')
          ELSE COALESCE(p.quote_reason, 'pending-entry')
        END AS reason,
        p.start_time_ms AS marketOpenMs,
        p.end_time_ms AS marketCloseMs
      FROM orders o
      INNER JOIN positions p ON p.id = o.position_id
      WHERE o.id LIKE 'paper:%'
        AND o.status IN ('open', 'pending_submit', 'partially_filled')
      ORDER BY p.start_time_ms ASC, o.created_at_ms ASC, o.id ASC
    `;

  return db.prepare(selectPendingRows).all();
};

app.get("/api/summary", json(() => ({
  dbPath,
  hasPaperTradesTable,
  startingMockBalance,
  actions: getActionRows(),
})));

app.get("/api/pending", json(() => ({
  dbPath,
  hasPaperTradesTable,
  pending: getPendingRows(),
})));

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Paper Trading Dashboard</title>
    <style>
      :root {
        --bg: #f6f3eb;
        --card: #fffdf8;
        --line: #d8cfbe;
        --ink: #1f1d19;
        --muted: #6e6658;
        --accent: #0f766e;
        --danger: #b91c1c;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.08), transparent 35%),
          radial-gradient(circle at top right, rgba(185, 28, 28, 0.08), transparent 30%),
          var(--bg);
        color: var(--ink);
      }

      main {
        max-width: 1280px;
        margin: 0 auto;
        padding: 24px;
      }

      .hero,
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 10px 30px rgba(31, 29, 25, 0.04);
      }

      .hero {
        margin-bottom: 20px;
      }

      h1, h2 {
        margin: 0 0 10px;
      }

      p {
        margin: 0;
        color: var(--muted);
      }

      .pill {
        display: inline-block;
        margin-bottom: 10px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        background: rgba(15, 118, 110, 0.15);
        color: var(--accent);
      }

      .table-wrap {
        overflow-x: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }

      th, td {
        padding: 12px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        white-space: nowrap;
      }

      th {
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .positive {
        color: var(--accent);
      }

      .negative {
        color: var(--danger);
      }

      .market-row td {
        padding-top: 16px;
        padding-bottom: 8px;
        border-bottom: none;
        font-size: 12px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .market-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        border: 1px solid rgba(15, 118, 110, 0.18);
      }

      .section-stack {
        display: grid;
        gap: 20px;
      }

      .empty-row td {
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="pill">Paper Trading</span>
        <h1>Action Ledger</h1>
        <p id="meta">Loading paper trading actions...</p>
      </section>

      <div class="section-stack">
        <section class="card">
          <h2>Pending / Unfulfilled Actions</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Symbol</th>
                  <th>Leg</th>
                  <th>Action</th>
                  <th>Target Price</th>
                  <th>Size</th>
                  <th>Reason</th>
                  <th>Market Open (Est)</th>
                  <th>Market Close (Est)</th>
                </tr>
              </thead>
              <tbody id="pendingBody"></tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2>Completed Actions</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Market</th>
                  <th>Symbol</th>
                  <th>Leg</th>
                  <th>Price</th>
                  <th>Size</th>
                  <th>Fulfilled</th>
                  <th>Reason</th>
                  <th>Realized PnL</th>
                  <th>Mock Balance</th>
                </tr>
              </thead>
              <tbody id="actionsBody"></tbody>
            </table>
          </div>
        </section>
      </div>
    </main>

    <script>
      const POLL_INTERVAL_MS = 2000;
      const fmt = (value) => Number(value ?? 0).toFixed(4);
      const fmtTime = (value) => value
        ? new Date(value).toLocaleString("en-US", {
          timeZone: "America/New_York",
          hour12: true,
        })
        : "-";
      const escapeHtml = (value) => String(value ?? "-")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

      const groupActionsByMarket = (actions) => {
        const groups = [];
        const byMarket = new Map();

        actions.forEach((row) => {
          const marketName = row.marketName || row.symbol || "Unknown market";
          let group = byMarket.get(marketName);
          if (!group) {
            group = { marketName, rows: [] };
            byMarket.set(marketName, group);
            groups.push(group);
          }

          group.rows.push(row);
        });

        return groups;
      };

      const renderActions = (actions) => {
        const tbody = document.getElementById("actionsBody");
        const groups = groupActionsByMarket(actions);

        if (groups.length === 0) {
          tbody.innerHTML = "<tr class='empty-row'><td colspan='11'>No completed paper actions yet.</td></tr>";
          return;
        }

        tbody.innerHTML = groups.map((group) => {
          const header = "<tr class='market-row'><td colspan='11'><span class='market-chip'>" +
            escapeHtml(group.marketName) +
            "</span></td></tr>";

          const rows = group.rows.map((row) => {
            const pnlClass = (row.realizedPnl ?? 0) >= 0 ? "positive" : "negative";
            const balanceClass = (row.mockBalance ?? 0) >= 0 ? "positive" : "negative";
            return "<tr>" +
              "<td>" + fmtTime(row.time) + "</td>" +
              "<td>" + escapeHtml(row.action) + "</td>" +
              "<td>" + escapeHtml(row.marketName || row.symbol || "-") + "</td>" +
              "<td>" + escapeHtml(row.symbol) + "</td>" +
              "<td>" + escapeHtml(row.leg) + "</td>" +
              "<td>" + fmt(row.price) + "</td>" +
              "<td>" + fmt(row.size) + "</td>" +
              "<td>" + fmt(row.fulfilled) + "</td>" +
              "<td>" + escapeHtml(row.reason ?? "-") + "</td>" +
              "<td class='" + pnlClass + "'>" + (row.realizedPnl == null ? "-" : fmt(row.realizedPnl)) + "</td>" +
              "<td class='" + balanceClass + "'>" + fmt(row.mockBalance) + "</td>" +
            "</tr>";
          }).join("");

          return header + rows;
        }).join("");
      };

      const renderPending = (pendingRows) => {
        const tbody = document.getElementById("pendingBody");

        if (pendingRows.length === 0) {
          tbody.innerHTML = "<tr class='empty-row'><td colspan='9'>No pending paper orders.</td></tr>";
          return;
        }

        tbody.innerHTML = pendingRows.map((row) =>
          "<tr>" +
            "<td>" + escapeHtml(row.marketName || row.symbol || "-") + "</td>" +
            "<td>" + escapeHtml(row.symbol) + "</td>" +
            "<td>" + escapeHtml(row.leg) + "</td>" +
            "<td>" + escapeHtml(row.action) + "</td>" +
            "<td>" + fmt(row.targetPrice) + "</td>" +
            "<td>" + fmt(row.size) + "</td>" +
            "<td>" + escapeHtml(row.reason ?? "-") + "</td>" +
            "<td>" + fmtTime(row.marketOpenMs) + "</td>" +
            "<td>" + fmtTime(row.marketCloseMs) + "</td>" +
          "</tr>"
        ).join("");
      };

      const requestJson = async (url) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(url + " returned " + response.status);
        }

        return response.json();
      };

      let refreshInFlight = false;

      const refreshDashboard = async () => {
        if (refreshInFlight) {
          return;
        }

        refreshInFlight = true;

        try {
          const [summary, pending] = await Promise.all([
            requestJson("/api/summary"),
            requestJson("/api/pending"),
          ]);

          const meta = document.getElementById("meta");
          meta.textContent = summary.hasPaperTradesTable
            ? "Running mock balance starts at $" + fmt(summary.startingMockBalance) +
              ", is computed chronologically across all actions, and refreshes every " +
              (POLL_INTERVAL_MS / 1000) +
              "s without a page reload. Completed actions: " +
              summary.actions.length +
              ". Pending orders: " +
              pending.pending.length +
              ". Source: " + summary.dbPath
            : "paper_trades table not found yet. Run the bot with DRY_RUN=true to populate it.";

          renderActions(summary.actions);
          renderPending(pending.pending);
        } catch (error) {
          document.getElementById("meta").textContent = "Dashboard load failed: " + error.message;
        } finally {
          refreshInFlight = false;
        }
      };

      void refreshDashboard();
      setInterval(() => {
        void refreshDashboard();
      }, POLL_INTERVAL_MS);
    </script>
  </body>
</html>`);
});

app.listen(port, () => {
  console.log(`Paper dashboard listening on http://localhost:${port}`);
  console.log(`SQLite source: ${dbPath}`);
});
