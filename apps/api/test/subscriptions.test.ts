import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // the devnet default
const rich = {
  "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
};
const sig = () => solAddress() + solAddress(); // 88 base58 characters: the shape of a signature

/** A Solana RPC where each signature maps to the transaction it should return. */
function chain() {
  const txs = new Map<string, unknown>();
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: txs.get(params[0]) ?? null }),
    );
  }) as unknown as typeof fetch;
  const pay = (
    signature: string,
    o: { recipient: string; memo: string; amountBase: bigint; mint?: string; blockTime?: number },
  ) =>
    txs.set(signature, {
      slot: 321,
      blockTime: o.blockTime ?? Math.floor(Date.now() / 1000),
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: o.mint ?? MINT,
            owner: o.recipient,
            uiTokenAmount: { amount: "0" },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: o.mint ?? MINT,
            owner: o.recipient,
            uiTokenAmount: { amount: String(o.amountBase) },
          },
        ],
      },
      transaction: { message: { instructions: [{ program: "spl-memo", parsed: o.memo }] } },
    });
  return { fetchImpl, pay, txs };
}

async function world() {
  const c = chain();
  const t = await makeApp(
    { ...rich, "GET /v2/markets": () => ({ body: marketsBody("80000") }) },
    false,
    null,
    {},
    { fetchImpl: c.fetchImpl },
  );
  const creator = await signIn(t, "solana", solAddress());
  const handle = `cr${Math.random().toString(36).slice(2, 9)}`;
  await t.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [creator.user.id, handle]);
  const payAddress = solAddress();
  return { t, c, creator, handle, payAddress };
}
const j = (
  t: TestApp,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  cookie?: string,
  payload?: unknown,
) => t.app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
const openPlan = (
  t: TestApp,
  cookie: string,
  payAddress: string,
  over: Record<string, unknown> = {},
) =>
  j(t, "PUT", "/v1/me/plan", cookie, {
    priceUsdc: 10,
    periodDays: 30,
    payAddress,
    active: true,
    ...over,
  });

