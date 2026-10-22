import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const DAY = 86_400_000;
const now = Date.now();
let t: TestApp;
const made: string[] = [];

async function trader(
  handle: string | null,
  opts: {
    deposit?: number;
    trades: Array<{ daysAgo: number; net: number; symbol?: string; notional?: number }>;
  },
) {
  const accountId = `acct-${randomUUID()}`;
  const { rows } = await t.pool.query(
    "INSERT INTO users (chain, address, handle, strike_account_id) VALUES ('solana', $1, $2, $3) RETURNING id",
    [solAddress(), handle, accountId],
  );
  made.push(accountId);
  if (opts.deposit) {
    await t.pool.query(
      "INSERT INTO account_transactions (account_id, id, type, amount, status, ts_ms, raw) VALUES ($1, 'd1', 'deposit', $2, 'completed', $3, '{}')",
      [accountId, opts.deposit, now - 100 * DAY],
    );
  }
  let i = 0;
  for (const tr of opts.trades) {
    i++;
    const closed = now - tr.daysAgo * DAY;
    const symbol = tr.symbol ?? "BTC-USD";
    const entry = `${accountId}-e${i}`;
    const exit = `${accountId}-x${i}`;
    for (const [id, side, ts, tid] of [
      [entry, "buy", closed - 3_600_000, i * 2],
      [exit, "sell", closed, i * 2 + 1],
    ] as const) {
      await t.pool.query(
        `INSERT INTO fills (account_id, id, trade_id, order_id, symbol, side, role, price, size, realized_pnl, fee, fee_type, ts_ms, raw)
         VALUES ($1,$2,$3,$4,$5,$6,'taker',100,10,$7,0,'commission',$8,$9)`,
        [
          accountId,
          id,
          tid,
          id,
          symbol,
          side,
          side === "sell" ? tr.net : 0,
          ts,
          JSON.stringify({
            id,
            symbol,
            side,
            realized_pnl: side === "sell" ? String(tr.net) : "0",
          }),
        ],
      );
    }
    const trade = await t.pool.query(
      `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
       VALUES ($1,$2,'long',$3,$4,10,100,100,$5,$6,0,0,$6) RETURNING id`,
      [accountId, symbol, closed - 3_600_000, closed, tr.notional ?? 1000, tr.net],
    );
    await t.pool.query(
      "INSERT INTO trade_fills (trade_id, fill_id, leg, qty, price) VALUES ($1,$2,'entry',10,100), ($1,$3,'exit',10,100)",
      [trade.rows[0].id, entry, exit],
    );
  }
  return { userId: rows[0].id as string, accountId };
}

beforeAll(async () => {
  t = await makeApp();
  await t.pool.query("DELETE FROM users WHERE handle IN ('lb_steady','lb_wild','lb_new','lb_eth')");
  // steady: 12 small winners over 12 days, $1000 capital, low leverage
  await trader("lb_steady", {
    deposit: 1000,
    trades: Array.from({ length: 12 }, (_, i) => ({ daysAgo: 12 - i, net: 10 })),
  });
  // wild: bigger swings, big positions, same capital
  await trader("lb_wild", {
    deposit: 1000,
    trades: Array.from({ length: 12 }, (_, i) => ({
      daysAgo: 12 - i,
      net: i % 2 ? 150 : -90,
      notional: 20_000,
    })),
  });
  // new: only 3 trades
  await trader("lb_new", {
    deposit: 1000,
    trades: Array.from({ length: 3 }, (_, i) => ({ daysAgo: 3 - i, net: 50 })),
  });
  // eth specialist: 10 ETH trades
  await trader("lb_eth", {
    deposit: 1000,
    trades: Array.from({ length: 10 }, (_, i) => ({ daysAgo: 10 - i, net: 20, symbol: "ETH-USD" })),
  });
});
afterAll(async () => {
  for (const a of made) {
    for (const tbl of ["fills", "trades", "account_transactions"])
      await t.pool.query(`DELETE FROM ${tbl} WHERE account_id = $1`, [a]);
  }
  await t.pool.query("DELETE FROM users WHERE strike_account_id = ANY($1)", [made]);
  await t.close();
});

