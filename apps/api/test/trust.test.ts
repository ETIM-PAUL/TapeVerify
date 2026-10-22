import { randomUUID } from "node:crypto";
import { generateSigningKey, sealBatch, takeSnapshots } from "@pit/argus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;
const key = generateSigningKey();
let t: TestApp;
const users: string[] = [];
const accounts: string[] = [];

beforeAll(async () => {
  t = await makeApp({ "GET /v2/markets": () => ({ body: marketsBody("100") }) }, false, null, {
    RECORD_PUBLIC_KEY: key.publicKey,
  });
});
afterAll(async () => {
  await t.pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
  await t.pool.query("DELETE FROM trades WHERE account_id = ANY($1)", [accounts]);
  await t.pool.query("DELETE FROM fills WHERE account_id = ANY($1)", [accounts]);
  await t.pool.query("DELETE FROM fill_scores WHERE account_id = ANY($1)", [accounts]);
  await t.pool.query("DELETE FROM health_samples WHERE ts_ms > 4000000000000");
  await t.pool.query(
    "DELETE FROM record_batches b WHERE NOT EXISTS (SELECT 1 FROM record_snapshots s WHERE s.batch_id = b.id) AND b.anchor IS NULL",
  );
  await t.close();
});

/** A trader with `n` closed trades; every fill has a stored score of `scores[i]` (entry) and 100 (exit). */
async function trader(handle: string, scores: Array<number | null>) {
  const account = `trust-api-${randomUUID()}`;
  const { rows } = await t.pool.query(
    "INSERT INTO users (chain, address, handle, strike_account_id) VALUES ('solana', $1, $2, $3) RETURNING id",
    [solAddress(), handle, account],
  );
  users.push(rows[0].id);
  accounts.push(account);
  const now = Date.now();
  for (const [i, s] of scores.entries()) {
    const closed = now - (scores.length - i) * HOUR;
    const tr = await t.pool.query(
      `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
       VALUES ($1,'BTC-USD','long',$2,$3,1,100,101,100,1,0,0,1) RETURNING id`,
      [account, closed - 600_000, closed],
    );
    for (const [leg, id, ts, score] of [
      ["entry", `${account}-e${i}`, closed - 600_000, s],
      ["exit", `${account}-x${i}`, closed, 100],
    ] as const) {
      await t.pool.query(
        `INSERT INTO fills (account_id, id, trade_id, order_id, symbol, side, role, price, size, realized_pnl, fee, ts_ms, raw)
         VALUES ($1,$2,$3,'o','BTC-USD',$4,'taker',100,1,0,0,$5,'{}')`,
        [
          account,
          id,
          1000 + i * 2 + (leg === "entry" ? 0 : 1),
          leg === "entry" ? "buy" : "sell",
          ts,
        ],
      );
      await t.pool.query(
        "INSERT INTO trade_fills (trade_id, fill_id, leg, qty, price) VALUES ($1,$2,$3,1,100)",
        [tr.rows[0].id, id, leg],
      );
      await t.pool.query(
        `INSERT INTO fill_scores (account_id, fill_id, basis, ref_price, expected_price, slippage_bps, score, scored_ms)
         VALUES ($1,$2,$3,100,100,$4,$5,$6)`,
        [
          account,
          id,
          score === null ? "none" : "l3",
          score === null ? null : (100 - score) / 2,
          score,
          now,
        ],
      );
    }
  }
  return { id: rows[0].id as string, account, handle };
}

