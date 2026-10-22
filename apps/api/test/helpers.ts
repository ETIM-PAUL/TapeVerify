import { randomBytes } from "node:crypto";
import { KeyVault, LocalKekProvider, loadStrikeConfig } from "@pit/shared";
import { base58, bech32 } from "@scure/base";
import pg from "pg";
import type { DraftFn } from "../src/ai/translate.js";
import { buildApp } from "../src/app.js";
import { loadApiConfig } from "../src/config.js";
import { StrikeGateway } from "../src/gateway.js";

export const marketsBody = (mark: string) => ({
  markets: {
    "BTC-USD": {
      symbol: "BTC-USD",
      base_asset: "BTC",
      status: "trading",
      reduce_only: false,
      default_leverage: 20,
      margin_tiers: [
        { max_notional: "300000", max_leverage: 150 },
        { max_notional: "800000", max_leverage: 100 },
      ],
      order_tick_price: "0.10",
      order_min_price: "0.10",
      order_max_price: "0",
      order_market_step_size: "0.00001",
      order_market_min_size: "0.00001",
      order_market_max_size: "120",
      order_min_notional: "100",
      mark_price: mark,
    },
  },
});

export const solAddress = () => base58.encode(randomBytes(32));
export const ethAddress = () => `0x${randomBytes(20).toString("hex")}`;
export const adaAddress = () => bech32.encode("addr_test", bech32.toWords(randomBytes(57)), 1023);

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export type Handler = (call: Call) => { status?: number; body: unknown } | undefined;

/** Fake Strike server: handlers override defaults; every call is recorded. */
export function fakeStrike(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  let publicKey = "";
  const defaults: Record<string, Handler> = {
    "GET /v2/time": () => ({ body: { serverTime: Date.now() } }),
    "POST /auth/builder/request-signature": (c) => {
      publicKey = String(c.body?.public_key);
      return {
        body: {
          nonce: crypto.randomUUID(),
          message_to_sign: "Connect to Strike",
          message: "Connect to Strike",
        },
      };
    },
    "POST /auth/builder/verify-signature": () => ({
      body: {
        account_id: "acct-1",
        builder_code: "Pit",
        fee_share_bps: 10,
        api_wallet_id: 1,
        api_wallet_public_key: publicKey,
        api_wallet_expired_at: "9999-12-31T23:59:59Z",
      },
    }),
    "GET /v2/markets": () => ({ body: marketsBody("80000") }),
    "POST /v2/leverage": (c) => ({ body: { leverage: c.body?.leverage, symbol: c.body?.symbol } }),
    "POST /v2/order/strategy": (c) => ({
      status: 201,
      body: {
        strategy_id: c.body?.strategy_id,
        primary_client_order_id: c.body?.client_order_id,
        tp_client_order_id: "tp-cid",
        sl_client_order_id: "sl-cid",
      },
    }),
    "POST /v2/order": (c) => ({ status: 201, body: { client_order_id: c.body?.client_order_id } }),
    "DELETE /v2/order/cancel": () => ({ body: { order_id: 1 } }),
    "GET /v2/account": () => ({
      body: { account_id: "acct-1", wallet_balance: "100", available_balance: "90" },
    }),
    "GET /v2/positions": () => ({ body: { positions: [], count: 0 } }),
    "POST /v2/deposit/quote": (c) => ({
      body: {
        request_id: `dep-${crypto.randomUUID()}`,
        quote: {
          usd_value: String(Number(c.body?.asset_amount) / 1e6),
          expiration_at: Date.now() + 600_000,
        },
        deposit_address: "VAULT",
        confirmations_required: 150,
      },
    }),
    "POST /v2/deposit/build-tx": () => ({
      body: { blockchain: "solana", format: "solana_base64", unsigned_tx: "AAAA", expires_at: 1 },
    }),
    "POST /v2/deposit": (c) => ({ body: { request_id: c.body?.request_id, status: "pending" } }),
    "POST /v2/withdraw/quote": () => ({
      body: {
        withdraw_id: `wd-${crypto.randomUUID()}`,
        fee: "1",
        message_to_sign: "Authorize withdrawal",
      },
    }),
    "POST /v2/withdraw": (c) => ({
      body: { request_id: c.body?.withdraw_id, status: "pending", sequence_id: 1, message_id: "m" },
    }),
  };
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    const call: Call = {
      method,
      path: u.pathname + u.search,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const h = overrides[`${method} ${u.pathname}`] ?? defaults[`${method} ${u.pathname}`];
    const r = h?.(call) ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export async function makeApp(
  overrides: Record<string, Handler> = {},
  rateLimit = false,
  draft: DraftFn | null = null,
) {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const vault = new KeyVault(new LocalKekProvider("t1", { t1: randomBytes(32) }));
  const strike = fakeStrike(overrides);
  const cfg = loadStrikeConfig({
    STRIKE_NETWORK: "testnet",
    BUILDER_CODE: "Pit",
    BUILDER_FEE_BPS: "10",
  });
  const gateway = new StrikeGateway(pool, vault, cfg, strike.fetchImpl);
  const app = await buildApp({
    pool,
    vault,
    gateway,
    draft,
    api: loadApiConfig({ RATE_LIMIT: rateLimit ? "on" : "off" }),
  });
  return {
    app,
    pool,
    vault,
    calls: strike.calls,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

/** Runs challenge + verify and returns the session cookie header and user. */
export async function signIn(
  t: TestApp,
  chain: "solana" | "ethereum" | "cardano",
  address: string,
) {
  const ch = await t.app.inject({
    method: "POST",
    url: "/v1/auth/challenge",
    payload: { chain, address },
  });
  if (ch.statusCode !== 200) throw new Error(`challenge failed: ${ch.body}`);
  const { nonce } = ch.json();
  const v = await t.app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: { nonce, signature: "sig-sig-sig" },
  });
  if (v.statusCode !== 200) throw new Error(`verify failed: ${v.body}`);
  const cookie = `pit_session=${v.cookies.find((c) => c.name === "pit_session")?.value}`;
  return { cookie, user: v.json().user, nonce };
}
