import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;
let t: TestApp;
const users: string[] = [];
const accounts: string[] = [];
let vaults: unknown[] = [];

beforeAll(async () => {
  t = await makeApp(
    {
      "GET /v2/markets": () => ({ body: marketsBody("100") }),
      "GET /v2/vaults": () => ({ body: { vaults } }),
    },
    false,
    null,
    { TELEGRAM_BOT_USERNAME: "PitTestBot" },
  );
});
afterAll(async () => {
  await t.pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
  await t.pool.query("DELETE FROM trades WHERE account_id = ANY($1)", [accounts]);
  await t.close();
});

async function person(handle?: string) {
  const s = await signIn(t, "solana", solAddress());
  users.push(s.user.id);
  if (handle) await t.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [s.user.id, handle]);
  return { ...s, id: s.user.id as string, handle: handle ?? null };
}
const get = (url: string, cookie?: string) =>
  t.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
const post = (url: string, payload: unknown, cookie?: string) =>
  t.app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: cookie ? { cookie } : {},
  });
const del = (url: string, cookie: string) =>
  t.app.inject({ method: "DELETE", url, headers: { cookie } });

async function openCall(userId: string, over: { closed?: boolean; entryTs?: number } = {}) {
  const code = `A${Math.random().toString(36).slice(2, 9)}`;
  const entryTs = over.entryTs ?? Date.now() - 5000;
  const r = await t.pool.query(
    `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms, exit_price, exit_ts_ms, exit_reason)
     VALUES ($1,$2,'BTC-USD','long',5,1,$3,50,$4,100,1,$5,$6,$7,$8) RETURNING id`,
    [
      code,
      userId,
      Date.now() + HOUR,
      over.closed ? "closed" : "open",
      entryTs,
      over.closed ? 110 : null,
      over.closed ? entryTs + 1000 : null,
      over.closed ? "tp" : null,
    ],
  );
  return { id: r.rows[0].id as string, code };
}

describe("following traders", () => {
  it("follows and unfollows, counts fans, notifies the trader once, and refuses self-follows", async () => {
    const trader = await person(`trader${Date.now() % 100000}`);
    const fan = await person(`fan${Date.now() % 100000}`);
    expect((await post(`/v1/traders/${trader.handle}/follow`, {}, fan.cookie)).json()).toEqual({
      following: true,
    });
    await post(`/v1/traders/${trader.handle}/follow`, {}, fan.cookie); // twice is fine
    const prof = (await get(`/v1/traders/${trader.handle}`, fan.cookie)).json();
    expect(prof.fans).toBe(1);
    expect(prof.viewer).toEqual({ isSelf: false, following: true });
    expect((await get(`/v1/traders/${trader.handle}`)).json().viewer).toBeNull();

    const n = (await get("/v1/notifications", trader.cookie)).json();
    expect(n.notifications.filter((x: { kind: string }) => x.kind === "new_follower")).toHaveLength(
      1,
    );
    expect(n.notifications[0].body).toContain(fan.handle);

    expect(
      (await get("/v1/me/following", fan.cookie))
        .json()
        .following.map((f: { handle: string }) => f.handle),
    ).toEqual([trader.handle]);
    expect((await post(`/v1/traders/${trader.handle}/follow`, {}, trader.cookie)).statusCode).toBe(
      409,
    );
    expect((await del(`/v1/traders/${trader.handle}/follow`, fan.cookie)).json()).toEqual({
      following: false,
    });
    expect((await get(`/v1/traders/${trader.handle}`, fan.cookie)).json().fans).toBe(0);
    expect((await post("/v1/traders/nobody-at-all/follow", {}, fan.cookie)).statusCode).toBe(404);
    expect((await post(`/v1/traders/${trader.handle}/follow`, {})).statusCode).toBe(401);
  });
});

