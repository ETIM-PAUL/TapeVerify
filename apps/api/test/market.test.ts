import { instantiateTemplate, specHash } from "@pit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const ADMIN = "an-admin-token-0123456789";
let t: TestApp;
beforeAll(async () => {
  t = await makeApp({}, false, null, { ADMIN_TOKEN: ADMIN });
});
afterAll(async () => t.close());

const post = (cookie: string, url: string, payload: unknown = {}) =>
  t.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });
const get = (cookie: string | null, url: string) =>
  t.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

/** A saved strategy plus a live run (with its rules hash) for the user. */
async function strategyWithRun(
  cookie: string,
  userId: string,
  tweak?: (s: ReturnType<typeof instantiateTemplate>) => void,
) {
  const spec = instantiateTemplate("breakout", { marginUsd: 100, leverage: 3, maxLossUsd: 60 });
  tweak?.(spec);
  const r = await post(cookie, "/v1/strategies", { spec, source: "template" });
  expect(r.statusCode, r.body).toBe(201);
  const strategyId = r.json().id as string;
  const stored = (await t.pool.query("SELECT spec FROM strategies WHERE id = $1", [strategyId]))
    .rows[0].spec;
  const run = await t.pool.query(
    "INSERT INTO live_runs (user_id, strategy_id, name, market, spec, spec_hash, budget, network, account_id, started_ms, state, status) VALUES ($1,$2,'x','BTC-USD',$3,$4,'{}','testnet','creator-acct',1,'{}','stopped') RETURNING id",
    [userId, strategyId, JSON.stringify(stored), specHash(stored)],
  );
  return { strategyId, runId: run.rows[0].id as string, spec: stored };
}

let seq = 1000;
async function closedTrades(runId: string, userId: string, nets: number[]) {
  for (const net of nets) {
    seq++;
    await t.pool.query(
      `INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id,
                                entry_price, entry_size, exit_price, exit_size, entry_ts_ms, exit_ts_ms, entry_order_id, realized_pnl, entry_fee, exit_fee, exit_reason, builder_bps)
       VALUES ($1,$2,$3,'creator-acct','BTC-USD','long','closed',3,100,3,99,5,gen_random_uuid(),$4,100,3,101,3,$5,$6,$7,$8,0.1,0.1,'tp',10)`,
      [runId, seq, userId, `c-${seq}`, seq * 1000, seq * 1000 + 500, seq, net + 0.2],
    );
  }
}

async function listed(title = "Breakout pro") {
  const s = await signIn(t, "solana", solAddress());
  const sr = await strategyWithRun(s.cookie, s.user.id);
  await closedTrades(sr.runId, s.user.id, [10, -4, 6]);
  const r = await post(s.cookie, `/v1/strategies/${sr.strategyId}/publish`, {
    title,
    description: "Buys a break of the 20-candle high.",
  });
  expect(r.statusCode, r.body).toBe(201);
  return { ...s, ...sr, listingId: r.json().id as string };
}

