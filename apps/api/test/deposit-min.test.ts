import { describe, expect, it } from "vitest";
import { suggestAmount } from "../src/routes/funds.js";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const quote = (usd: string) => ({
  "POST /v2/deposit/quote": () => ({
    body: {
      request_id: `dep-${crypto.randomUUID()}`,
      quote: { usd_value: usd, expiration_at: Date.now() + 600_000 },
      deposit_address: "VAULT",
      confirmations_required: 1,
    },
  }),
});
const portfolio = (min: unknown) => ({
  "GET /v2/portfolio": () => ({ body: { min_deposit_usd: min } }),
});
const ask = async (t: TestApp, amount: string) => {
  const s = await signIn(t, "solana", solAddress());
  return t.app.inject({
    method: "POST",
    url: "/v1/deposit/quote",
    payload: { asset: "USDC", amount },
    headers: { cookie: s.cookie },
  });
};

describe("suggesting a deposit that clears the minimum", () => {
  it("rounds up with a little room, and handles cheap assets", () => {
    expect(suggestAmount(5, 0.99992)).toBe("5.03");
    expect(suggestAmount(5, 1)).toBe("5.03");
    expect(suggestAmount(5, 0.21)).toBe("23.93"); // ADA at about 21 cents
    expect(suggestAmount(5, 80_000)).toBe("0.000063"); // BTC-sized assets keep their precision
    expect(suggestAmount(5, 0)).toBeNull();
  });
});

describe("the deposit minimum", () => {
  it("says what the amount is worth and what to try when a stablecoin quotes a hair under $5", async () => {
    const t = await makeApp({ ...quote("4.9996"), ...portfolio(5) });
    const r = await ask(t, "5");
    expect(r.statusCode).toBe(400);
    const b = r.json();
    expect(b.code).toBe("below_minimum");
    expect(b.error).toContain("Minimum deposit is $5");
    expect(b.error).toContain("5 USDC is worth $4.9996");
    expect(b.suggestedAmount).toBe("5.03");
    expect(b).toMatchObject({ minUsd: 5, usdValue: 4.9996 });
    await t.close();
  });

  it("accepts exactly the minimum", async () => {
    const t = await makeApp({ ...quote("5.0000"), ...portfolio(5) });
    expect((await ask(t, "5")).statusCode).toBe(200);
    await t.close();
  });

  it("uses the minimum Strike reports, not a fixed $5", async () => {
    const lower = await makeApp({ ...quote("2.50"), ...portfolio(2) });
    expect((await ask(lower, "2.5")).statusCode).toBe(200);
    await lower.close();
    const higher = await makeApp({ ...quote("7.00"), ...portfolio(10) });
    const r = await ask(higher, "7");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("Minimum deposit is $10");
    await higher.close();
  });

  it("falls back to $5 when Strike doesn't say", async () => {
    const t = await makeApp({
      ...quote("4.00"),
      "GET /v2/portfolio": () => ({ status: 500, body: { error: "down" } }),
    });
    const r = await ask(t, "4");
    expect(r.statusCode).toBe(400);
    expect(r.json().minUsd).toBe(5);
    await t.close();
  });

  it("explains a cheap asset: five units isn't five dollars", async () => {
    const t = await makeApp({ ...quote("1.05"), ...portfolio(5) });
    const r = await ask(t, "5");
    expect(r.json().error).toContain("5 USDC is worth $1.05");
    expect(r.json().suggestedAmount).toBe("23.93");
    await t.close();
  });
});
