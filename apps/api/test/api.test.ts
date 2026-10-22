import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaAddress, ethAddress, makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

const post = (cookie: string, url: string, payload: unknown) =>
  t.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });

describe("auth", () => {
  it("rejects malformed addresses per chain", async () => {
    for (const [chain, address] of [
      ["solana", "not-a-solana-address-at-all-xxxxxx"],
      ["ethereum", "0x1234567890123456789012345678901234567890zz"],
      ["cardano", "addr1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    ] as const) {
      const r = await t.app.inject({
        method: "POST",
        url: "/v1/auth/challenge",
        payload: { chain, address },
      });
      expect(r.statusCode, chain).toBe(400);
    }
  });

  it("connects, sets an httpOnly cookie, and never stores the API key in plaintext", async () => {
    const addr = solAddress();
    const ch = await t.app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { chain: "solana", address: addr },
    });
    const { nonce, feeShareBps } = ch.json();
    expect(feeShareBps).toBe(10);
    const v = await t.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { nonce, signature: "sig-sig-sig" },
    });
    expect(v.statusCode).toBe(200);
    const c = v.cookies.find((x) => x.name === "tape_session");
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe("Lax");

    const { rows } = await t.pool.query(
      "SELECT w.public_key, w.sealed_private_key FROM api_wallets w JOIN users u ON u.id = w.user_id WHERE u.address = $1",
      [addr],
    );
    expect(rows).toHaveLength(1);
    const raw = JSON.stringify(rows[0].sealed_private_key);
    expect(raw).not.toMatch(/"[0-9a-f]{64}"/); // no bare 32-byte hex key anywhere in the envelope
    expect(Object.keys(rows[0].sealed_private_key).sort()).toEqual([
      "ciphertext",
      "iv",
      "kekId",
      "tag",
      "v",
      "wrappedDek",
    ]);
    // The API key was sent to Strike only as a public key.
    expect(JSON.stringify(t.calls)).not.toContain(rows[0].sealed_private_key.ciphertext);
  });

  it("makes a challenge single-use", async () => {
    const ch = await t.app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { chain: "solana", address: solAddress() },
    });
    const { nonce } = ch.json();
    const a = await t.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { nonce, signature: "sig-sig-sig" },
    });
    const b = await t.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { nonce, signature: "sig-sig-sig" },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(400);
  });

  it("lowercases Ethereum addresses so one wallet maps to one user", async () => {
    const addr = ethAddress();
    const a = await signIn(t, "ethereum", addr.toUpperCase().replace("0X", "0x"));
    const b = await signIn(t, "ethereum", addr);
    expect(a.user.id).toBe(b.user.id);
    expect(a.user.address).toBe(addr.toLowerCase());
  });

  it("revokes the previous API wallet when the same user reconnects", async () => {
    const addr = solAddress();
    const first = await signIn(t, "solana", addr);
    await signIn(t, "solana", addr);
    const { rows } = await t.pool.query(
      "SELECT revoked_at FROM api_wallets WHERE user_id = $1 ORDER BY created_at",
      [first.user.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[1].revoked_at).toBeNull();
  });

  it("requires a session and logout ends it", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/account" })).statusCode).toBe(401);
    const s = await signIn(t, "solana", solAddress());
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(200);
    await post(s.cookie, "/v1/auth/logout", {});
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(401);
  });
});