describe("publishing", () => {
  it("needs a live record with the exact rules, a title, and a strategy you own", async () => {
    const s = await signIn(t, "solana", solAddress());
    const o = await signIn(t, "solana", solAddress());
    const sr = await strategyWithRun(s.cookie, s.user.id);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/strategies/${sr.strategyId}/publish`,
          payload: { title: "abc" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await post(o.cookie, `/v1/strategies/${sr.strategyId}/publish`, { title: "Mine now" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(s.cookie, `/v1/strategies/${sr.strategyId}/publish`, { title: "ab" })).statusCode,
    ).toBe(400);

    const none = await post(s.cookie, `/v1/strategies/${sr.strategyId}/publish`, {
      title: "Needs record",
    });
    expect([none.statusCode, none.json().code, none.json().have, none.json().need]).toEqual([
      409,
      "needs_live_record",
      0,
      3,
    ]);
    await closedTrades(sr.runId, s.user.id, [5, 5]);
    expect(
      (
        await post(s.cookie, `/v1/strategies/${sr.strategyId}/publish`, { title: "Needs record" })
      ).json().have,
    ).toBe(2);
    await closedTrades(sr.runId, s.user.id, [5]);
    const ok = await post(s.cookie, `/v1/strategies/${sr.strategyId}/publish`, {
      title: "Needs record",
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ version: 1, creatorShareBps: 5000 });
  });

  it("only counts trades made with the same rules, and ignores open or failed ones", async () => {
    const s = await signIn(t, "solana", solAddress());
    const sr = await strategyWithRun(s.cookie, s.user.id);
    const other = await strategyWithRun(s.cookie, s.user.id, (x) => {
      x.exit.stopLossPct = 1.2;
    }); // different rules
    await closedTrades(other.runId, s.user.id, [1, 1, 1, 1, 1]);
    await t.pool.query(
      "INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id) VALUES ($1,1,$2,'a','BTC-USD','long','open',3,100,1,99,5,gen_random_uuid(),'o1'), ($1,2,$2,'a','BTC-USD','long','failed',3,100,1,99,5,gen_random_uuid(),'o2')",
      [sr.runId, s.user.id],
    );
    const r = await post(s.cookie, `/v1/strategies/${sr.strategyId}/publish`, {
      title: "Same rules only",
    });
    expect([r.statusCode, r.json().have]).toEqual([409, 0]);
  });

  it("refuses to relist a copy of someone else's strategy", async () => {
    const L = await listed("Original");
    const c = await signIn(t, "solana", solAddress());
    const clone = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
    });
    expect(clone.statusCode, clone.body).toBe(201);
    const run = await t.pool.query(
      "INSERT INTO live_runs (user_id, strategy_id, name, market, spec, spec_hash, budget, network, account_id, started_ms, state, status) SELECT $1, $2, 'x', 'BTC-USD', spec, $3, '{}', 'testnet', 'a', 1, '{}', 'stopped' FROM strategies WHERE id = $2 RETURNING id",
      [c.user.id, clone.json().strategyId, specHash(clone.json().spec)],
    );
    await closedTrades(run.rows[0].id, c.user.id, [3, 3, 3]);
    const r = await post(c.cookie, `/v1/strategies/${clone.json().strategyId}/publish`, {
      title: "My copy of it",
    });
    expect([r.statusCode, r.json().code]).toEqual([409, "is_a_clone"]);
  });

  it("republishing keeps the listing, bumps the version only when the rules change, and unlisting hides it", async () => {
    const L = await listed("Versioned");
    const again = await post(L.cookie, `/v1/strategies/${L.strategyId}/publish`, {
      title: "Versioned (renamed)",
      description: "new words",
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: L.listingId, version: 1 });
    // change the rules: a new version whose record starts empty, so it can't be listed until it has one
    const edited = instantiateTemplate("breakout", { marginUsd: 100, leverage: 3, maxLossUsd: 60 });
    edited.exit.stopLossPct = 1.7;
    await t.app.inject({
      method: "PUT",
      url: `/v1/strategies/${L.strategyId}`,
      payload: { spec: edited },
      headers: { cookie: L.cookie },
    });
    const blocked = await post(L.cookie, `/v1/strategies/${L.strategyId}/publish`, {
      title: "Versioned v2",
    });
    expect([blocked.statusCode, blocked.json().code]).toEqual([409, "needs_live_record"]);
    const stored = (await t.pool.query("SELECT spec FROM strategies WHERE id = $1", [L.strategyId]))
      .rows[0].spec;
    const run = await t.pool.query(
      "INSERT INTO live_runs (user_id, strategy_id, name, market, spec, spec_hash, budget, network, account_id, started_ms, state, status) VALUES ($1,$2,'x','BTC-USD',$3,$4,'{}','testnet','a',1,'{}','stopped') RETURNING id",
      [L.user.id, L.strategyId, JSON.stringify(stored), specHash(stored)],
    );
    await closedTrades(run.rows[0].id, L.user.id, [2, 2, 2]);
    expect(
      (
        await post(L.cookie, `/v1/strategies/${L.strategyId}/publish`, { title: "Versioned v2" })
      ).json(),
    ).toMatchObject({ id: L.listingId, version: 2 });

    const nobody = await signIn(t, "solana", solAddress());
    expect((await post(nobody.cookie, `/v1/market/${L.listingId}/unlist`)).statusCode).toBe(404);
    expect((await post(L.cookie, `/v1/market/${L.listingId}/unlist`)).statusCode).toBe(200);
    expect((await get(null, `/v1/market/${L.listingId}`)).statusCode).toBe(404);
    expect((await get(L.cookie, `/v1/market/${L.listingId}`)).statusCode).toBe(200); // the creator still sees it
    expect(
      (await get(null, "/v1/market"))
        .json()
        .listings.some((x: { id: string }) => x.id === L.listingId),
    ).toBe(false);
  });
});

describe("browsing", () => {
  it("shows the verified live record, the rules in plain language, and how to check it", async () => {
    const L = await listed("Detail check");
    const d = (await get(null, `/v1/market/${L.listingId}`)).json();
    expect(d).toMatchObject({
      title: "Detail check",
      market: "BTC-USD",
      timeframe: "1h",
      version: 1,
      clones: 0,
      liveClones: 0,
    });
    expect(d.rules.lines.length).toBeGreaterThan(3);
    expect(d.record).toMatchObject({ trades: 3, wins: 2, losses: 1, liquidations: 0 });
    expect(d.record.netPnl).toBeCloseTo(12, 6); // 10 - 4 + 6, net of the 0.2 fees each
    expect(d.record.winRate).toBeCloseTo(2 / 3, 9);
    expect(d.trades).toHaveLength(3);
    expect(d.trades[0]).toMatchObject({
      reason: "tp",
      clientOrderId: expect.stringContaining("c-"),
    });
    expect(d.verification.strikeAccountIds).toEqual(["creator-acct"]);
    expect(d.verification.check).toContain("order id");
    expect(d.terms).toMatchObject({ creatorShareBps: 5000, builderBps: 10 });
    expect(d.terms.note).toContain("costs you nothing extra");
    expect(d.warnings.join(" ")).toContain("Only 3 closed live trades");
    expect(JSON.stringify(d)).not.toMatch(/sealed|private/i);
  });

  it("lists, filters and sorts", async () => {
    const a = await listed("Alpha list");
    const b = await listed("Beta list");
    await closedTrades(b.runId, b.user.id, [50, 40]); // b has a bigger record
    const all = (await get(null, "/v1/market?sort=pnl&limit=100")).json();
    const ia = all.listings.findIndex((x: { id: string }) => x.id === a.listingId);
    const ib = all.listings.findIndex((x: { id: string }) => x.id === b.listingId);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ib).toBeLessThan(ia);
    expect(all.listings[ib].record.trades).toBe(5);
    const min5 = (await get(null, "/v1/market?minTrades=5&limit=100"))
      .json()
      .listings.map((x: { id: string }) => x.id);
    expect(min5).toContain(b.listingId);
    expect(min5).not.toContain(a.listingId);
    expect((await get(null, "/v1/market?market=ETH-USD")).json().listings).toHaveLength(0);
    expect((await get(null, "/v1/market?sort=bogus")).statusCode).toBe(400);
    const newest = (await get(null, "/v1/market?sort=newest&limit=1")).json().listings[0];
    expect(newest.id).toBe(b.listingId);
    expect(
      (await get(a.cookie, "/v1/market/mine")).json().listings.map((x: { id: string }) => x.id),
    ).toEqual([a.listingId]);
  });
});

describe("cloning into your own budget", () => {
  it("copies the rules inside the cloner's limits and records where it came from", async () => {
    const L = await listed("Clone me");
    const c = await signIn(t, "solana", solAddress());
    const r = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 40,
      maxLossUsd: 15,
    });
    expect(r.statusCode, r.body).toBe(201);
    const row = (
      await t.pool.query("SELECT * FROM strategies WHERE id = $1", [r.json().strategyId])
    ).rows[0];
    expect(row).toMatchObject({
      user_id: c.user.id,
      source: "clone",
      cloned_from_listing: L.listingId,
      cloned_from_version: 1,
    });
    expect(row.spec.sizing.value).toBe(40); // listing used $100; capped to the cloner's $40
    expect(row.spec.risk.maxLossUsd).toBe(15); // listing allowed $60
    expect(row.spec.name).toBe("Clone me (clone)");
    expect(row.spec.exit.stopLossPct).toBe(L.spec.exit.stopLossPct); // signals untouched
    expect((await get(null, `/v1/market/${L.listingId}`)).json().clones).toBe(1);
  });

  it("never raises the creator's limits, and refuses your own listing or an unlisted one", async () => {
    const L = await listed("Caps only go down");
    const c = await signIn(t, "solana", solAddress());
    const r = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 5000,
      maxLossUsd: 5000,
    });
    const row = (
      await t.pool.query("SELECT spec FROM strategies WHERE id = $1", [r.json().strategyId])
    ).rows[0];
    expect(row.spec.sizing.value).toBe(100);
    expect(row.spec.risk.maxLossUsd).toBe(60);
    const own = await post(L.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
    });
    expect([own.statusCode, own.json().code]).toEqual([409, "own_listing"]);
    await post(L.cookie, `/v1/market/${L.listingId}/unlist`);
    expect(
      (
        await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
          maxMarginUsd: 50,
          maxLossUsd: 20,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/market/${L.listingId}/clone`,
          payload: { maxMarginUsd: 50, maxLossUsd: 20 },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("can start a paper session in one click", async () => {
    const L = await listed("Paper clone");
    const c = await signIn(t, "solana", solAddress());
    const r = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
      mode: "paper",
    });
    expect(r.statusCode, r.body).toBe(201);
    const s = (
      await t.pool.query("SELECT status, strategy_id FROM paper_sessions WHERE id = $1", [
        r.json().paperId,
      ])
    ).rows[0];
    expect(s).toEqual({ status: "running", strategy_id: r.json().strategyId });
  });

  it("goes live in one click only with an explicit acknowledgement, and attributes the run to the listing", async () => {
    const L = await listed("Live clone");
    const c = await signIn(t, "solana", solAddress());
    const noAck = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
      mode: "live",
    });
    expect([noAck.statusCode, noAck.json().code]).toEqual([400, "acknowledge_required"]);
    expect(
      Number(
        (await t.pool.query("SELECT count(*) AS n FROM strategies WHERE user_id = $1", [c.user.id]))
          .rows[0].n,
      ),
    ).toBe(0); // nothing created

    const r = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
      mode: "live",
      acknowledge: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().live).toMatchObject({ ok: true, lossCap: 20 });
    const run = (
      await t.pool.query("SELECT listing_id, spec_hash, budget FROM live_runs WHERE id = $1", [
        r.json().live.id,
      ])
    ).rows[0];
    expect(run.listing_id).toBe(L.listingId);
    expect(run.budget).toEqual({ maxMarginUsd: 50, maxLossUsd: 20 });
  });

  it("keeps the clone but reports why when live can't start, and drops attribution if the rules were edited", async () => {
    const L = await listed("Edited clone");
    const c = await signIn(t, "solana", solAddress());
    const made = await post(c.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
    });
    const sid = made.json().strategyId as string;
    const edited = structuredClone(made.json().spec);
    edited.exit.stopLossPct = 1.1; // the cloner changes the signals
    await t.app.inject({
      method: "PUT",
      url: `/v1/strategies/${sid}`,
      payload: { spec: edited },
      headers: { cookie: c.cookie },
    });
    const started = await post(c.cookie, `/v1/strategies/${sid}/live`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
      acknowledge: true,
    });
    expect(started.statusCode, started.body).toBe(201);
    expect(
      (await t.pool.query("SELECT listing_id FROM live_runs WHERE id = $1", [started.json().id]))
        .rows[0].listing_id,
    ).toBeNull();

    await t.pool.query(
      "UPDATE system_flags SET value = 'true'::jsonb WHERE key = 'emergency_stop'",
    );
    try {
      const d = await signIn(t, "solana", solAddress());
      const blocked = await post(d.cookie, `/v1/market/${L.listingId}/clone`, {
        maxMarginUsd: 50,
        maxLossUsd: 20,
        mode: "live",
        acknowledge: true,
      });
      expect(blocked.statusCode).toBe(201);
      expect(blocked.json().live).toMatchObject({ ok: false, code: "emergency_stop" });
      expect(blocked.json().strategyId).toBeTruthy();
    } finally {
      await t.pool.query(
        "UPDATE system_flags SET value = 'false'::jsonb WHERE key = 'emergency_stop'",
      );
    }
  });
});

