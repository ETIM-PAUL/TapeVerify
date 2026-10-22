import { computeStats, loadTraderData } from "@pit/shared";
import { StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { FillsIngester } from "../src/fills/ingest.js";
import { silentLogger } from "../src/log.js";
import { rebuildTrades } from "../src/stats/trades.js";
import { testPool } from "./helpers.js";

const ACCOUNT = "stats-acct";
const H = 3_600_000;
const T0 = 1_700_000_000_000;
let pool: pg.Pool;

const insertFill = (id: number, o: Record<string, unknown>) =>
  pool.query(
    `INSERT INTO fills (account_id, id, trade_id, order_id, symbol, side, role, price, size, realized_pnl, fee, fee_type, ts_ms, raw)
     VALUES ($1,$2,$3,$4,$5,$6,'taker',$7,$8,$9,$10,$11,$12,'{}')`,
    [
      ACCOUNT,
      `f${id}`,
      id,
      `o${id}`,
      o.symbol ?? "BTC-USD",
      o.side,
      o.price,
      o.size,
      o.pnl ?? "0",
      o.fee ?? "0.1",
      o.feeType ?? "commission",
      o.ts,
    ],
  );
const insertFunding = (id: number, symbol: string, amount: string, ts: number) =>
  pool.query(
    "INSERT INTO funding_payments (account_id, id, symbol, amount, ts_ms, raw) VALUES ($1,$2,$3,$4,$5,'{}')",
    [ACCOUNT, `g${id}`, symbol, amount, ts],
  );

beforeAll(() => {
  pool = testPool();
});
beforeEach(async () => {
  for (const t of ["fills", "funding_payments", "account_transactions", "trades"])
    await pool.query(`DELETE FROM ${t} WHERE account_id = $1`, [ACCOUNT]);
  await pool.query("DELETE FROM ingest_status WHERE key = $1", [`trades:${ACCOUNT}`]);
});
afterAll(async () => {
  for (const t of ["fills", "funding_payments", "account_transactions", "trades"])
    await pool.query(`DELETE FROM ${t} WHERE account_id = $1`, [ACCOUNT]);
  await pool.end();
});

describe("rebuildTrades", () => {
  it("builds trades from stored fills, attributes funding by market and time, and links every fill", async () => {
    await insertFill(1, { side: "buy", price: "80000", size: "0.002", ts: T0 });
    await insertFill(2, {
      side: "sell",
      price: "84000",
      size: "0.002",
      pnl: "8",
      fee: "0.17",
      ts: T0 + 2 * H,
    });
    await insertFill(3, { side: "buy", price: "2400", size: "1", symbol: "ETH-USD", ts: T0 + H });
    await insertFill(4, {
      side: "sell",
      price: "2300",
      size: "1",
      symbol: "ETH-USD",
      pnl: "-100",
      ts: T0 + 3 * H,
    });
    await insertFunding(1, "BTC-USD", "-0.5", T0 + H); // inside the BTC trade
    await insertFunding(2, "BTC-USD", "-9", T0 + 5 * H); // after it: not part of the trade
    await insertFunding(3, "ETH-USD", "0.25", T0 + 2 * H); // inside the ETH trade
    await insertFunding(4, "ETH-USD", "1", T0 - H); // before it

    const r = await rebuildTrades(pool, ACCOUNT);
    expect(r).toEqual({ trades: 2, rebuilt: true });
    const { rows } = await pool.query(
      "SELECT * FROM trades WHERE account_id = $1 ORDER BY symbol",
      [ACCOUNT],
    );
    expect(
      rows.map((x) => [
        x.symbol,
        x.side,
        Number(x.gross_pnl),
        Number(x.fees),
        Number(x.funding),
        Number(x.net_pnl),
      ]),
    ).toEqual([
      ["BTC-USD", "long", 8, 0.27, -0.5, 7.23],
      ["ETH-USD", "long", -100, 0.2, 0.25, -99.95],
    ]);
    expect(Number(rows[0].entry_notional)).toBe(160);

    const legs = await pool.query(
      "SELECT tf.leg, f.id FROM trade_fills tf JOIN trades t ON t.id = tf.trade_id JOIN fills f ON f.account_id = t.account_id AND f.id = tf.fill_id WHERE t.account_id = $1",
      [ACCOUNT],
    );
    expect(legs.rowCount).toBe(4); // all four legs resolve to stored Strike fills
  });

  it("skips when nothing changed, rebuilds idempotently when fills or funding change", async () => {
    await insertFill(1, { side: "buy", price: "100", size: "1", ts: T0 });
    await insertFill(2, { side: "sell", price: "110", size: "1", pnl: "10", ts: T0 + H });
    expect((await rebuildTrades(pool, ACCOUNT)).rebuilt).toBe(true);
    expect((await rebuildTrades(pool, ACCOUNT)).rebuilt).toBe(false);
    await insertFunding(1, "BTC-USD", "0.5", T0 + 1000);
    expect((await rebuildTrades(pool, ACCOUNT)).rebuilt).toBe(true);
    await insertFill(3, { side: "buy", price: "100", size: "1", ts: T0 + 2 * H });
    await insertFill(4, { side: "sell", price: "90", size: "1", pnl: "-10", ts: T0 + 3 * H });
    expect(await rebuildTrades(pool, ACCOUNT)).toEqual({ trades: 2, rebuilt: true });
    const n = await pool.query("SELECT count(*) AS n FROM trades WHERE account_id = $1", [ACCOUNT]);
    expect(Number(n.rows[0].n)).toBe(2); // replaced, not duplicated
  });

  it("copes with maker rebates (negative fees) and positions still open", async () => {
    await insertFill(1, { side: "buy", price: "100", size: "2", fee: "-0.02", ts: T0 });
    await insertFill(2, {
      side: "sell",
      price: "110",
      size: "1",
      pnl: "10",
      fee: "0.05",
      ts: T0 + H,
    }); // half closed: still open
    expect((await rebuildTrades(pool, ACCOUNT)).trades).toBe(0);
    await insertFill(3, {
      side: "sell",
      price: "120",
      size: "1",
      pnl: "20",
      fee: "0.05",
      ts: T0 + 2 * H,
    });
    await rebuildTrades(pool, ACCOUNT);
    const t = (
      await pool.query("SELECT gross_pnl, fees FROM trades WHERE account_id = $1", [ACCOUNT])
    ).rows[0];
    expect([Number(t.gross_pnl), Number(t.fees)]).toEqual([30, 0.08]);
  });
});

describe("capital flows and end-to-end stats", () => {
  function strike(txs: Array<Record<string, unknown>>) {
    const f = (async (input: string | URL) => {
      const u = new URL(String(input));
      if (u.pathname === "/v2/history/transaction")
        return new Response(JSON.stringify({ transactions: txs, count: txs.length }));
      if (u.pathname === "/v2/history/fill")
        return new Response(JSON.stringify({ fills: null, count: 0 }));
      return new Response(JSON.stringify({ funding: null, count: 0 }));
    }) as typeof fetch;
    return new StrikeClient({ baseUrl: "https://x.test", fetch: f });
  }

  it("ingests deposits/withdrawals and scores returns on the resulting equity", async () => {
    await insertFill(1, { side: "buy", price: "100", size: "10", fee: "0", ts: T0 + H });
    await insertFill(2, {
      side: "sell",
      price: "110",
      size: "10",
      pnl: "100",
      fee: "0",
      ts: T0 + 2 * H,
    });
    const txs = [
      { id: 2, type: "withdraw", amount: "300", status: "completed", timestamp: T0 + 3 * H },
      { id: 1, type: "deposit", amount: "1000", status: "pending_settlement", timestamp: T0 },
      { id: 3, type: "deposit", amount: "50", status: "failed", timestamp: T0 + H },
    ];
    const ing = new FillsIngester(strike(txs), pool, loadWorkerConfig({}), silentLogger);
    const r = await ing.syncAccount(ACCOUNT);
    expect(r).toMatchObject({ transactions: 3, trades: 1 });

    const data = await loadTraderData(pool, ACCOUNT);
    expect(data.flows.map((f) => f.amount)).toEqual(["1000", "-300"]); // the failed deposit is ignored
    const s = computeStats(data.trades, data.flows);
    expect(s.trades).toBe(1);
    expect(s.netPnl).toBe("100");
    expect(s.totalReturnPct).toBeCloseTo(10, 6); // 100 on $1000 (the later withdrawal isn't a loss)
    expect(data.fillCount).toBe(2);
  });
});