describe("fair-fill scores in the public record", () => {
  it("puts a score and slippage on every trade, and the proof panel shows each fill's benchmark", async () => {
    const h = `fair${Date.now() % 1_000_000}`;
    const tr = await trader(h, [100, 60, null]);
    const r = await t.app.inject({ method: "GET", url: `/v1/traders/${h}/trades` });
    expect(r.statusCode, r.body).toBe(200);
    const byScore = r
      .json()
      .trades.map((x: { fairFill: { score: number | null; basis: string } }) => x.fairFill);
    // trades come newest first: [null-entry, 60, 100]; the exit legs score 100 and are weighted equally
    expect(byScore.map((x: { score: number | null }) => x.score)).toEqual([100, 80, 100]);
    expect(byScore[0]).toMatchObject({ basis: "l3", scored: 1, of: 2 });
    expect(byScore[1]).toMatchObject({ basis: "l3", scored: 2, of: 2 });

    const mid = r.json().trades[1].id;
    const proof = await t.app.inject({
      method: "GET",
      url: `/v1/traders/${h}/trades/${mid}/fills`,
    });
    const fills = proof.json().fills;
    expect(fills).toHaveLength(2);
    expect(fills.find((f: { leg: string }) => f.leg === "entry").fair).toMatchObject({
      basis: "l3",
      score: 60,
    });

    const prof = await t.app.inject({ method: "GET", url: `/v1/traders/${h}` });
    expect(prof.json().fairFill).toMatchObject({ trades: 3, scoredTrades: 3, avgScore: 93 });
    expect(tr.account).toBeTruthy();
  });

  it("shows how well a caller's followers were filled on the call page", async () => {
    const h = `fair${Date.now() % 1_000_000}c`;
    const caller = await trader(h, []);
    const follower = await trader(`${h}f`, []);
    const call = await t.pool.query(
      `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'BTC-USD','long',5,1,$3,50,'open',100,1,1) RETURNING id, short_code`,
      [randomUUID().slice(0, 8), caller.id, Date.now() + HOUR],
    );
    await t.pool.query(
      `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, status, entry_trade_id, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'BTC-USD','long',5,100,1,1,100,100,0,'open',777,100,1,1)`,
      [call.rows[0].id, follower.id],
    );
    await t.pool.query(
      `INSERT INTO fills (account_id, id, trade_id, order_id, symbol, side, role, price, size, realized_pnl, fee, ts_ms, raw)
       VALUES ($1,'ff1',777,'o','BTC-USD','buy','taker',100,1,0,0,1,'{}')`,
      [follower.account],
    );
    await t.pool.query(
      "INSERT INTO fill_scores (account_id, fill_id, basis, ref_price, slippage_bps, score, scored_ms) VALUES ($1,'ff1','l3',100,12,76,1)",
      [follower.account],
    );
    const page = await t.app.inject({ method: "GET", url: `/v1/calls/${call.rows[0].short_code}` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().followerFills).toMatchObject({ fills: 1, avgScore: 76, avgSlippageBps: 12 });
  });
});

describe("Strike health", () => {
  it("is unknown without samples or when they're stale, and reports the vault and the honest gap on lockers", async () => {
    await t.pool.query("DELETE FROM health_samples");
    const none = await t.app.inject({ method: "GET", url: "/v1/health" });
    expect(none.json()).toMatchObject({ status: "unknown", slp: null });
    expect(none.json().lockers.status).toBe("unavailable");

    const old = Date.now() - 20 * 60_000;
    await t.pool.query(
      "INSERT INTO health_samples (ts_ms, slp, status, reasons) VALUES ($1,$2,'ok','[\"fine\"]')",
      [old, JSON.stringify({ equity: 7000, sharePrice: 1.02 })],
    );
    expect((await t.app.inject({ method: "GET", url: "/v1/health" })).json().status).toBe(
      "unknown",
    );

    const fresh = Date.now();
    await t.pool.query(
      "INSERT INTO health_samples (ts_ms, slp, status, reasons) VALUES ($1,$2,'watch','[\"Share price fell 3.0% over the window.\"]')",
      [fresh, JSON.stringify({ equity: 6900, sharePrice: 1.0, name: "SLP", depositors: 14 })],
    );
    const h = (await t.app.inject({ method: "GET", url: "/v1/health" })).json();
    expect(h).toMatchObject({
      status: "watch",
      sampledAt: fresh,
      slp: { name: "SLP", depositors: 14 },
    });
    expect(h.reasons[0]).toMatch(/fell/);
    expect(h.series.length).toBeGreaterThan(0);
    await t.pool.query("DELETE FROM health_samples");
  });
});

describe("signed records over the API", () => {
  it("lists a trader's records and verifies one, flagging what isn't anchored yet and any tampering", async () => {
    const h = `rec${Date.now() % 1_000_000}`;
    const tr = await trader(h, [100, 90, 95]);
    await takeSnapshots(t.pool, key, Date.now(), undefined, [tr.id]);
    await sealBatch(t.pool, key);

    const k = (await t.app.inject({ method: "GET", url: "/v1/records/key" })).json();
    expect(k).toMatchObject({ algorithm: "ed25519", publicKey: key.publicKey });

    const list = (await t.app.inject({ method: "GET", url: `/v1/traders/${h}/records` })).json()
      .records;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ seq: 1, tradeCount: 3, anchor: null });
    expect(list[0].batchId).not.toBeNull();

    const v = (await t.app.inject({ method: "GET", url: `/v1/records/${list[0].id}` })).json();
    expect(v.publicKey).toBe(key.publicKey);
    expect(v.payload).toMatchObject({ ref: h, seq: 1, tradeCount: 3 });
    const failing = v.checks
      .filter((c: { ok: boolean }) => !c.ok)
      .map((c: { name: string }) => c.name);
    expect(failing).toEqual(["batch anchored on-chain"]);
    expect(v.verified).toBe(false);

    await t.pool.query(
      "UPDATE record_snapshots SET payload = jsonb_set(payload, '{tradeCount}', '300') WHERE id = $1",
      [list[0].id],
    );
    const bad = (await t.app.inject({ method: "GET", url: `/v1/records/${list[0].id}` })).json();
    expect(
      bad.checks.find((c: { name: string }) => c.name === "record hash matches its contents").ok,
    ).toBe(false);

    expect((await t.app.inject({ method: "GET", url: "/v1/records/999999999" })).statusCode).toBe(
      404,
    );
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/traders/nobody-here/records" })).statusCode,
    ).toBe(404);
  });

  it("refuses to vouch for records when no public key is configured", async () => {
    const bare = await makeApp();
    const r = await bare.app.inject({ method: "GET", url: "/v1/records/1" });
    expect(r.statusCode).toBe(503);
    await bare.close();
  });
});

