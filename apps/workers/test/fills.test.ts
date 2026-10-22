import { StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { FillsIngester } from "../src/fills/ingest.js";
import { silentLogger } from "../src/log.js";
import { testPool } from "./helpers.js";

const ACCOUNT = "test-account-fills";
let pool: pg.Pool;

const fill = (tradeId: number) => ({
  id: `f${tradeId}`,
  trade_id: tradeId,
  order_id: `o${tradeId}`,
  account_id: ACCOUNT,
  symbol: "BTC-USD",
  side: "buy",
  role: "taker",
  price: "100.5",
  size: "0.1",
  realized_pnl: "1.25",
  fee: "0.01",
  fee_type: "commission",
  timestamp: 1_700_000_000_000 + tradeId,
  leverage: 5,
});
const funding = (id: number) => ({
  id: `g${id}`,
  account_id: ACCOUNT,
  symbol: "BTC-USD",
  position_size: "1",
  position_side: "Long",
  funding_rate: "0.0001",
  amount: "-0.5",
  timestamp: 1_700_000_000_000 + id,
});

/** Fake Strike history: fills ascending by trade_id (since_trade_id), funding newest-first (fromId). */
function history(state: { fills: number; funding: number }) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const u = new URL(String(input));
    requests.push(u.pathname + u.search);
    const limit = Number(u.searchParams.get("limit") ?? 100);
    if (u.pathname === "/v2/history/fill") {
      const since = Number(u.searchParams.get("since_trade_id") ?? 0);
      const rows = [];
      for (let t = since + 1; t <= state.fills && rows.length < limit; t++) rows.push(fill(t));
      return new Response(JSON.stringify({ fills: rows.length ? rows : null, count: rows.length }));
    }
    const from = u.searchParams.get("fromId");
    const below = from ? Number(from.slice(1)) : state.funding + 1;
    const rows = [];
    for (let i = below - 1; i >= 1 && rows.length < limit; i--) rows.push(funding(i));
    return new Response(JSON.stringify({ funding: rows.length ? rows : null, count: rows.length }));
  }) as typeof fetch;
  return { client: new StrikeClient({ baseUrl: "https://x.test", fetch: fetchImpl }), requests };
}

const ingester = (client: StrikeClient) =>
  new FillsIngester(client, pool, loadWorkerConfig({}), silentLogger);

beforeAll(() => {
  pool = testPool();
});
beforeEach(async () => {
  await pool.query("DELETE FROM fills WHERE account_id = $1", [ACCOUNT]);
  await pool.query("DELETE FROM funding_payments WHERE account_id = $1", [ACCOUNT]);
});
afterAll(async () => {
  await pool.query("DELETE FROM users WHERE strike_account_id = $1", [ACCOUNT]);
  await pool.end();
});

describe("fills ingestion", () => {
  it("backfills every fill across pages, then only fetches what's new", async () => {
    const state = { fills: 2500, funding: 0 };
    const { client, requests } = history(state);
    const ing = ingester(client);
    expect(await ing.syncFills(ACCOUNT)).toBe(2500);
    const { rows } = await pool.query(
      "SELECT count(*) AS n, max(trade_id) AS hi FROM fills WHERE account_id = $1",
      [ACCOUNT],
    );
    expect(Number(rows[0].n)).toBe(2500);
    expect(Number(rows[0].hi)).toBe(2500);

    requests.length = 0;
    expect(await ing.syncFills(ACCOUNT)).toBe(0); // idempotent; re-reads at most the newest trade
    expect(requests).toHaveLength(1);

    state.fills = 2503;
    expect(await ing.syncFills(ACCOUNT)).toBe(3);
  });

  it("stores the exact Strike values and the raw record", async () => {
    const { client } = history({ fills: 1, funding: 0 });
    await ingester(client).syncFills(ACCOUNT);
    const { rows } = await pool.query("SELECT * FROM fills WHERE account_id = $1", [ACCOUNT]);
    expect(rows[0]).toMatchObject({
      id: "f1",
      symbol: "BTC-USD",
      side: "buy",
      role: "taker",
      fee_type: "commission",
    });
    expect(Number(rows[0].price)).toBe(100.5);
    expect(Number(rows[0].realized_pnl)).toBe(1.25);
    expect(rows[0].raw.order_id).toBe("o1");
  });

  it("backfills funding newest-first and stops as soon as it reaches stored rows", async () => {
    const state = { fills: 0, funding: 1500 };
    const { client, requests } = history(state);
    const ing = ingester(client);
    expect(await ing.syncFunding(ACCOUNT)).toBe(1500);

    requests.length = 0;
    state.funding = 1502;
    expect(await ing.syncFunding(ACCOUNT)).toBe(2);
    expect(requests).toHaveLength(1); // newest page already contained known rows: nothing older to fetch
  });

  it("syncs all connected users and skips ones without a Strike account", async () => {
    await pool.query(
      "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) ON CONFLICT DO NOTHING",
      ["fills-test-address-0000000000000000", ACCOUNT],
    );
    await pool.query(
      "INSERT INTO users (chain, address) VALUES ('solana', $1) ON CONFLICT DO NOTHING",
      ["fills-test-no-account-000000000000"],
    );
    const { client } = history({ fills: 5, funding: 3 });
    const ing = ingester(client);
    expect(await ing.accounts()).toContain(ACCOUNT);
    await ing.syncAll();
    const f = await pool.query("SELECT count(*) AS n FROM fills WHERE account_id = $1", [ACCOUNT]);
    const g = await pool.query("SELECT count(*) AS n FROM funding_payments WHERE account_id = $1", [
      ACCOUNT,
    ]);
    expect([Number(f.rows[0].n), Number(g.rows[0].n)]).toEqual([5, 3]);
    await pool.query("DELETE FROM users WHERE address LIKE 'fills-test-%'");
  }, 30_000); // syncs every user in the shared test database, including rows other suites are using
});