describe("the feed", () => {
  it("shows calls opening and closing and verified trades, newest first, and 'following' only shows who you follow", async () => {
    const [a, b, me] = [
      await person(`feeda${Date.now() % 100000}`),
      await person(`feedb${Date.now() % 100000}`),
      await person(),
    ];
    await post(`/v1/traders/${a.handle}/follow`, {}, me.cookie);
    const now = Date.now();
    await openCall(a.id, { entryTs: now - 30_000 });
    await openCall(b.id, { closed: true, entryTs: now - 20_000 });
    // a verified trade for trader a
    const account = `feed-${randomUUID()}`;
    accounts.push(account);
    await t.pool.query("UPDATE users SET strike_account_id = $2 WHERE id = $1", [a.id, account]);
    await t.pool.query(
      `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
       VALUES ($1,'ETH-USD','short',$2,$3,1,100,95,100,5,0,0,5)`,
      [account, now - 100_000, now - 10_000],
    );

    const mine = (await get("/v1/feed?scope=following", me.cookie)).json();
    expect(mine.events.every((e: { trader: { name: string } }) => e.trader.name === a.handle)).toBe(
      true,
    );
    expect(mine.events.map((e: { kind: string }) => e.kind)).toEqual([
      "trade_closed",
      "call_opened",
    ]);
    expect(mine.events[0].trade).toMatchObject({ symbol: "ETH-USD", side: "short", netPnl: "5" });
    expect(mine.events[1].call).toMatchObject({
      symbol: "BTC-USD",
      side: "long",
      leverage: 5,
      entryPrice: "100",
      comments: 0,
    });

    const all = (await get("/v1/feed?scope=all&limit=50"))
      .json()
      .events.filter((e: { trader: { name: string } }) =>
        [a.handle, b.handle].includes(e.trader.name),
      );
    expect(all.map((e: { kind: string }) => e.kind)).toEqual([
      "trade_closed",
      "call_closed",
      "call_opened", // a call that closed shows once, as closed, not also as opened
    ]);
    expect(all.map((e: { at: number }) => e.at)).toEqual(
      [...all.map((e: { at: number }) => e.at)].sort((x: number, y: number) => y - x),
    );

    // paging: the cursor is the last event's time
    const p1 = (await get("/v1/feed?scope=all&limit=1")).json();
    expect(p1.events).toHaveLength(1);
    const p2 = (await get(`/v1/feed?scope=all&limit=1&before=${p1.next}`)).json();
    expect(p2.events[0].at).toBeLessThan(p1.events[0].at);
  });

  it("is empty, not an error, for 'following' when signed out, and includes trust badges", async () => {
    expect((await get("/v1/feed?scope=following")).json()).toMatchObject({
      events: [],
      next: null,
    });
    const u = await person(`badge${Date.now() % 100000}`);
    await openCall(u.id);
    await t.pool.query(
      `INSERT INTO trader_reputation (user_id, score, performance, confidence, penalty, clean, clean_reasons, penalties, trades) VALUES ($1,81,81,1,0,true,'[]','[]',12)
       ON CONFLICT (user_id) DO UPDATE SET clean = true`,
      [u.id],
    );
    const e = (await get("/v1/feed?scope=all&limit=50"))
      .json()
      .events.find((x: { trader: { name: string } }) => x.trader.name === u.handle);
    expect(e.trader.verify).toMatchObject({ clean: true, score: 81 });
  });
});