describe("a creator's plan", () => {
  it("is saved, shown publicly without the payout address, and can be switched off", async () => {
    const { t, creator, handle, payAddress } = await world();
    expect((await j(t, "GET", `/v1/creators/${handle}/plan`)).json().plan).toBeNull();
    expect((await openPlan(t, creator.cookie, payAddress)).statusCode).toBe(200);
    const pub = (await j(t, "GET", `/v1/creators/${handle}/plan`)).json();
    expect(pub.plan).toEqual({ priceUsdc: "10", periodDays: 30, chains: ["solana"] });
    expect(JSON.stringify(pub)).not.toContain(payAddress);
    const mine = (await j(t, "GET", "/v1/me/plan", creator.cookie)).json();
    expect(mine.plan).toMatchObject({ priceUsdc: "10", periodDays: 30, payAddress, active: true });
    await openPlan(t, creator.cookie, payAddress, { active: false });
    expect((await j(t, "GET", `/v1/creators/${handle}/plan`)).json().plan).toBeNull();
    await t.close();
  });

  it("rejects a bad price, period or address", async () => {
    const { t, creator, payAddress } = await world();
    for (const bad of [
      { priceUsdc: 0.5 },
      { priceUsdc: 10.123 },
      { priceUsdc: 1_000_000 },
      { periodDays: 0 },
      { periodDays: 1000 },
      { payAddress: "short" },
    ]) {
      expect(
        (await openPlan(t, creator.cookie, payAddress, bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    }
    const notAddr = await openPlan(t, creator.cookie, "0x9d4ef81f5225107049ba08f69f598d97b31ea644");
    expect(notAddr.statusCode).toBe(400);
    expect(
      (
        await j(t, "PUT", "/v1/me/plan", undefined, {
          priceUsdc: 5,
          periodDays: 7,
          payAddress,
          active: true,
        })
      ).statusCode,
    ).toBe(401);
    await t.close();
  });
});

describe("subscribing and paying on-chain", () => {
  it("gives payment instructions, activates the subscription once the chain shows the payment, and tells the creator", async () => {
    const { t, c, creator, handle, payAddress } = await world();
    await openPlan(t, creator.cookie, payAddress, { priceUsdc: 12.5, periodDays: 30 });
    const fan = await signIn(t, "solana", solAddress());

    const intent = await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {});
    expect(intent.statusCode, intent.body).toBe(201);
    const i = intent.json();
    expect(i.pay).toMatchObject({
      address: payAddress,
      amountUsdc: "12.5",
      mint: MINT,
      chain: "solana",
    });
    expect(i.pay.memo).toMatch(/^TV-[A-HJ-NP-Z2-9]{8}$/);
    expect(
      (await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {})).json().paymentId,
    ).toBe(i.paymentId); // same open payment

    const s = sig();
    // before it shows up on-chain
    const early = await j(
      t,
      "POST",
      `/v1/subscriptions/payments/${i.paymentId}/confirm`,
      fan.cookie,
      { signature: s },
    );
    expect(early.statusCode).toBe(422);
    expect(early.json().code).toBe("not_found");

    c.pay(s, { recipient: payAddress, memo: i.pay.memo, amountBase: 12_500_000n });
    const before = Date.now();
    const ok = await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
      signature: s,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().endsAt).toBeGreaterThanOrEqual(before + 30 * DAY);

    // confirming again is harmless
    const again = await j(
      t,
      "POST",
      `/v1/subscriptions/payments/${i.paymentId}/confirm`,
      fan.cookie,
      { signature: s },
    );
    expect(again.json()).toMatchObject({ ok: true, alreadyConfirmed: true });

    const view = (await j(t, "GET", `/v1/creators/${handle}/plan`, fan.cookie)).json();
    expect(view).toMatchObject({ subscribers: 1, viewer: { subscribed: true } });
    const mine = (await j(t, "GET", "/v1/me/plan", creator.cookie)).json();
    expect(mine).toMatchObject({ activeSubscribers: 1, revenueUsdc: "12.5", payments: 1 });
    expect(mine.recent[0].signature).toBe(s);
    const notes = (await j(t, "GET", "/v1/notifications", creator.cookie)).json().notifications;
    expect(notes.some((n: { title: string }) => n.title === "New subscriber")).toBe(true);
    expect(
      (await j(t, "GET", "/v1/me/subscriptions", fan.cookie)).json().subscriptions[0],
    ).toMatchObject({ ref: handle, active: true });
    await t.close();
  });

  it("refuses payments that don't match: too little, wrong token, wrong recipient, no reference, someone else's intent", async () => {
    const { t, c, creator, handle, payAddress } = await world();
    await openPlan(t, creator.cookie, payAddress, { priceUsdc: 10 });
    const fan = await signIn(t, "solana", solAddress());
    const other = await signIn(t, "solana", solAddress());
    const i = (await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {})).json();
    const attempt = async (tx: Parameters<typeof c.pay>[1], who = fan.cookie) => {
      const s = sig();
      c.pay(s, tx);
      return j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, who, {
        signature: s,
      });
    };
    const base = { recipient: payAddress, memo: i.pay.memo, amountBase: 10_000_000n };
    expect((await attempt({ ...base, amountBase: 9_999_999n })).json().code).toBe("wrong_amount");
    expect((await attempt({ ...base, mint: "SomeOtherToken" })).json().code).toBe(
      "wrong_recipient",
    );
    expect((await attempt({ ...base, recipient: solAddress() })).json().code).toBe(
      "wrong_recipient",
    );
    expect((await attempt({ ...base, memo: "TV-WRONGONE" })).json().code).toBe("missing_memo");
    expect((await attempt({ ...base, blockTime: 1_000_000 })).json().code).toBe("too_old");
    expect((await attempt(base, other.cookie)).statusCode).toBe(404); // not their payment
    expect(
      (
        await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
          signature: "nope",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await j(t, "GET", `/v1/creators/${handle}/plan`, fan.cookie)).json().viewer.subscribed,
    ).toBe(false);
    await t.close();
  });

  it("extends from the current end when renewing early, so no paid days are lost", async () => {
    const { t, c, creator, handle, payAddress } = await world();
    await openPlan(t, creator.cookie, payAddress, { priceUsdc: 5, periodDays: 7 });
    const fan = await signIn(t, "solana", solAddress());
    const pay = async () => {
      const i = (await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {})).json();
      const s = sig();
      c.pay(s, { recipient: payAddress, memo: i.pay.memo, amountBase: 5_000_000n });
      return (
        await j(t, "POST", `/v1/subscriptions/payments/${i.paymentId}/confirm`, fan.cookie, {
          signature: s,
        })
      ).json().endsAt as number;
    };
    const first = await pay();
    const second = await pay();
    expect(second - first).toBe(7 * DAY);
    await t.close();
  });

  it("won't let you subscribe to yourself, to someone with no plan, or when signed out; and surfaces a chain outage", async () => {
    const { t, creator, handle, payAddress } = await world();
    expect(
      (await j(t, "POST", `/v1/creators/${handle}/subscribe`, creator.cookie, {})).statusCode,
    ).toBe(409);
    const fan = await signIn(t, "solana", solAddress());
    expect(
      (await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {})).json().code,
    ).toBe("no_plan");
    expect((await j(t, "POST", `/v1/creators/${handle}/subscribe`, undefined, {})).statusCode).toBe(
      401,
    );
    expect(
      (await j(t, "POST", "/v1/creators/nobody-here/subscribe", fan.cookie, {})).statusCode,
    ).toBe(404);
    await openPlan(t, creator.cookie, payAddress);
    const i = (await j(t, "POST", `/v1/creators/${handle}/subscribe`, fan.cookie, {})).json();
    const down = await makeApp(
      {},
      false,
      null,
      {},
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ error: { message: "node is behind" } }),
          )) as unknown as typeof fetch,
      },
    );
    // the same payment row, but through an app whose RPC is down
    const s2 = await signIn(down, "solana", solAddress());
    const i2 = await down.pool.query(
      "INSERT INTO subscription_payments (creator_id, subscriber_id, amount_usdc, period_days, pay_address, mint, reference, created_ms, expires_ms) VALUES ($1,$2,5,7,$3,$4,$5,$6,$7) RETURNING id",
      [
        creator.user.id,
        s2.user.id,
        payAddress,
        MINT,
        `TV-${randomUUID().slice(0, 8)}`,
        Date.now(),
        Date.now() + HOUR,
      ],
    );
    const r = await j(
      down,
      "POST",
      `/v1/subscriptions/payments/${i2.rows[0].id}/confirm`,
      s2.cookie,
      { signature: sig() },
    );
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe("chain_unreachable");
    expect(i.paymentId).toBeTruthy();
    await down.close();
    await t.close();
  });
});

