import { instantiateTemplate } from "@tapeverify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

/**
 * One person's way through the product, across features, against the fake Strike: sign in, write and
 * paper-run a strategy, publish a call, have someone follow it, close it, and read the public side.
 * The feature tests cover each step's edge cases; this proves the steps hand off to each other.
 */
let t: TestApp;
beforeAll(async () => {
  t = await makeApp({
    "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
    "GET /v2/markets": () => ({ body: marketsBody("80000") }),
  });
});
afterAll(async () => t.close());

const call = (method: "GET" | "POST" | "PUT", url: string, cookie?: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });

describe("a trader's journey", () => {
  it("signs in, builds and paper-runs a strategy, publishes a call that someone follows, then closes it", async () => {
    // 1. sign in and see who I am
    const trader = await signIn(t, "solana", solAddress());
    const me = (await call("GET", "/v1/me", trader.cookie)).json();
    expect(me.user?.id ?? me.id).toBeTruthy();
    expect((await call("GET", "/v1/me")).statusCode).toBe(401);

    // 2. pick a template, save it, run it on paper
    const templates = (await call("GET", "/v1/strategies/templates", trader.cookie)).json();
    expect((templates.templates ?? templates).length).toBeGreaterThan(0);
    const saved = await call("POST", "/v1/strategies", trader.cookie, {
      spec: instantiateTemplate("dip_buyer"),
      source: "template",
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const paper = await call("POST", `/v1/strategies/${saved.json().id}/paper`, trader.cookie, {
      startEquity: 2000,
    });
    expect(paper.statusCode, paper.body).toBe(201);
    const sessions = (await call("GET", "/v1/paper", trader.cookie)).json().sessions;
    expect(sessions.map((s: { id: string }) => s.id)).toContain(paper.json().id);

    // 3. publish a call
    const created = await call("POST", "/v1/calls", trader.cookie, {
      symbol: "BTC-USD",
      side: "long",
      size: "0.002",
      leverage: 10,
      tpPrice: "84000",
      slPrice: "78000",
    });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json().call;
    await t.pool.query(
      "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1, entry_trade_id = 1, expires_at = $2 WHERE id = $1",
      [c.id, Date.now() + 3_600_000],
    );

    // 4. anyone with the link can read it, with no sign-in and no private fields
    const pub = await call("GET", `/v1/calls/${c.code}`);
    expect(pub.statusCode).toBe(200);
    expect(JSON.stringify(pub.json())).not.toContain(trader.user.id ?? "never-present");

    // 5. a follower previews, then copies it with their own margin
    const follower = await signIn(t, "solana", solAddress());
    const preview = await call("POST", `/v1/calls/${c.code}/follow/preview`, follower.cookie, {
      marginUsd: "50",
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const followed = await call("POST", `/v1/calls/${c.code}/follow`, follower.cookie, {
      marginUsd: "50",
      requestKey: `journey-${Date.now()}`,
    });
    expect(followed.statusCode, followed.body).toBe(201);
    const mine = (await call("GET", "/v1/follows", follower.cookie)).json();
    expect(JSON.stringify(mine)).toContain(c.code);

    // 6. the trader closes; it can't be closed twice
    expect((await call("POST", `/v1/calls/${c.id}/close`, trader.cookie, {})).statusCode).toBe(200);
    expect((await call("POST", `/v1/calls/${c.id}/close`, trader.cookie, {})).statusCode).toBe(409);

    // 7. the trader's own list shows it, the follower's doesn't
    const theirs = JSON.stringify((await call("GET", "/v1/calls", trader.cookie)).json());
    const notTheirs = JSON.stringify((await call("GET", "/v1/calls", follower.cookie)).json());
    expect(theirs).toContain(c.code);
    expect(notTheirs).not.toContain(c.code);
  });

  it("serves the public signing key and keeps account data private", async () => {
    const key = await call("GET", "/v1/records/key");
    expect(key.statusCode).toBe(200);
    for (const url of ["/v1/account", "/v1/follows", "/v1/me/vault", "/v1/notifications"])
      expect((await call("GET", url)).statusCode, url).toBe(401);
  });
});