describe("liquidation alerts API", () => {
  it("needs a session and only shows the signed-in follower's own alerts", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/alerts" })).statusCode).toBe(401);
    const caller = await signIn(t, "solana", solAddress());
    const me = await signIn(t, "solana", solAddress());
    const other = await signIn(t, "solana", solAddress());
    users.push(caller.user.id, me.user.id, other.user.id);
    const call = await t.pool.query(
      `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'BTC-USD','long',10,1,$3,50,'open',100,1,1) RETURNING id, short_code`,
      [randomUUID().slice(0, 8), caller.user.id, Date.now() + HOUR],
    );
    const mk = async (userId: string) =>
      (
        await t.pool.query(
          `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, status, entry_price, entry_size, entry_ts_ms)
           VALUES ($1,$2,'BTC-USD','long',10,100,1,1,100,100,0,'open',100,1,1) RETURNING id`,
          [call.rows[0].id, userId],
        )
      ).rows[0].id as string;
    const mine = await mk(me.user.id);
    const theirs = await mk(other.user.id);
    for (const [uid, fid, level] of [
      [me.user.id, mine, "danger"],
      [other.user.id, theirs, "warn"],
    ]) {
      await t.pool.query(
        "INSERT INTO liquidation_alerts (user_id, follow_id, symbol, level, entry_price, mark_price, liq_price, used, created_ms) VALUES ($1,$2,'BTC-USD',$3,100,92,90,0.8,$4)",
        [uid, fid, level, Date.now()],
      );
    }
    const r = await t.app.inject({
      method: "GET",
      url: "/v1/alerts",
      headers: { cookie: me.cookie },
    });
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json().alerts;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      level: "danger",
      symbol: "BTC-USD",
      side: "long",
      callCode: call.rows[0].short_code,
      liquidationPrice: "90",
      used: 0.8,
      resolvedAt: null,
    });
  });
});