const get = (url: string) => t.app.inject({ method: "GET", url });
const names = (body: { entries: Array<{ handle: string }> }) =>
  body.entries.map((e) => e.handle).filter((h) => h?.startsWith("lb_"));

describe("leaderboard", () => {
  it("ranks qualified traders by return and keeps unqualified ones off", async () => {
    const r = await get("/v1/leaderboard?timeframe=30d&sort=return");
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.minimums).toEqual({ trades: 8, activeDays: 3, volumeUsd: 500 });
    const order = names(body);
    expect(order).toContain("lb_steady");
    expect(order).not.toContain("lb_new"); // 3 trades < 8
    expect(order.indexOf("lb_steady")).toBeLessThan(order.length); // present
    const steady = body.entries.find((e: { handle: string }) => e.handle === "lb_steady");
    expect(steady.rank).toBeGreaterThan(0);
    expect(steady.stats.trades).toBe(12);
    expect(steady.stats.winRate).toBe(1);
    expect(steady.stats.netPnl).toBe("120");
    expect(steady.risk).toBe("low");
    expect(steady.stats.totalReturnPct).toBeGreaterThan(10);
  });

  it("shows unranked traders only on request, with the reason", async () => {
    const hidden = (await get("/v1/leaderboard?timeframe=30d")).json();
    expect(hidden.unranked).toEqual([]);
    const shown = (await get("/v1/leaderboard?timeframe=30d&includeUnranked=1")).json();
    const nu = shown.unranked.find((e: { handle: string }) => e.handle === "lb_new");
    expect(nu.rankedOut).toBe("too_few_trades");
  });

  it("applies timeframe minimums: a short window drops traders without enough trades in it", async () => {
    const week = (await get("/v1/leaderboard?timeframe=7d&sort=pnl")).json();
    // steady has 7 trades in the last 7 days (>= 5 required)
    const steady = week.entries.find((e: { handle: string }) => e.handle === "lb_steady");
    expect(steady.stats.trades).toBeGreaterThanOrEqual(6);
    const day = (await get("/v1/leaderboard?timeframe=24h")).json();
    expect(names(day)).not.toContain("lb_steady");
  });

  it("filters by market and by risk level", async () => {
    const eth = (await get("/v1/leaderboard?timeframe=30d&market=ETH-USD")).json();
    expect(names(eth)).toEqual(["lb_eth"]);
    const high = (await get("/v1/leaderboard?timeframe=30d&risk=high")).json();
    expect(names(high)).toEqual(["lb_wild"]);
    const low = (await get("/v1/leaderboard?timeframe=30d&risk=low")).json();
    expect(names(low)).toContain("lb_steady");
    expect(names(low)).not.toContain("lb_wild");
  });

  it("sorts by the requested measure and paginates", async () => {
    const byPnl = (await get("/v1/leaderboard?timeframe=30d&sort=pnl")).json();
    const pnls = byPnl.entries.map((e: { stats: { netPnl: string } }) => Number(e.stats.netPnl));
    expect([...pnls].sort((a, b) => b - a)).toEqual(pnls);
    const page = (await get("/v1/leaderboard?timeframe=30d&limit=1&offset=1")).json();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].rank).toBe(2);
    expect((await get("/v1/leaderboard?sort=bogus")).statusCode).toBe(400);
  });
});