describe("creator earnings", () => {
  it("reports totals, per-listing figures, recent accruals and a daily series, only to the creator", async () => {
    const L = await listed("Earner");
    const clone = await signIn(t, "solana", solAddress());
    await post(clone.cookie, `/v1/market/${L.listingId}/clone`, {
      maxMarginUsd: 50,
      maxLossUsd: 20,
    });
    const run = (
      await t.pool.query(
        "INSERT INTO live_runs (user_id, name, market, spec, budget, network, account_id, started_ms, state, listing_id) VALUES ($1,'c','BTC-USD','{}','{}','testnet','a',1,'{}',$2) RETURNING id",
        [clone.user.id, L.listingId],
      )
    ).rows[0].id;
    for (const [i, amt] of [
      ["0.3", "0.3"],
      ["0.6", "0.6"],
    ] as const) {
      const tr = await t.pool.query(
        "INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id) VALUES ($1,$2,$3,'a','BTC-USD','long','closed',3,100,1,99,5,gen_random_uuid(),$4) RETURNING id",
        [run, Math.round(Number(i) * 10), clone.user.id, `e-${i}`],
      );
      await t.pool.query(
        "INSERT INTO creator_earnings (listing_id, creator_id, clone_user_id, run_id, live_trade_id, entry_notional, exit_notional, builder_bps, builder_fee, creator_share_bps, creator_amount) VALUES ($1,$2,$3,$4,$5,300,306,10,0.6,5000,$6)",
        [L.listingId, L.user.id, clone.user.id, run, tr.rows[0].id, amt],
      );
    }
    const e = (await get(L.cookie, "/v1/creator/earnings")).json();
    expect(e.totals).toMatchObject({ trades: 2, payingClones: 1 });
    expect(Number(e.totals.accrued)).toBeCloseTo(0.9, 6);
    expect(Number(e.totals.paid)).toBe(0);
    expect(Number(e.totals.volume)).toBe(1212);
    const mine = e.listings.find((x: { id: string }) => x.id === L.listingId);
    expect(mine).toMatchObject({
      title: "Earner",
      trades: 2,
      clones: 1,
      liveClones: 1,
      creatorShareBps: 5000,
    });
    expect(e.recent).toHaveLength(2);
    expect(e.recent[0]).toMatchObject({ status: "accrued", builderBps: 10, shareBps: 5000 });
    expect(e.daily).toHaveLength(1);
    expect(Number(e.daily[0].amount)).toBeCloseTo(0.9, 6);
    // the paying clone sees nothing of it
    expect((await get(clone.cookie, "/v1/creator/earnings")).json().totals.trades).toBe(0);
    expect((await get(null, "/v1/creator/earnings")).statusCode).toBe(401);
  });

  it("the operator can mark accruals paid, once, with a reference", async () => {
    const L = await listed("Paid out");
    const clone = await signIn(t, "solana", solAddress());
    const run = (
      await t.pool.query(
        "INSERT INTO live_runs (user_id, name, market, spec, budget, network, account_id, started_ms, state, listing_id) VALUES ($1,'c','BTC-USD','{}','{}','testnet','a',1,'{}',$2) RETURNING id",
        [clone.user.id, L.listingId],
      )
    ).rows[0].id;
    const tr = await t.pool.query(
      "INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id) VALUES ($1,1,$2,'a','BTC-USD','long','closed',3,100,1,99,5,gen_random_uuid(),'p1') RETURNING id",
      [run, clone.user.id],
    );
    await t.pool.query(
      "INSERT INTO creator_earnings (listing_id, creator_id, clone_user_id, run_id, live_trade_id, entry_notional, exit_notional, builder_bps, builder_fee, creator_share_bps, creator_amount) VALUES ($1,$2,$3,$4,$5,300,306,10,0.6,5000,0.3)",
      [L.listingId, L.user.id, clone.user.id, run, tr.rows[0].id],
    );

    const pay = (headers: Record<string, string>, body: unknown) =>
      t.app.inject({ method: "POST", url: "/v1/admin/payouts", payload: body as object, headers });
    const body = { creatorId: L.user.id, reference: "transfer-0001" };
    expect((await pay({}, body)).statusCode).toBe(401);
    expect((await pay({ cookie: L.cookie }, body)).statusCode).toBe(401); // a creator can't pay themselves
    expect((await pay({ "x-admin-token": "nope-nope-nope-nope-nope" }, body)).statusCode).toBe(401);
    const ok = await pay({ "x-admin-token": ADMIN }, body);
    expect(ok.json()).toMatchObject({ paid: 1, amount: "0.3", reference: "transfer-0001" });
    expect(
      (await pay({ "x-admin-token": ADMIN }, { ...body, reference: "transfer-0002" })).json(),
    ).toMatchObject({ paid: 0, amount: "0" });
    const e = (await get(L.cookie, "/v1/creator/earnings")).json();
    expect(Number(e.totals.paid)).toBeCloseTo(0.3, 6);
    expect(Number(e.totals.accrued)).toBe(0);
    expect(e.recent[0]).toMatchObject({ status: "paid", payoutRef: "transfer-0001" });
  });
});
