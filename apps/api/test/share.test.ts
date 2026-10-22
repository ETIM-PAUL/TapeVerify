import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const good = {
  symbol: "BTC-USD",
  side: "long",
  size: "0.002",
  leverage: 10,
  tpPrice: "84000",
  slPrice: "78000",
};
let t: TestApp;
let code: string;
let id: string;
let userId: string;

beforeAll(async () => {
  t = await makeApp({
    "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
  });
  const s = await signIn(t, "solana", solAddress());
  userId = s.user.id;
  const call = (
    await t.app.inject({
      method: "POST",
      url: "/v1/calls",
      payload: good,
      headers: { cookie: s.cookie },
    })
  ).json().call;
  code = call.code;
  id = call.id;
  await t.pool.query(
    "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1, expires_at = $2 WHERE id = $1",
    [id, Date.now() + 3_600_000],
  );
});
afterAll(async () => t.close());

const png = (b: Buffer) => ({
  magic: b.subarray(0, 8).toString("hex"),
  w: b.readUInt32BE(16),
  h: b.readUInt32BE(20),
});

describe("preview card", () => {
  it("serves a 1200x630 PNG for a call", async () => {
    const r = await t.app.inject({ method: "GET", url: `/og/${code}.png` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(png(r.rawPayload)).toEqual({ magic: "89504e470d0a1a0a", w: 1200, h: 630 });
    expect(Number(r.rawPayload.length)).toBeGreaterThan(5000);
  });

  it("renders every status without error", async () => {
    for (const status of ["pending", "open", "expired", "closed", "failed"]) {
      await t.pool.query(
        "UPDATE calls SET status = $2, exit_price = 84000, exit_reason = 'tp' WHERE id = $1",
        [id, status],
      );
      const r = await t.app.inject({ method: "GET", url: `/og/${code}.png` });
      expect(r.statusCode, status).toBe(200);
      expect(png(r.rawPayload).w).toBe(1200);
    }
    await t.pool.query(
      "UPDATE calls SET status = 'open', exit_price = NULL, exit_reason = NULL WHERE id = $1",
      [id],
    );
  });

  it("404s for unknown or malformed codes", async () => {
    for (const u of ["/og/ZZZZZZZZ.png", "/og/..%2Fetc.png", "/og/abc", "/og/none.png"]) {
      expect((await t.app.inject({ method: "GET", url: u })).statusCode, u).toBe(404);
    }
  });
});

describe("share page", () => {
  it("has the Open Graph and Twitter tags crawlers need, pointing at the card and the app", async () => {
    const r = await t.app.inject({ method: "GET", url: `/c/${code}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    const h = r.body;
    expect(h).toContain('<meta property="og:title" content="BTC-USD long 10x · entry $80,000');
    expect(h).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(h).toContain(
      `<meta property="og:image" content="http://localhost:3001/og/${code}.png?v=open-`,
    );
    expect(h).toContain('<meta property="og:image:width" content="1200">');
    expect(h).toContain('<meta property="og:image:height" content="630">');
    expect(h).toContain(`<meta property="og:url" content="http://localhost:3001/c/${code}">`);
    expect(h).toContain(`http://localhost:5173/call/${code}`); // people are sent on to the app
  });

  it("escapes anything user-controlled", async () => {
    await t.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [
      userId,
      `"><script>alert(1)</script>`,
    ]);
    const h = (await t.app.inject({ method: "GET", url: `/c/${code}` })).body;
    expect(h).not.toContain("<script>alert(1)");
    expect(h).not.toContain('"><script>');
    expect(h).toContain("&lt;script&gt;");
    expect((await t.app.inject({ method: "GET", url: `/og/${code}.png` })).statusCode).toBe(200);
    await t.pool.query("UPDATE users SET handle = NULL WHERE id = $1", [userId]);
  });

  it("returns a 404 page (still with tags) for an unknown call", async () => {
    const r = await t.app.inject({ method: "GET", url: "/c/nope1234" });
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain("og:title");
    expect((await t.app.inject({ method: "GET", url: "/c/%3Cscript%3E" })).statusCode).toBe(404);
  });
});