describe("comments", () => {
  it("lets signed-in people comment, notifies the caller, and lets the author or the caller remove one", async () => {
    const caller = await person(`cm${Date.now() % 100000}`);
    const reader = await person(`rd${Date.now() % 100000}`);
    const c = await openCall(caller.id);
    expect((await post(`/v1/calls/${c.code}/comments`, { body: "hi" })).statusCode).toBe(401);
    expect(
      (await post(`/v1/calls/${c.code}/comments`, { body: "   " }, reader.cookie)).statusCode,
    ).toBe(400);
    expect(
      (await post(`/v1/calls/${c.code}/comments`, { body: "x".repeat(501) }, reader.cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (await post("/v1/calls/ZZZZZZZZ/comments", { body: "hello" }, reader.cookie)).statusCode,
    ).toBe(404);

    const made = await post(
      `/v1/calls/${c.code}/comments`,
      { body: "  Nice entry <b>bold</b>  " },
      reader.cookie,
    );
    expect(made.statusCode, made.body).toBe(201);
    await post(`/v1/calls/${c.code}/comments`, { body: "I'm following this" }, caller.cookie); // the caller replies: no self-notification

    const list = (await get(`/v1/calls/${c.code}/comments`, reader.cookie)).json().comments;
    expect(list.map((x: { body: string }) => x.body)).toEqual([
      "Nice entry <b>bold</b>",
      "I'm following this",
    ]); // stored as plain text
    expect(list[0].author).toMatchObject({ name: reader.handle, isCaller: false });
    expect(list[1].author.isCaller).toBe(true);
    expect(list.map((x: { canDelete: boolean }) => x.canDelete)).toEqual([true, false]);
    expect(
      (await get(`/v1/calls/${c.code}/comments`))
        .json()
        .comments.every((x: { canDelete: boolean }) => !x.canDelete),
    ).toBe(true);

    const note = (await get("/v1/notifications", caller.cookie))
      .json()
      .notifications.filter((n: { kind: string }) => n.kind === "comment");
    expect(note).toHaveLength(1);
    expect(note[0].body).toContain("Nice entry");
    expect(note[0].url).toContain(`/call/${c.code}`);

    const stranger = await person();
    expect((await del(`/v1/comments/${list[0].id}`, stranger.cookie)).statusCode).toBe(404);
    expect((await del(`/v1/comments/${list[0].id}`, caller.cookie)).statusCode).toBe(200); // the call's owner moderates
    expect((await del(`/v1/comments/${list[1].id}`, caller.cookie)).statusCode).toBe(200);
    expect((await get(`/v1/calls/${c.code}/comments`)).json().comments).toEqual([]);
    expect((await get("/v1/calls/ZZZZZZZZ/comments")).statusCode).toBe(404);
  });
});

describe("notifications", () => {
  it("counts unread, marks some or all as read, and only shows your own", async () => {
    const [me, other] = [await person(), await person()];
    for (const [u, n] of [
      [me.id, 3],
      [other.id, 1],
    ] as const)
      for (let i = 0; i < n; i++)
        await t.pool.query(
          "INSERT INTO notifications (user_id, kind, ref, title, body) VALUES ($1,'new_call',$2,'T','B')",
          [u, `r${i}:${u}`],
        );
    const first = (await get("/v1/notifications", me.cookie)).json();
    expect(first.unread).toBe(3);
    expect(first.notifications).toHaveLength(3);
    await post("/v1/notifications/read", { ids: [first.notifications[0].id] }, me.cookie);
    expect((await get("/v1/notifications", me.cookie)).json().unread).toBe(2);
    await post(
      "/v1/notifications/read",
      { ids: [(await get("/v1/notifications", other.cookie)).json().notifications[0].id] },
      me.cookie,
    ); // someone else's: ignored
    expect((await get("/v1/notifications", other.cookie)).json().unread).toBe(1);
    await post("/v1/notifications/read", {}, me.cookie);
    expect((await get("/v1/notifications", me.cookie)).json().unread).toBe(0);
    expect((await get("/v1/notifications")).statusCode).toBe(401);
  });
});

describe("connections: Telegram and X", () => {
  it("issues a short-lived link code, replaces the old one, and lists and removes channels", async () => {
    const me = await person();
    const a = (await post("/v1/telegram/link-code", {}, me.cookie)).json();
    expect(a).toMatchObject({ bot: "PitTestBot", expiresInSeconds: 600 });
    expect(a.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(a.command).toBe(`/link ${a.code}`);
    const b = (await post("/v1/telegram/link-code", {}, me.cookie)).json();
    const rows = (
      await t.pool.query("SELECT code FROM telegram_link_codes WHERE user_id = $1", [me.id])
    ).rows;
    expect(rows).toEqual([{ code: b.code }]);

    let c = (await get("/v1/me/connections", me.cookie)).json();
    expect(c.telegram).toMatchObject({ available: true, linked: false, bot: "PitTestBot" });
    expect(c.x.available).toBe(false);
    await t.pool.query(
      "INSERT INTO telegram_links (user_id, tg_user_id, tg_username) VALUES ($1,$2,'someone')",
      [me.id, 9_000_000 + (Date.now() % 1000000)],
    );
    const ch = await t.pool.query(
      "INSERT INTO post_channels (user_id, kind, target, title) VALUES ($1,'telegram','-77','Alpha Room') RETURNING id",
      [me.id],
    );
    c = (await get("/v1/me/connections", me.cookie)).json();
    expect(c.telegram).toMatchObject({ linked: true, username: "someone" });
    expect(c.channels).toEqual([
      { id: ch.rows[0].id, kind: "telegram", title: "Alpha Room", active: true },
    ]);

    const stranger = await person();
    expect((await del(`/v1/me/channels/${ch.rows[0].id}`, stranger.cookie)).statusCode).toBe(404);
    expect((await del(`/v1/me/channels/${ch.rows[0].id}`, me.cookie)).statusCode).toBe(200);
    expect((await get("/v1/me/connections", me.cookie)).json().channels).toEqual([]);
  });

  it("says plainly when Telegram or X posting isn't set up on the server", async () => {
    const bare = await makeApp();
    const s = await signIn(bare, "solana", solAddress());
    const r1 = await bare.app.inject({
      method: "POST",
      url: "/v1/telegram/link-code",
      payload: {},
      headers: { cookie: s.cookie },
    });
    expect(r1.statusCode).toBe(503);
    expect(r1.json().code).toBe("not_configured");
    const r2 = await bare.app.inject({
      method: "POST",
      url: "/v1/me/channels/x",
      payload: {},
      headers: { cookie: s.cookie },
    });
    expect(r2.statusCode).toBe(503);
    await bare.pool.query("DELETE FROM users WHERE id = $1", [s.user.id]);
    await bare.close();
  });

  it("turns on posting to X when the server has it", async () => {
    const x = await makeApp({}, false, null, { X_POSTING: "true" });
    const s = await signIn(x, "solana", solAddress());
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/me/channels/x",
          payload: {},
          headers: { cookie: s.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const c = (
      await x.app.inject({
        method: "GET",
        url: "/v1/me/connections",
        headers: { cookie: s.cookie },
      })
    ).json();
    expect(c.x.available).toBe(true);
    expect(c.channels).toMatchObject([{ kind: "x", active: true }]);
    await x.pool.query("DELETE FROM users WHERE id = $1", [s.user.id]);
    await x.close();
  });
});

describe("vault graduation", () => {
  async function trader(over: {
    trades: number;
    days: number;
    net: number;
    clean: boolean;
    score: number;
  }) {
    const p = await person();
    const account = `vault-${randomUUID()}`;
    accounts.push(account);
    await t.pool.query("UPDATE users SET strike_account_id = $2 WHERE id = $1", [p.id, account]);
    await t.pool.query(
      "INSERT INTO account_transactions (account_id, id, type, amount, status, ts_ms, raw) VALUES ($1,'d1','deposit',1000,'completed',$2,'{}')",
      [account, Date.now() - 100 * 86_400_000],
    );
    for (let i = 0; i < over.trades; i++) {
      const closed = Date.now() - (i % over.days) * 86_400_000 - i * 1000;
      await t.pool.query(
        `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
         VALUES ($1,'BTC-USD','long',$2,$3,1,100,101,100,1,0,0,$4)`,
        [account, closed - 60_000, closed, over.net],
      );
    }
    await t.pool.query(
      `INSERT INTO trader_reputation (user_id, score, performance, confidence, penalty, clean, clean_reasons, penalties, trades) VALUES ($1,$2,$2,1,0,$3,'[]','[]',$4)`,
      [p.id, over.score, over.clean, over.trades],
    );
    return p;
  }

  it("lists each requirement with the trader's own numbers, and refuses a hand-off until they're all met", async () => {
    vaults = [];
    const weak = await trader({ trades: 5, days: 2, net: 1, clean: false, score: 40 });
    const v = (await get("/v1/me/vault", weak.cookie)).json();
    expect(v.eligible).toBe(false);
    expect(v.criteria.map((c: { key: string; met: boolean }) => [c.key, c.met])).toEqual([
      ["trades", false],
      ["days", false],
      ["return", true],
      ["drawdown", true],
      ["clean", false],
      ["reputation", false],
    ]);
    expect(v.criteria[0]).toMatchObject({ have: "5", need: "at least 30" });
    expect(v.vault).toBeNull();
    expect(v.steps.length).toBeGreaterThan(2);
    expect((await post("/v1/me/vault/handoff", {}, weak.cookie)).json().code).toBe("not_eligible");
  });

  it("passes a trader who meets everything, records the hand-off, and shows their vault once Strike lists it", async () => {
    const strong = await trader({ trades: 40, days: 20, net: 2, clean: true, score: 75 });
    const v = (await get("/v1/me/vault", strong.cookie)).json();
    expect(v.eligible, JSON.stringify(v.criteria)).toBe(true);
    expect((await post("/v1/me/vault/handoff", {}, strong.cookie)).statusCode).toBe(200);
    expect((await get("/v1/me/vault", strong.cookie)).json().handedOffAt).toBeGreaterThan(0);
    expect((await get("/v1/me/vault", strong.cookie)).json().vault).toBeNull();

    vaults = [
      {
        vault_id: "v-1",
        type: "user",
        name: "Alice Alpha",
        status: "active",
        equity: "1200",
        share_price: "1.04",
        depositors: 3,
        all_time_pnl: "40",
        leader_commission_bps: 1000,
      },
    ];
    const after = (await get("/v1/me/vault", strong.cookie)).json();
    expect(after.vault).toMatchObject({
      id: "v-1",
      name: "Alice Alpha",
      equity: "1200",
      depositors: 3,
      leaderCommissionBps: 1000,
    });
    expect(after.lookupFailed).toBe(false);
    vaults = [];
  });

  it("copes with a person who has no Strike account yet", async () => {
    const p = await person();
    const v = (await get("/v1/me/vault", p.cookie)).json();
    expect(v.eligible).toBe(false);
    expect(v.vault).toBeNull();
  });
});

describe("moving a Telegram account between wallets", () => {
  it("unlinks, and the same Telegram account can then be linked to another account", async () => {
    const [a, b] = [await person(), await person()];
    const tg = 8_000_000 + (Date.now() % 1_000_000);
    await t.pool.query(
      "INSERT INTO telegram_links (user_id, tg_user_id, tg_username) VALUES ($1,$2,'me')",
      [a.id, tg],
    );
    await t.pool.query(
      "INSERT INTO post_channels (user_id, kind, target, title) VALUES ($1,'telegram','-99','Room')",
      [a.id],
    );
    expect((await get("/v1/me/connections", a.cookie)).json().telegram.linked).toBe(true);
    expect((await del("/v1/me/telegram", a.cookie)).statusCode).toBe(200);
    expect((await get("/v1/me/connections", a.cookie)).json().telegram.linked).toBe(false);
    // the group a registered is still hers
    expect((await get("/v1/me/connections", a.cookie)).json().channels).toHaveLength(1);
    // the Telegram account is free for the other wallet
    await t.pool.query("INSERT INTO telegram_links (user_id, tg_user_id) VALUES ($1,$2)", [
      b.id,
      tg,
    ]);
    expect((await get("/v1/me/connections", b.cookie)).json().telegram.linked).toBe(true);
    expect((await t.app.inject({ method: "DELETE", url: "/v1/me/telegram" })).statusCode).toBe(401);
  });
});
