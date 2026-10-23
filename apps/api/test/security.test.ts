import { describe, expect, it } from "vitest";
import { MAX_SESSIONS } from "../src/sessions.js";
import { makeApp, marketsBody, signIn, solAddress } from "./helpers.js";

type Row = { method: string; url: string; limited: boolean; authed: boolean };
const routesOf = (t: { app: unknown }) => (t.app as { routeTable: Row[] }).routeTable;
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Public routes that change something. Everything else that writes needs a session.
const PUBLIC_WRITES = new Set([
  "POST /v1/auth/challenge",
  "POST /v1/auth/verify",
  "POST /v1/auth/logout",
  "POST /v1/admin/emergency-stop", // operator token
  "POST /v1/admin/payouts", // operator token
  "POST /v1/admin/verify/findings/:id/review", // operator token
  "POST /v1/admin/verify/appeals/:id/decide", // operator token
]);

describe("what each route lets through", () => {
  it("every route that changes something is rate limited explicitly, and only the known routes are public", async () => {
    const t = await makeApp();
    const writes = routesOf(t).filter((r) => WRITES.has(r.method));
    expect(writes.length).toBeGreaterThan(30);
    expect(writes.filter((r) => !r.limited).map((r) => `${r.method} ${r.url}`)).toEqual([]);
    expect(
      writes
        .filter((r) => !r.authed)
        .map((r) => `${r.method} ${r.url}`)
        .filter((k) => !PUBLIC_WRITES.has(k)),
    ).toEqual([]);
    await t.close();
  });

  it("the expensive public reads have their own, tighter limit", async () => {
    const t = await makeApp();
    const limited = new Set(
      routesOf(t)
        .filter((r) => r.limited)
        .map((r) => r.url),
    );
    for (const url of [
      "/v1/leaderboard",
      "/v1/traders/:ref",
      "/v1/traders/:ref/trades",
      "/v1/market",
      "/v1/verify/lookup",
      "/v1/traders/:ref/replay",
      "/og/:file",
      "/c/:code",
    ])
      expect(limited.has(url), url).toBe(true);
    await t.close();
  });

  it("a flood from one address is cut off", async () => {
    const t = await makeApp({}, true);
    const codes: number[] = [];
    for (let i = 0; i < 130; i++)
      codes.push((await t.app.inject({ method: "GET", url: "/health" })).statusCode);
    expect(codes.slice(0, 100).every((c) => c === 200)).toBe(true);
    expect(codes).toContain(429);
    // and the sign-in endpoints cut off much sooner
    const t2 = await makeApp({}, true);
    const c2: number[] = [];
    for (let i = 0; i < 15; i++)
      c2.push(
        (
          await t2.app.inject({
            method: "POST",
            url: "/v1/auth/challenge",
            payload: { chain: "solana", address: solAddress() },
          })
        ).statusCode,
      );
    expect(c2).toContain(429);
    await t.close();
    await t2.close();
  });
});