describe("profile and proof", () => {
  it("serves stats, method and verification counts; matches the handle in any case or the user id", async () => {
    const a = await get("/v1/traders/LB_Steady?timeframe=all");
    expect(a.statusCode).toBe(200);
    const body = a.json();
    expect(body.trader.handle).toBe("lb_steady");
    expect(body.stats.trades).toBe(12);
    expect(body.ranked).toBe(true);
    expect(body.verification).toMatchObject({ fills: 24, trades: 12, capitalFlows: 1 });
    expect(body.verification.method.totalReturn).toContain("Time-weighted");
    expect(body.curve.length).toBe(12);
    const { rows } = await t.pool.query("SELECT id FROM users WHERE handle = 'lb_steady'");
    expect((await get(`/v1/traders/${rows[0].id}`)).json().trader.handle).toBe("lb_steady");
    expect((await get("/v1/traders/nobody_here")).statusCode).toBe(404);
  });

  it("explains why an unqualified trader isn't ranked", async () => {
    const body = (await get("/v1/traders/lb_new")).json();
    expect(body.ranked).toBe(false);
    expect(body.unrankedReason).toBe("too_few_trades");
    expect(body.stats.trades).toBe(3);
  });

  it("lists trades with fill counts and proves each one from the raw fills", async () => {
    const list = (await get("/v1/traders/lb_steady/trades?limit=5")).json();
    expect(list.trades).toHaveLength(5);
    expect(list.next).toBeTruthy();
    const trade = list.trades[0];
    expect(trade).toMatchObject({ symbol: "BTC-USD", netPnl: "10", fills: 2 });

    const proof = (await get(`/v1/traders/lb_steady/trades/${trade.id}/fills`)).json();
    expect(proof.fills.map((f: { leg: string }) => f.leg)).toEqual(["entry", "exit"]);
    expect(proof.fills[1].fill.realized_pnl).toBe("10"); // the stored Strike record itself
    // pagination continues from the cursor
    const more = (await get(`/v1/traders/lb_steady/trades?limit=50&before=${list.next}`)).json();
    expect(more.trades.length).toBe(7);

    // another trader's trade id doesn't resolve under this profile
    expect((await get(`/v1/traders/lb_wild/trades/${trade.id}/fills`)).statusCode).toBe(404);
    expect((await get("/v1/traders/lb_steady/trades/999999999/fills")).statusCode).toBe(404);
  });

  it("every PnL number reconciles with its fills", async () => {
    const list = (await get("/v1/traders/lb_wild/trades?limit=50")).json();
    let sum = 0;
    for (const tr of list.trades) {
      const proof = (await get(`/v1/traders/lb_wild/trades/${tr.id}/fills`)).json();
      const realized = proof.fills.reduce(
        (s: number, f: { fill: { realized_pnl: string } }) => s + Number(f.fill.realized_pnl),
        0,
      );
      expect(realized).toBe(Number(tr.grossPnl));
      sum += Number(tr.netPnl);
    }
    const stats = (await get("/v1/traders/lb_wild?timeframe=all")).json().stats;
    expect(Number(stats.netPnl)).toBe(sum);
  });
});

describe("handles", () => {
  it("claims a unique handle, case-insensitively, rejecting bad or reserved ones", async () => {
    const a = await signIn(t, "solana", solAddress());
    const b = await signIn(t, "solana", solAddress());
    const post = (cookie: string, handle: string) =>
      t.app.inject({
        method: "POST",
        url: "/v1/me/handle",
        payload: { handle },
        headers: { cookie },
      });
    expect((await post(a.cookie, "ab")).statusCode).toBe(400);
    expect((await post(a.cookie, "has space")).statusCode).toBe(400);
    expect((await post(a.cookie, "Admin")).statusCode).toBe(400);
    expect((await post(a.cookie, "Zed_Trader")).statusCode).toBe(200);
    expect((await post(b.cookie, "zed_trader")).statusCode).toBe(409);
    expect(
      (await t.app.inject({ method: "POST", url: "/v1/me/handle", payload: { handle: "x_y_z" } }))
        .statusCode,
    ).toBe(401);
    await t.pool.query("UPDATE users SET handle = NULL WHERE id = $1", [a.user.id]);
  });
});