describe("premium calls stay locked to subscribers", () => {
  async function premiumWorld(delayMinutes = 0) {
    const w = await world();
    await openPlan(w.t, w.creator.cookie, w.payAddress, { priceUsdc: 5, periodDays: 30 });
    const created = await j(w.t, "POST", "/v1/calls", w.creator.cookie, {
      symbol: "BTC-USD",
      side: "long",
      size: "0.002",
      leverage: 10,
      tpPrice: "84000",
      slPrice: "78000",
      premium: true,
      publicDelayMinutes: delayMinutes,
    });
    expect(created.statusCode, created.body).toBe(201);
    const call = created.json().call;
    await w.t.pool.query(
      "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = $3, entry_trade_id = 1, expires_at = $2 WHERE id = $1",
      [call.id, Date.now() + HOUR, Date.now() - 1000],
    );
    const sub = await signIn(w.t, "solana", solAddress());
    const stranger = await signIn(w.t, "solana", solAddress());
    await w.t.pool.query(
      "INSERT INTO subscriptions (creator_id, subscriber_id, started_ms, ends_ms) VALUES ($1,$2,$3,$4)",
      [w.creator.user.id, sub.user.id, Date.now() - DAY, Date.now() + DAY],
    );
    return { ...w, call, sub, stranger };
  }

  it("needs a plan to post one", async () => {
    const w = await world();
    const r = await j(w.t, "POST", "/v1/calls", w.creator.cookie, {
      symbol: "BTC-USD",
      side: "long",
      size: "0.002",
      leverage: 10,
      premium: true,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("no_plan");
    await w.t.close();
  });

  it("shows the public a teaser with nothing about the trade, and subscribers and the creator everything", async () => {
    const { t, call, creator, sub, stranger } = await premiumWorld();
    for (const cookie of [undefined, stranger.cookie]) {
      const r = (await j(t, "GET", `/v1/calls/${call.code}`, cookie)).json();
      expect(r.locked).toBe(true);
      expect(r.call).toMatchObject({
        code: call.code,
        symbol: "BTC-USD",
        premium: true,
        locked: true,
      });
      expect(r.plan).toEqual({ priceUsdc: "5", periodDays: 30 });
      const text = JSON.stringify(r);
      for (const secret of ["80000", "84000", "78000", '"side"', "leverage", "0.002"])
        expect(text, secret).not.toContain(secret);
    }
    for (const cookie of [sub.cookie, creator.cookie]) {
      const r = (await j(t, "GET", `/v1/calls/${call.code}`, cookie)).json();
      expect(r.locked).toBeUndefined();
      expect(r.call).toMatchObject({ side: "long", leverage: 10, premium: true });
      expect(r.call.entry.price).toBe("80000");
    }
    await t.close();
  });

  it("opens to everyone once it closes, because a closed call is part of the record", async () => {
    const { t, call, stranger } = await premiumWorld();
    await t.pool.query(
      "UPDATE calls SET status = 'closed', exit_price = 84000, exit_ts_ms = $2, exit_reason = 'tp' WHERE id = $1",
      [call.id, Date.now()],
    );
    const r = (await j(t, "GET", `/v1/calls/${call.code}`, stranger.cookie)).json();
    expect(r.locked).toBeUndefined();
    expect(r.call.exit.price).toBe("84000");
    await t.close();
  });

  it("can become public after a delay", async () => {
    const { t, call, stranger } = await premiumWorld(30);
    expect((await j(t, "GET", `/v1/calls/${call.code}`, stranger.cookie)).json().locked).toBe(true);
    await t.pool.query("UPDATE calls SET public_at_ms = $2 WHERE id = $1", [
      call.id,
      Date.now() - 1000,
    ]);
    expect(
      (await j(t, "GET", `/v1/calls/${call.code}`, stranger.cookie)).json().locked,
    ).toBeUndefined();
    await t.close();
  });

  it("can't be followed, previewed or copied without a subscription", async () => {
    const { t, call, sub, stranger } = await premiumWorld();
    const f = await j(t, "POST", `/v1/calls/${call.code}/follow`, stranger.cookie, {
      marginUsd: "50",
    });
    expect(f.statusCode).toBe(403);
    expect(f.json()).toMatchObject({ code: "subscription_required", plan: { priceUsdc: "5" } });
    expect(
      (
        await j(t, "POST", `/v1/calls/${call.code}/follow/preview`, stranger.cookie, {
          marginUsd: "50",
        })
      ).statusCode,
    ).toBe(403);
    const ok = await j(t, "POST", `/v1/calls/${call.code}/follow`, sub.cookie, { marginUsd: "50" });
    expect(ok.statusCode, ok.body).toBe(201);
    // when the subscription ends, so does access
    await t.pool.query("UPDATE subscriptions SET ends_ms = $1 WHERE subscriber_id = $2", [
      Date.now() - 1,
      sub.user.id,
    ]);
    expect((await j(t, "GET", `/v1/calls/${call.code}`, sub.cookie)).json().locked).toBe(true);
    await t.close();
  });

  it("is hidden on the profile, the feed and the share link and card, but not from subscribers", async () => {
    const { t, call, handle, sub, stranger } = await premiumWorld();
    const creatorId = (await t.pool.query("SELECT id FROM users WHERE handle = $1", [handle]))
      .rows[0].id;
    await t.pool.query("UPDATE users SET strike_account_id = $2 WHERE id = $1", [
      creatorId,
      `sub-acct-${randomUUID()}`,
    ]);
    const prof = (await j(t, "GET", `/v1/traders/${handle}`, stranger.cookie)).json();
    expect(prof.calls[0]).toMatchObject({ code: call.code, locked: true, symbol: "BTC-USD" });
    expect(JSON.stringify(prof.calls)).not.toContain("80000");
    expect(JSON.stringify(prof.calls)).not.toContain("long");
    const withSub = (await j(t, "GET", `/v1/traders/${handle}`, sub.cookie)).json();
    expect(withSub.calls[0]).toMatchObject({ code: call.code, locked: false, side: "long" });

    const feed = (await j(t, "GET", "/v1/feed?scope=all&limit=50", stranger.cookie))
      .json()
      .events.find((e: { call?: { code: string } }) => e.call?.code === call.code);
    expect(feed.call).toMatchObject({ locked: true, symbol: "BTC-USD" });
    expect(JSON.stringify(feed)).not.toContain("80000");
    const seen = (await j(t, "GET", "/v1/feed?scope=all&limit=50", sub.cookie))
      .json()
      .events.find((e: { call?: { code: string } }) => e.call?.code === call.code);
    expect(seen.call.entryPrice).toBe("80000");

    const page = await t.app.inject({
      method: "GET",
      url: `/c/${call.code}`,
      headers: { "user-agent": "TelegramBot" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Premium call from");
    for (const secret of ["80000", "84000", "LONG", "long "])
      expect(page.body, secret).not.toContain(secret);
    const img = await j(t, "GET", `/og/${call.code}.png`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    await t.close();
  });
});
