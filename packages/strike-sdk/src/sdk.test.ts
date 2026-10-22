import { describe, expect, it } from "vitest";
import { StrikeClient } from "./client.js";
import { StrikeApiError } from "./errors.js";
import {
  EMPTY_BODY_SHA256,
  generateApiWalletKeys,
  signLogon,
  signRequest,
  verifySignature,
} from "./signing.js";
import { backoffMs } from "./ws.js";

describe("signing", () => {
  it("empty body hash matches sha256('')", () => {
    expect(EMPTY_BODY_SHA256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("signs {METHOD}:{PATH}:{TS}:{NONCE}:{BODY_HASH}, query included, and verifies", () => {
    const keys = generateApiWalletKeys();
    const h = signRequest("get", "/v2/positions?symbol=BTC-USD", "", keys, {
      timestamp: 1700000000,
      nonce: "n".repeat(20),
    });
    const msg = `GET:/v2/positions?symbol=BTC-USD:1700000000:${"n".repeat(20)}:${EMPTY_BODY_SHA256}`;
    expect(h["X-API-Wallet-Public-Key"]).toBe(keys.publicKey);
    expect(verifySignature(msg, h["X-API-Wallet-Signature"] as string, keys.publicKey)).toBe(true);
    expect(verifySignature(`${msg}x`, h["X-API-Wallet-Signature"] as string, keys.publicKey)).toBe(
      false,
    );
  });

  it("uses a fresh nonce per call", () => {
    const keys = generateApiWalletKeys();
    const a = signRequest("GET", "/v2/account", "", keys);
    const b = signRequest("GET", "/v2/account", "", keys);
    expect(a["X-API-Wallet-Nonce"]).not.toBe(b["X-API-Wallet-Nonce"]);
    expect((a["X-API-Wallet-Nonce"] ?? "").length).toBeGreaterThanOrEqual(16);
  });

  it("signs logon with a millisecond timestamp", () => {
    const keys = generateApiWalletKeys();
    const p = signLogon(keys, 1700000000123);
    expect(
      verifySignature(`session.logon:1700000000123:${keys.publicKey}`, p.signature, keys.publicKey),
    ).toBe(true);
  });
});

describe("StrikeClient", () => {
  const keys = generateApiWalletKeys();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("rejects a base URL with a path", () => {
    expect(() => new StrikeClient({ baseUrl: "https://x.test/price" })).toThrow();
  });

  it("clamps builder fee to 0..100 and to the configured fee", () => {
    const c = new StrikeClient({ baseUrl: "https://x.test", builderFeeBps: 10 });
    expect(c.builderFeeHeaders()).toEqual({ "X-Builder-Fee-Bps": "10" });
    expect(c.builderFeeHeaders(50)).toEqual({ "X-Builder-Fee-Bps": "10" });
    expect(c.builderFeeHeaders(-5)).toEqual({});
    expect(
      new StrikeClient({ baseUrl: "https://x.test", builderFeeBps: 0 }).builderFeeHeaders(5),
    ).toEqual({});
  });

  it("retries GET on 5xx with fresh nonces, then succeeds", async () => {
    const nonces: string[] = [];
    let n = 0;
    const fetchMock = (async (_u: string, init: RequestInit) => {
      nonces.push((init.headers as Record<string, string>)["X-API-Wallet-Nonce"] as string);
      return ++n < 3 ? json(503, { error: "busy" }) : json(200, { ok: true });
    }) as unknown as typeof fetch;
    const c = new StrikeClient({ baseUrl: "https://x.test", keys, fetch: fetchMock });
    await expect(c.get("/v2/account")).resolves.toEqual({ ok: true });
    expect(new Set(nonces).size).toBe(3);
  });

  it("never retries POST (orders)", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return json(500, { error: "boom" });
    }) as unknown as typeof fetch;
    const c = new StrikeClient({ baseUrl: "https://x.test", keys, fetch: fetchMock });
    await expect(c.post("/v2/order", { a: 1 })).rejects.toBeInstanceOf(StrikeApiError);
    expect(calls).toBe(1);
  });

  it("does not retry 4xx and surfaces the server error", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return json(400, { error: "fee too high" });
    }) as unknown as typeof fetch;
    const c = new StrikeClient({ baseUrl: "https://x.test", keys, fetch: fetchMock });
    await expect(c.get("/v2/account")).rejects.toMatchObject({
      status: 400,
      message: "fee too high",
    });
    expect(calls).toBe(1);
  });
});

describe("ws backoff", () => {
  it("grows then caps at ~30s", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(2000);
    expect(backoffMs(3, mid)).toBe(8000);
    expect(backoffMs(50, mid)).toBeLessThanOrEqual(30_000);
  });
});
