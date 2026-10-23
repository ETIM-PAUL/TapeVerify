import { describe, expect, it } from "vitest";
import {
  adaAddress,
  ethAddress,
  makeApp,
  marketsBody,
  signIn,
  solAddress,
  type TestApp,
} from "./helpers.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const rich = {
  "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
};
const hash = () =>
  `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

/** Ethereum and Koios nodes where each transaction maps to what it should return. */
function chains() {
  const evm = new Map<
    string,
    { to: string; value: bigint; from?: string; ok?: boolean; time?: number }
  >();
  const ada = new Map<string, { to: string; lovelace: bigint; time?: number }>();
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (url.includes("koios")) {
      const tx = ada.get(body._tx_hashes[0]);
      return new Response(
        JSON.stringify(
          tx
            ? [
                {
                  tx_hash: body._tx_hashes[0],
                  block_height: 99,
                  tx_timestamp: tx.time ?? Math.floor(Date.now() / 1000),
                  outputs: [{ payment_addr: { bech32: tx.to }, value: String(tx.lovelace) }],
                },
              ]
            : [],
        ),
      );
    }
    if (body.method === "eth_getTransactionReceipt") {
      const tx = evm.get(body.params[0]);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: tx
            ? {
                status: tx.ok === false ? "0x0" : "0x1",
                blockNumber: "0x10",
                logs: [
                  {
                    address: SEPOLIA_USDC.toLowerCase(),
                    topics: [TRANSFER, pad(tx.from ?? ethAddress()), pad(tx.to)],
                    data: `0x${tx.value.toString(16).padStart(64, "0")}`,
                  },
                ],
              }
            : null,
        }),
      );
    }
    const tx = [...evm.values()][0];
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { timestamp: `0x${(tx?.time ?? Math.floor(Date.now() / 1000)).toString(16)}` },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, evm, ada };
}

const markets = () => {
  const m = marketsBody("80000");
  return {
    markets: {
      ...m.markets,
      "ADA-USD": {
        ...m.markets["BTC-USD"],
        symbol: "ADA-USD",
        base_asset: "ADA",
        mark_price: "0.5",
      },
    },
  };
};

async function world() {
  const c = chains();
  const t = await makeApp(
    { ...rich, "GET /v2/markets": () => ({ body: markets() }) },
    false,
    null,
    {},
    {
      fetchImpl: c.fetchImpl,
    },
  );
  const creator = await signIn(t, "solana", solAddress());
  const handle = `cr${Math.random().toString(36).slice(2, 9)}`;
  await t.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [creator.user.id, handle]);
  const addrs = { payAddress: solAddress(), ethAddress: ethAddress(), adaAddress: adaAddress() };
  return { t, c, creator, handle, addrs };
}
const j = (
  t: TestApp,
  method: "GET" | "POST" | "PUT",
  url: string,
  cookie?: string,
  payload?: unknown,
) => t.app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
const plan = (t: TestApp, cookie: string, over: Record<string, unknown>) =>
  j(t, "PUT", "/v1/me/plan", cookie, { priceUsdc: 10, periodDays: 30, active: true, ...over });

describe("subscription plans on several chains", () => {
  it("saves an address per chain, lists the accepted chains publicly and never the addresses", async () => {
    const { t, creator, handle, addrs } = await world();
    expect((await plan(t, creator.cookie, addrs)).statusCode).toBe(200);
    const pub = (await j(t, "GET", `/v1/creators/${handle}/plan`)).json();
    expect(pub.plan).toEqual({
      priceUsdc: "10",
      periodDays: 30,
      chains: ["solana", "ethereum", "cardano"],
    });
    expect(JSON.stringify(pub)).not.toContain(addrs.ethAddress);
    const mine = (await j(t, "GET", "/v1/me/plan", creator.cookie)).json();
    expect(mine.plan).toMatchObject({
      ethAddress: addrs.ethAddress.toLowerCase(),
      adaAddress: addrs.adaAddress,
    });
    // Ethereum only is a valid plan too
    expect((await plan(t, creator.cookie, { ethAddress: addrs.ethAddress })).statusCode).toBe(200);
    expect((await j(t, "GET", `/v1/creators/${handle}/plan`)).json().plan.chains).toEqual([
      "ethereum",
    ]);
    await t.close();
  });

  it("rejects bad addresses and a plan with no address", async () => {
    const { t, creator, addrs } = await world();
    expect((await plan(t, creator.cookie, { ethAddress: "0x123" })).statusCode).toBe(400);
    expect(
      (await plan(t, creator.cookie, { adaAddress: addrs.payAddress.repeat(2) })).statusCode,
    ).toBe(400);
    expect((await plan(t, creator.cookie, {})).statusCode).toBe(400);
    await t.close();
  });
});

describe("paying on Ethereum", () => {
  it("asks for an exact tagged USDC amount and confirms a matching transfer once", async () => {
    const { t, c, creator, handle, addrs } = await world();
    await plan(t, creator.cookie, addrs);
    const fan = await signIn(t, "ethereum", ethAddress());
    const i = (
      await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, { chain: "ethereum" })
    ).json();
    expect(i.pay).toMatchObject({
      chain: "ethereum",
      asset: "USDC",
      exact: true,
      memo: null,
      address: addrs.ethAddress.toLowerCase(),
    });
    const base = BigInt(Math.round(Number(i.pay.amount) * 1e6));
    expect(base).toBeGreaterThan(10_000_000n);
    expect(base).toBeLessThanOrEqual(10_000_099n);

    const h = hash();
    c.evm.set(h, { to: addrs.ethAddress, value: base - 1n });
    const wrong = await j(
      t,
      "POST",
      `/v1/subscriptions/payments/${i.paymentId}/confirm`,
      fan.cookie,
      { signature: h },
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe("wrong_amount");

    c.evm.set(h, { to: addrs.ethAddress, value: base });
    const ok = await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
      signature: h.toUpperCase().replace("0X", "0x"),
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const other = await signIn(t, "ethereum", ethAddress());
    const i2 = (
      await j(t, "POST", `/v1/creators/${handle}/subscribe`, other.cookie, { chain: "ethereum" })
    ).json();
    expect(i2.pay.amount).not.toBe(i.pay.amount); // each pending payment has its own amount
    const reuse = await j(
      t,
      "POST",
      `/v1/subscriptions/payments/${i2.paymentId}/confirm`,
      other.cookie,
      { signature: h },
    );
    // someone else can't claim it: their intent has a different exact amount
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json().code).toBe("wrong_amount");
    await t.close();
  });

  it("accepts the plain price, without the tag, when it comes from the subscriber's own signed-in wallet", async () => {
    const { t, c, creator, handle, addrs } = await world();
    await plan(t, creator.cookie, addrs);
    const wallet = ethAddress();
    const fan = await signIn(t, "ethereum", wallet);
    const i = (
      await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, { chain: "ethereum" })
    ).json();

    const fromSomeoneElse = hash();
    c.evm.set(fromSomeoneElse, { to: addrs.ethAddress, value: 10_000_000n });
    const r1 = await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
      signature: fromSomeoneElse,
    });
    expect(r1.json().code).toBe("wrong_amount");

    const fromMe = hash();
    c.evm.set(fromMe, { to: addrs.ethAddress, value: 10_000_000n, from: wallet });
    const r2 = await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
      signature: fromMe,
    });
    expect(r2.statusCode, r2.body).toBe(200);
    await t.close();
  });

  it("refuses a chain the creator doesn't accept", async () => {
    const { t, creator, handle, addrs } = await world();
    await plan(t, creator.cookie, { payAddress: addrs.payAddress });
    const fan = await signIn(t, "ethereum", ethAddress());
    const r = await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {
      chain: "ethereum",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "chain_not_accepted", chains: ["solana"] });
    await t.close();
  });
});

describe("paying on Cardano", () => {
  it("prices the subscription in ADA from the ADA-USD mark and confirms an exact lovelace payment", async () => {
    const { t, c, creator, handle, addrs } = await world();
    await plan(t, creator.cookie, addrs);
    const fan = await signIn(t, "cardano", adaAddress());
    const i = (
      await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, { chain: "cardano" })
    ).json();
    expect(i.pay).toMatchObject({
      chain: "cardano",
      asset: "ADA",
      exact: true,
      address: addrs.adaAddress,
    });
    const lovelace = BigInt(Math.round(Number(i.pay.amount) * 1e6));
    // $10 at $0.50 per ADA = 20 ADA, plus the tag
    expect(lovelace).toBeGreaterThan(20_000_000n);
    expect(lovelace).toBeLessThanOrEqual(20_000_099n);

    const h = hash().slice(2);
    c.ada.set(h, { to: addrs.adaAddress, lovelace: lovelace + 1n });
    const wrong = await j(
      t,
      "POST",
      `/v1/subscriptions/payments/${i.paymentId}/confirm`,
      fan.cookie,
      { signature: h },
    );
    expect(wrong.json().code).toBe("wrong_amount");

    c.ada.set(h, { to: addrs.adaAddress, lovelace });
    const ok = await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
      signature: h,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const mine = (await j(t, "GET", "/v1/me/plan", creator.cookie)).json();
    expect(mine).toMatchObject({ activeSubscribers: 1, payments: 1, revenueUsdc: "10" });
    await t.close();
  });
});
