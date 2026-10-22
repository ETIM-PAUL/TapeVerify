import { recomputeReputation } from "@tapeverify/verify";
import { describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

const ADMIN = "admin-token-for-tests-1234";
const rich = {
  "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
};

async function world() {
  const t = await makeApp(
    { ...rich, "GET /v2/markets": () => ({ body: marketsBody("80000") }) },
    false,
    null,
    { ADMIN_TOKEN: ADMIN },
  );
  const trader = await signIn(t, "solana", solAddress());
  const created = await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    payload: {
      symbol: "BTC-USD",
      side: "long",
      size: "0.002",
      leverage: 10,
      tpPrice: "84000",
      slPrice: "78000",
    },
    headers: { cookie: trader.cookie },
  });
  expect(created.statusCode, created.body).toBe(201);
  const call = created.json().call;
  await t.pool.query(
    "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1, entry_trade_id = 1, expires_at = $2 WHERE id = $1",
    [call.id, Date.now() + 3_600_000],
  );
  return { t, trader, call };
}

async function flag(t: TestApp, userId: string, severity = "high", kind = "front_running") {
  const r = await t.pool.query(
    `INSERT INTO verify_findings (subject_id, kind, severity, base_key, generation, summary, evidence)
     VALUES ($1,$2,$3,$4,0,'Exited shortly after several followers entered.', '{"secret":"other-account"}') RETURNING id`,
    [userId, kind, severity, `test:${crypto.randomUUID()}`],
  );
  await recomputeReputation(t.pool, [userId]);
  return r.rows[0].id as string;
}

const follow = (t: TestApp, cookie: string, code: string, payload: unknown = { marginUsd: "50" }) =>
  t.app.inject({
    method: "POST",
    url: `/v1/calls/${code}/follow`,
    payload: payload as object,
    headers: { cookie },
  });
const admin = { "x-admin-token": ADMIN };

describe("sign-in capture", () => {
  it("stores only salted hashes of the address and agent", async () => {
    const { t, trader } = await world();
    const { rows } = await t.pool.query(
      "SELECT ip_hash, ua_hash FROM login_events WHERE user_id = $1",
      [trader.user.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].ip_hash).not.toContain("127.0.0.1");
    await t.close();
  });
});

describe("what followers and the public see", () => {
  it("shows reputation and penalties on the profile and call page, without evidence", async () => {
    const { t, trader, call } = await world();
    await t.app.inject({
      method: "POST",
      url: "/v1/me/handle",
      payload: { handle: `verify${Date.now() % 100000}` },
      headers: { cookie: trader.cookie },
    });
    await flag(t, trader.user.id);
    const me = await t.pool.query("SELECT handle FROM users WHERE id = $1", [trader.user.id]);

    const prof = await t.app.inject({ method: "GET", url: `/v1/traders/${me.rows[0].handle}` });
    expect(prof.statusCode, prof.body).toBe(200);
    const a = prof.json().verify;
    expect(a).toMatchObject({ clean: false, underReview: true, worst: "high" });
    expect(a.penalties[0]).toMatchObject({ kind: "front_running", status: "open" });
    expect(prof.body).not.toContain("other-account");

    const page = await t.app.inject({ method: "GET", url: `/v1/calls/${call.code}` });
    expect(page.json().verify.underReview).toBe(true);
    expect(page.body).not.toContain("other-account");
    await t.close();
  });
});

describe("following a flagged caller", () => {
  it("stops with the flags unless the follower accepts the risk", async () => {
    const { t, trader, call } = await world();
    await flag(t, trader.user.id, "high");
    const follower = await signIn(t, "solana", solAddress());

    const blocked = await follow(t, follower.cookie, call.code);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "caller_flagged" });
    expect(blocked.json().flags[0]).toMatchObject({ kind: "front_running", severity: "high" });
    expect(JSON.stringify(blocked.json())).not.toContain("other-account");
    expect(
      (await t.pool.query("SELECT 1 FROM follows WHERE call_id = $1", [call.id])).rowCount,
    ).toBe(0);

    const ok = await follow(t, follower.cookie, call.code, { marginUsd: "50", acceptRisk: true });
    expect(ok.statusCode, ok.body).toBe(201);
    await t.close();
  });

  it("lets low-severity or dismissed flags through without a prompt", async () => {
    const { t, trader, call } = await world();
    const id = await flag(t, trader.user.id, "low", "self_trade");
    const f1 = await signIn(t, "solana", solAddress());
    expect((await follow(t, f1.cookie, call.code)).statusCode).toBe(201);
    await t.pool.query("UPDATE verify_findings SET status = 'dismissed' WHERE id = $1", [id]);
    await flag(t, trader.user.id, "high", "sybil_cluster");
    await t.pool.query("UPDATE verify_findings SET status = 'dismissed' WHERE subject_id = $1", [
      trader.user.id,
    ]);
    const f2 = await signIn(t, "solana", solAddress());
    expect((await follow(t, f2.cookie, call.code)).statusCode).toBe(201);
    await t.close();
  });
});

