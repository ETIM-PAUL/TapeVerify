import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fanOut } from "../src/social/notify.js";
import { testPool } from "./helpers.js";

let pool: pg.Pool;
const users: string[] = [];
const WEB = "https://tape.example";

beforeAll(() => {
  pool = testPool();
});
async function cleanup() {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users.splice(0)]);
}
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function user(handle: string | null = null) {
  const r = await pool.query(
    "INSERT INTO users (chain, address, handle) VALUES ('solana', $1, $2) RETURNING id",
    [`soc-${crypto.randomUUID()}`, handle],
  );
  users.push(r.rows[0].id);
  return r.rows[0].id as string;
}
const follow = (f: string, t: string, agoMs = 3_600_000) =>
  pool.query(
    "INSERT INTO trader_follows (follower_id, trader_id, created_at) VALUES ($1,$2, now() - ($3 || ' milliseconds')::interval)",
    [f, t, agoMs],
  );
async function call(userId: string, over: { entryTs?: number; status?: string } = {}) {
  const code = `S${Math.random().toString(36).slice(2, 9)}`;
  const r = await pool.query(
    `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms)
     VALUES ($1,$2,'BTC-USD','long',10,1,$3,50,$4,80000.50,1,$5) RETURNING id`,
    [code, userId, Date.now() + 3_600_000, over.status ?? "open", over.entryTs ?? Date.now()],
  );
  return { id: r.rows[0].id as string, code };
}
const notes = async (userId: string) =>
  (
    await pool.query(
      "SELECT kind, ref, title, body, url FROM notifications WHERE user_id = $1 ORDER BY created_at, id",
      [userId],
    )
  ).rows;

describe("notifications for followed traders", () => {
  it("tells followers about a new call once, with a link, and only if it opened after they followed", async () => {
    const trader = await user("alice");
    const early = await user();
    const late = await user();
    const stranger = await user();
    await follow(early, trader, 3_600_000);
    await follow(late, trader, -60_000); // follows a minute from now: the call came first
    const c = await call(trader, { entryTs: Date.now() });

    const r = await fanOut(pool, { web: WEB }, undefined, Date.now());
    expect(r.calls).toBeGreaterThanOrEqual(1);
    const n = await notes(early);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      kind: "new_call",
      title: "New call from alice",
      url: `${WEB}/call/${c.code}`,
      ref: `call:${c.id}`,
    });
    expect(n[0]?.body).toBe("LONG BTC-USD 10x, entry 80000.5");
    expect(await notes(late)).toEqual([]);
    expect(await notes(stranger)).toEqual([]);

    await fanOut(pool, { web: WEB }, undefined, Date.now()); // running again notifies no one twice
    expect(await notes(early)).toHaveLength(1);
  });

  it("ignores calls that haven't filled yet", async () => {
    const trader = await user("bob");
    const f = await user();
    await follow(f, trader);
    const c = await call(trader, { status: "pending" });
    await pool.query("UPDATE calls SET entry_price = NULL, entry_ts_ms = NULL WHERE id = $1", [
      c.id,
    ]);
    await fanOut(pool, { web: WEB }, undefined, Date.now());
    expect(await notes(f)).toEqual([]);
  });
});

describe("notifications about your own positions and strategies", () => {
  async function openFollow(follower: string, caller: string) {
    const c = await call(caller, { entryTs: Date.now() });
    const f = await pool.query(
      `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, status, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'BTC-USD','long',10,100,1,1,100,100,0,'open',100,1,1) RETURNING id`,
      [c.id, follower],
    );
    return { followId: f.rows[0].id as string, code: c.code };
  }

  it("notifies on each liquidation level reached, not on every check", async () => {
    const caller = await user();
    const me = await user();
    const { followId, code } = await openFollow(me, caller);
    const alert = async (level: string) =>
      pool.query(
        `INSERT INTO liquidation_alerts (user_id, follow_id, symbol, level, entry_price, mark_price, liq_price, used, created_ms) VALUES ($1,$2,'BTC-USD',$3,100,92,90,0.8,$4)
         ON CONFLICT (follow_id) WHERE resolved_ms IS NULL DO UPDATE SET level = EXCLUDED.level`,
        [me, followId, level, Date.now()],
      );
    await alert("warn");
    await fanOut(pool, { web: WEB }, undefined, Date.now());
    await fanOut(pool, { web: WEB }, undefined, Date.now());
    expect((await notes(me)).filter((n) => n.kind === "liquidation")).toHaveLength(1);
    await alert("critical");
    await fanOut(pool, { web: WEB }, undefined, Date.now());
    const liq = (await notes(me)).filter((n) => n.kind === "liquidation");
    expect(liq.map((n) => n.title)).toEqual([
      "Getting close to liquidation",
      "About to be liquidated",
    ]);
    expect(liq[0]?.url).toBe(`${WEB}/call/${code}`);
    expect(liq[0]?.body).toContain("liquidation at 90");
  });

  it("notifies when a strategy stops by itself, but not when you stopped it", async () => {
    const me = await user();
    const run = (market: string, status: string, reason: string) =>
      pool.query(
        `INSERT INTO live_runs (user_id, name, market, spec, budget, network, account_id, started_ms, state, status, stop_reason, stopped_at)
         VALUES ($1,$2,$3,'{}','{}','testnet','a',1,'{}',$4,$5, now())`,
        [me, `Strategy ${market}`, market, status, reason],
      );
    await run("BTC-USD", "halted", "loss_cap");
    await run("ETH-USD", "stopped", "user_stop");
    await run("SOL-USD", "halted", "wallet_revoked");
    await fanOut(pool, { web: WEB }, undefined, Date.now());
    const stops = (await notes(me)).filter((n) => n.kind === "strategy_stop");
    expect(stops.map((n) => n.title).sort()).toEqual([
      "Strategy stopped: Strategy BTC-USD",
      "Strategy stopped: Strategy SOL-USD",
    ]);
    expect(stops.find((n) => n.title.includes("BTC"))?.body).toContain("reached its loss limit");
    expect(stops.find((n) => n.title.includes("SOL"))?.body).toContain("API wallet was revoked");
  });
});