describe("account", () => {
  it("returns the Strike account for the signed-in user using signed API-wallet requests", async () => {
    const s = await signIn(t, "solana", solAddress());
    const before = t.calls.length;
    const r = await t.app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { cookie: s.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().account.available_balance).toBe("90");
    const acct = t.calls.slice(before).find((c) => c.path === "/v2/account");
    expect(acct?.headers["X-API-Wallet-Signature"]).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe("deposit", () => {
  it("rejects unsupported assets and amounts below the $5 minimum", async () => {
    const s = await signIn(t, "solana", solAddress());
    expect(
      (await post(s.cookie, "/v1/deposit/quote", { asset: "ADA", amount: "10" })).statusCode,
    ).toBe(400);
    const low = await post(s.cookie, "/v1/deposit/quote", { asset: "USDC", amount: "3" });
    expect(low.statusCode).toBe(400);
    expect(low.json().code).toBe("below_minimum");
    const { rowCount } = await t.pool.query("SELECT 1 FROM deposits WHERE user_id = $1", [
      s.user.id,
    ]);
    expect(rowCount).toBe(0);
  });

  it("runs quote -> build (user's own address) -> confirm", async () => {
    const addr = solAddress();
    const s = await signIn(t, "solana", addr);
    const q = await post(s.cookie, "/v1/deposit/quote", { asset: "USDC", amount: "10" });
    expect(q.statusCode).toBe(200);
    expect(q.json().assetAmount).toBe("10000000");
    const { requestId } = q.json();

    const b = await post(s.cookie, "/v1/deposit/build", { requestId });
    expect(b.statusCode).toBe(200);
    const built = t.calls.filter((c) => c.path === "/v2/deposit/build-tx").at(-1);
    expect(built?.body?.user_address).toBe(addr);

    const c = await post(s.cookie, "/v1/deposit/confirm", {
      requestId,
      txHash: "5abc123def456ghi",
    });
    expect(c.statusCode).toBe(200);
    const { rows } = await t.pool.query(
      "SELECT status, tx_hash FROM deposits WHERE request_id = $1",
      [requestId],
    );
    expect(rows[0]).toEqual({ status: "submitted", tx_hash: "5abc123def456ghi" });
  });

  it("won't build or confirm another user's quote", async () => {
    const a = await signIn(t, "solana", solAddress());
    const b = await signIn(t, "solana", solAddress());
    const { requestId } = (
      await post(a.cookie, "/v1/deposit/quote", { asset: "USDC", amount: "10" })
    ).json();
    expect((await post(b.cookie, "/v1/deposit/build", { requestId })).statusCode).toBe(404);
    expect(
      (await post(b.cookie, "/v1/deposit/confirm", { requestId, txHash: "5abc123def456ghi" }))
        .statusCode,
    ).toBe(404);
  });

  it("requires UTxOs for Cardano builds", async () => {
    const s = await signIn(t, "cardano", adaAddress());
    const q = await post(s.cookie, "/v1/deposit/quote", { asset: "ADA", amount: "20" });
    expect(q.statusCode).toBe(200);
    const { requestId } = q.json();
    expect((await post(s.cookie, "/v1/deposit/build", { requestId })).statusCode).toBe(400);
    expect(
      (await post(s.cookie, "/v1/deposit/build", { requestId, utxos: ["82..."] })).statusCode,
    ).toBe(200);
  });
});

describe("withdraw", () => {
  it("only ever targets the connected wallet", async () => {
    const addr = solAddress();
    const s = await signIn(t, "solana", addr);
    const r = await post(s.cookie, "/v1/withdraw/quote", {
      usd: "10",
      asset: "USDC",
      recipientAddress: "attacker",
      recipient_address: "attacker",
    });
    expect(r.statusCode).toBe(200);
    const sent = t.calls.filter((c) => c.path === "/v2/withdraw/quote").at(-1);
    expect(sent?.body?.wallet_address).toBe(addr);
    expect(sent?.body).not.toHaveProperty("recipient_address");
    expect(JSON.stringify(sent?.body)).not.toContain("attacker");
  });

  it("enforces the minimum and the quote is single-use and owner-bound", async () => {
    const a = await signIn(t, "solana", solAddress());
    const b = await signIn(t, "solana", solAddress());
    expect(
      (await post(a.cookie, "/v1/withdraw/quote", { usd: "2", asset: "USDC" })).statusCode,
    ).toBe(400);
    const { withdrawId } = (
      await post(a.cookie, "/v1/withdraw/quote", { usd: "10", asset: "USDC" })
    ).json();

    expect(
      (await post(b.cookie, "/v1/withdraw/confirm", { withdrawId, signature: "sig-sig-sig" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(a.cookie, "/v1/withdraw/confirm", { withdrawId, signature: "sig-sig-sig" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(a.cookie, "/v1/withdraw/confirm", { withdrawId, signature: "sig-sig-sig" }))
        .statusCode,
    ).toBe(404);
    expect(
      t.calls.filter(
        (c) =>
          c.method === "POST" && c.path === "/v2/withdraw" && c.body?.withdraw_id === withdrawId,
      ),
    ).toHaveLength(1);
  });

  it("flags Cardano payloads as already hex", async () => {
    const s = await signIn(t, "cardano", adaAddress());
    const r = await post(s.cookie, "/v1/withdraw/quote", { usd: "10", asset: "USDM" });
    expect(r.json().payloadIsHex).toBe(true);
  });
});

describe("revoked API wallet", () => {
  it("asks the user to reconnect and marks the wallet revoked", async () => {
    const r = await makeApp({
      "GET /v2/account": () => ({ status: 401, body: { error: "wallet expired or revoked" } }),
    });
    const s = await signIn(r, "solana", solAddress());
    const res = await r.app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("reconnect_required");
    const { rows } = await r.pool.query("SELECT revoked_at FROM api_wallets WHERE user_id = $1", [
      s.user.id,
    ]);
    expect(rows[0].revoked_at).not.toBeNull();
    await r.close();
  });
});

describe("rate limiting", () => {
  it("throttles the challenge endpoint per client", async () => {
    const r = await makeApp({}, true);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await r.app.inject({
        method: "POST",
        url: "/v1/auth/challenge",
        payload: { chain: "solana", address: solAddress() },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    await r.close();
  });
});