describe("appeals and review", () => {
  it("lets the trader appeal once, and an accepted appeal clears the finding and restores the score", async () => {
    const { t, trader } = await world();
    const id = await flag(t, trader.user.id, "high");
    const hit = Number(
      (
        await t.pool.query("SELECT score FROM trader_reputation WHERE user_id = $1", [
          trader.user.id,
        ])
      ).rows[0].score,
    );
    const hdr = { cookie: trader.cookie };

    const mine = await t.app.inject({ method: "GET", url: "/v1/me/verify", headers: hdr });
    expect(mine.json().findings[0]).toMatchObject({ id, status: "open", canAppeal: true });

    const short = await t.app.inject({
      method: "POST",
      url: `/v1/verify/findings/${id}/appeal`,
      payload: { message: "no" },
      headers: hdr,
    });
    expect(short.statusCode).toBe(400);
    const stranger = await signIn(t, "solana", solAddress());
    const notMine = await t.app.inject({
      method: "POST",
      url: `/v1/verify/findings/${id}/appeal`,
      payload: { message: "this is not mine at all" },
      headers: { cookie: stranger.cookie },
    });
    expect(notMine.statusCode).toBe(404);

    const a = await t.app.inject({
      method: "POST",
      url: `/v1/verify/findings/${id}/appeal`,
      payload: { message: "I exited on a stop I set earlier, see the call page." },
      headers: hdr,
    });
    expect(a.statusCode, a.body).toBe(201);
    const again = await t.app.inject({
      method: "POST",
      url: `/v1/verify/findings/${id}/appeal`,
      payload: { message: "trying a second time please" },
      headers: hdr,
    });
    expect(again.statusCode).toBe(409);

    // The queue shows the appeal first, with the reviewer-only evidence.
    const q = await t.app.inject({ method: "GET", url: "/v1/admin/verify/queue", headers: admin });
    const item = q.json().queue.find((x: { id: string }) => x.id === id);
    expect(item).toMatchObject({ status: "appealed", appeal: { priorStatus: "open" } });
    expect(item.evidence.secret).toBe("other-account");

    const decided = await t.app.inject({
      method: "POST",
      url: `/v1/admin/verify/appeals/${item.appeal.id}/decide`,
      payload: { accept: true, note: "Stop order confirmed." },
      headers: admin,
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const after = (await t.pool.query("SELECT status FROM verify_findings WHERE id = $1", [id]))
      .rows[0];
    expect(after.status).toBe("cleared");
    const rep = (
      await t.pool.query("SELECT score FROM trader_reputation WHERE user_id = $1", [trader.user.id])
    ).rows[0];
    expect(Number(rep.score)).toBeGreaterThan(hit);
    const trail = await t.pool.query(
      "SELECT actor, to_status FROM verify_events WHERE finding_id = $1 ORDER BY id",
      [id],
    );
    expect(trail.rows.map((r) => r.to_status)).toEqual(["appealed", "cleared"]);
    await t.close();
  });

  it("confirms the finding when an appeal is rejected", async () => {
    const { t, trader } = await world();
    const id = await flag(t, trader.user.id, "critical");
    await t.app.inject({
      method: "POST",
      url: `/v1/verify/findings/${id}/appeal`,
      payload: { message: "This was a coincidence, I swear." },
      headers: { cookie: trader.cookie },
    });
    const q = await t.app.inject({ method: "GET", url: "/v1/admin/verify/queue", headers: admin });
    const item = q.json().queue.find((x: { id: string }) => x.id === id);
    const r = await t.app.inject({
      method: "POST",
      url: `/v1/admin/verify/appeals/${item.appeal.id}/decide`,
      payload: { accept: false },
      headers: admin,
    });
    expect(r.statusCode).toBe(200);
    expect(
      (await t.pool.query("SELECT status FROM verify_findings WHERE id = $1", [id])).rows[0].status,
    ).toBe("confirmed");
    const mine = await t.app.inject({
      method: "GET",
      url: "/v1/me/verify",
      headers: { cookie: trader.cookie },
    });
    expect(mine.json().findings[0]).toMatchObject({
      status: "confirmed",
      canAppeal: false,
      appeal: { status: "rejected" },
    });
    await t.close();
  });

  it("lets an operator confirm or dismiss an open finding, and only that", async () => {
    const { t, trader } = await world();
    const id = await flag(t, trader.user.id, "medium");
    const dismiss = await t.app.inject({
      method: "POST",
      url: `/v1/admin/verify/findings/${id}/review`,
      payload: { decision: "dismiss", note: "Normal behaviour." },
      headers: admin,
    });
    expect(dismiss.statusCode, dismiss.body).toBe(200);
    const twice = await t.app.inject({
      method: "POST",
      url: `/v1/admin/verify/findings/${id}/review`,
      payload: { decision: "confirm" },
      headers: admin,
    });
    expect(twice.statusCode).toBe(409);
    await t.close();
  });

  it("keeps operator endpoints closed without the token", async () => {
    const { t, trader } = await world();
    const id = await flag(t, trader.user.id);
    for (const [method, url, payload] of [
      ["GET", "/v1/admin/verify/queue", undefined],
      ["POST", `/v1/admin/verify/findings/${id}/review`, { decision: "dismiss" }],
    ] as const) {
      const none = await t.app.inject({ method, url, payload });
      expect(none.statusCode).toBe(401);
      const bad = await t.app.inject({
        method,
        url,
        payload,
        headers: { "x-admin-token": "wrong-token-wrong-token" },
      });
      expect(bad.statusCode).toBe(401);
      const user = await t.app.inject({ method, url, payload, headers: { cookie: trader.cookie } });
      expect(user.statusCode).toBe(401);
    }
    await t.close();
  });
});