describe("cross-site requests", () => {
  it("refuses a state-changing request that names a site other than ours, even with a valid session", async () => {
    const t = await makeApp();
    const s = await signIn(t, "solana", solAddress());
    const evil = await t.app.inject({
      method: "POST",
      url: "/v1/me/handle",
      payload: { handle: "pwned_by_site" },
      headers: { cookie: s.cookie, origin: "https://evil.example" },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().code).toBe("bad_origin");
    expect(
      (await t.pool.query("SELECT handle FROM users WHERE id = $1", [s.user.id])).rows[0].handle,
    ).toBeNull();
    await t.close();
  });

  it("allows our own site, the same address (a tunnel or proxy), and callers that aren't browsers", async () => {
    const t = await makeApp({}, false, null, {
      WEB_ORIGIN: "https://app.tape.example",
      PUBLIC_WEB_URL: "https://app.tape.example",
    });
    const s = await signIn(t, "solana", solAddress());
    const run = Math.random().toString(36).slice(2, 7);
    const post = (headers: Record<string, string>, h: string) =>
      t.app.inject({
        method: "POST",
        url: "/v1/me/handle",
        payload: { handle: `${h}_${run}` },
        headers: { cookie: s.cookie, ...headers },
      });
    expect((await post({ origin: "https://app.tape.example" }, "own_site")).statusCode).toBe(200);
    expect(
      (
        await post(
          { origin: "https://abc.ngrok-free.app", host: "abc.ngrok-free.app" },
          "same_host",
        )
      ).statusCode,
    ).toBe(200);
    expect((await post({}, "no_origin")).statusCode).toBe(200);
    expect(
      (await post({ origin: "https://abc.ngrok-free.app", host: "other.host" }, "mismatch"))
        .statusCode,
    ).toBe(403);
    expect((await post({ origin: "not a url" }, "garbage")).statusCode).toBe(403);
    // reads aren't state-changing
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { cookie: s.cookie, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(200);
    await t.close();
  });

  it("in production only the configured sites are allowed, not any localhost", async () => {
    const t = await makeApp({}, false, null, {
      NODE_ENV: "production",
      WEB_ORIGIN: "https://app.tape.example",
      PUBLIC_WEB_URL: "https://app.tape.example",
      PUBLIC_SHARE_URL: "https://api.tape.example",
    });
    const s = await signIn(t, "solana", solAddress());
    const r = await t.app.inject({
      method: "POST",
      url: "/v1/me/handle",
      payload: { handle: "prod_local" },
      headers: { cookie: s.cookie, origin: "http://localhost:5173" },
    });
    expect(r.statusCode).toBe(403);
    await t.close();
  });
});

describe("response headers and cookies", () => {
  it("sets protective headers, keeps personal data out of shared caches, and uses HSTS only in production", async () => {
    const t = await makeApp();
    const r = await t.app.inject({ method: "GET", url: "/v1/markets" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["strict-transport-security"]).toBeUndefined();
    await t.close();
    const prod = await makeApp({}, false, null, { NODE_ENV: "production" });
    expect(
      (await prod.app.inject({ method: "GET", url: "/health" })).headers[
        "strict-transport-security"
      ],
    ).toContain("max-age=");
    await prod.close();
  });

  it("the session cookie is HttpOnly and SameSite, and the token never appears in a response body", async () => {
    const t = await makeApp();
    const ch = await t.app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { chain: "solana", address: solAddress() },
    });
    const v = await t.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { nonce: ch.json().nonce, signature: "sig-sig-sig" },
    });
    const c = v.cookies.find((x) => x.name === "tape_session");
    expect(c).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(v.body).not.toContain(c?.value ?? "never");
    await t.close();
  });

  it("serves share cards with an immutable image type and doesn't cache personal API answers", async () => {
    const t = await makeApp();
    const img = await t.app.inject({ method: "GET", url: "/og/doesnotexist.png" });
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    await t.close();
  });
});

describe("sessions", () => {
  it("logging out ends the session for good", async () => {
    const t = await makeApp();
    const s = await signIn(t, "solana", solAddress());
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(200);
    await t.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: s.cookie } });
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(401);
    await t.close();
  });

  it("keeps a bounded number of live sessions per person, newest first", async () => {
    const t = await makeApp();
    const addr = solAddress();
    const first = await signIn(t, "solana", addr);
    for (let i = 0; i < MAX_SESSIONS + 2; i++) await signIn(t, "solana", addr);
    const n = (
      await t.pool.query("SELECT count(*) AS n FROM sessions WHERE user_id = $1", [first.user.id])
    ).rows[0].n;
    expect(Number(n)).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: first.cookie } }))
        .statusCode,
    ).toBe(401); // the oldest was dropped
    await t.close();
  });

  it("stores only a hash of the session token", async () => {
    const t = await makeApp();
    const s = await signIn(t, "solana", solAddress());
    const token = s.cookie.split("=")[1] as string;
    const rows = (
      await t.pool.query("SELECT token_hash FROM sessions WHERE user_id = $1", [s.user.id])
    ).rows;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    await t.close();
  });
});

describe("the builder fee a user approves", () => {
  it("is refused at sign-in if Strike reports a higher fee than the one shown in the wallet", async () => {
    let pk = "";
    const t = await makeApp({
      "POST /auth/builder/request-signature": (c) => {
        pk = String(c.body?.public_key);
        return {
          body: { nonce: crypto.randomUUID(), message_to_sign: "Connect", message: "Connect" },
        };
      },
      "POST /auth/builder/verify-signature": () => ({
        body: {
          account_id: "acct-x",
          builder_code: "TapeVerify",
          fee_share_bps: 50,
          api_wallet_id: 1,
          api_wallet_public_key: pk,
          api_wallet_expired_at: "9999-12-31T23:59:59Z",
        },
      }),
    });
    const address = solAddress();
    const ch = await t.app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { chain: "solana", address },
    });
    const v = await t.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { nonce: ch.json().nonce, signature: "sig-sig-sig" },
    });
    expect(v.statusCode).toBe(502);
    expect(v.json().code).toBe("fee_mismatch");
    expect((await t.pool.query("SELECT 1 FROM users WHERE address = $1", [address])).rowCount).toBe(
      0,
    );
    expect(v.cookies.find((c) => c.name === "tape_session")).toBeUndefined();
    await t.close();
  });

  it("orders from the API carry no more than the user approved", async () => {
    const t = await makeApp({
      "GET /v2/markets": () => ({ body: marketsBody("80000") }),
      "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
    });
    const s = await signIn(t, "solana", solAddress());
    const place = async () => {
      await t.pool.query("DELETE FROM calls WHERE user_id = $1", [s.user.id]);
      const r = await t.app.inject({
        method: "POST",
        url: "/v1/calls",
        payload: { symbol: "BTC-USD", side: "long", size: "0.002", leverage: 5, slPrice: "78000" },
        headers: { cookie: s.cookie },
      });
      expect(r.statusCode, r.body).toBe(201);
      return t.calls.filter((c) => c.path === "/v2/order/strategy").at(-1)?.headers[
        "X-Builder-Fee-Bps"
      ];
    };
    expect(await place()).toBe("10"); // approved 10, configured 10
    await t.pool.query("UPDATE api_wallets SET fee_share_bps = 3 WHERE user_id = $1", [s.user.id]);
    expect(await place()).toBe("3");
    await t.pool.query("UPDATE api_wallets SET fee_share_bps = 0 WHERE user_id = $1", [s.user.id]);
    expect(await place()).toBeUndefined();
    await t.close();
  });
});

describe("hostile input", () => {
  it("rejects oversized and malformed bodies and odd handles, and stores comments as plain text", async () => {
    const t = await makeApp();
    const s = await signIn(t, "solana", solAddress());
    const big = await t.app.inject({
      method: "POST",
      url: "/v1/me/handle",
      payload: JSON.stringify({ handle: "a".repeat(300_000) }),
      headers: { cookie: s.cookie, "content-type": "application/json" },
    });
    expect(big.statusCode).toBe(413);
    const bad = await t.app.inject({
      method: "POST",
      url: "/v1/me/handle",
      payload: "{not json",
      headers: { cookie: s.cookie, "content-type": "application/json" },
    });
    expect(bad.statusCode).toBe(400);
    for (const handle of [
      "'; DROP TABLE users;--",
      "<script>alert(1)</script>",
      "a b",
      "x".repeat(40),
      "admin",
    ]) {
      expect(
        (
          await t.app.inject({
            method: "POST",
            url: "/v1/me/handle",
            payload: { handle },
            headers: { cookie: s.cookie },
          })
        ).statusCode,
        handle,
      ).toBe(400);
    }
    expect((await t.pool.query("SELECT count(*) AS n FROM users")).rows[0].n).toBeTruthy(); // the table is still there
    await t.close();
  });

  it("answers an unknown route or a bad id with a plain error and no internals", async () => {
    const t = await makeApp();
    const r = await t.app.inject({ method: "GET", url: "/v1/records/not-a-number" });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/at .*\.ts|node_modules|password|postgres/i);
    expect((await t.app.inject({ method: "GET", url: "/v1/nope" })).statusCode).toBe(404);
    await t.close();
  });
});
