import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fanOut } from "../../workers/src/social/notify.js";
import { dispatchOutbox, type Log } from "../src/dispatch.js";
import { XClient } from "../src/x.js";
import { fakeTelegram, testPool, URLS } from "./helpers.js";

let pool: pg.Pool;
const users: string[] = [];
const log: Log = { info() {}, warn() {} };

beforeAll(() => {
  pool = testPool();
});
async function cleanup() {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users.splice(0)]);
}
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function trader() {
  const r = await pool.query(
    "INSERT INTO users (chain, address, handle) VALUES ('solana', $1, $2) RETURNING id",
    [`d-${crypto.randomUUID()}`, `dsp${Math.floor(Math.random() * 1e9)}`],
  );
  users.push(r.rows[0].id);
  return r.rows[0].id as string;
}
async function call(
  userId: string,
  over: { status?: string; entryTs?: number; exit?: boolean } = {},
) {
  const code = `D${Math.random().toString(36).slice(2, 9)}`;
  const r = await pool.query(
    `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms, tp_price, sl_price, exit_price, exit_ts_ms, exit_reason)
     VALUES ($1,$2,'BTC-USD','long',10,1,$3,50,$4,80000,1,$5,84000,78000,$6,$7,$8) RETURNING id`,
    [
      code,
      userId,
      Date.now() + 3_600_000,
      over.status ?? "open",
      over.entryTs ?? Date.now(),
      over.exit ? 84000 : null,
      over.exit ? Date.now() : null,
      over.exit ? "tp" : null,
    ],
  );
  return { id: r.rows[0].id as string, code };
}
async function channel(userId: string, kind: "telegram" | "x", target: string, ageMs = 3_600_000) {
  const r = await pool.query(
    "INSERT INTO post_channels (user_id, kind, target, title, created_at) VALUES ($1,$2,$3,'Alpha Room', now() - ($4 || ' milliseconds')::interval) RETURNING id",
    [userId, kind, target, ageMs],
  );
  return r.rows[0].id as string;
}
const queue = (callId: string, channelId: string, event: "opened" | "closed" = "opened") =>
  pool.query("INSERT INTO outbox (call_id, channel_id, event, created_ms) VALUES ($1,$2,$3,$4)", [
    callId,
    channelId,
    event,
    Date.now(),
  ]);
const row = async (callId: string, ev = "opened") =>
  (
    await pool.query(
      "SELECT status, attempts, error, external_id FROM outbox WHERE call_id = $1 AND event = $2",
      [callId, ev],
    )
  ).rows[0];
/** Only this test's rows: the shared test database may hold others' pending posts. */
const sendOnly = (sent: ReturnType<typeof fakeTelegram>, target: string) =>
  sent.messages().filter((m) => String(m.body.chat_id) === target);

describe("posting calls to Telegram", () => {
  it("sends one message per queued post, with a follow button, and never twice", async () => {
    const u = await trader();
    const c = await call(u);
    const ch = await channel(u, "telegram", "-1001");
    await queue(c.id, ch);
    const t = fakeTelegram();
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    const mine = sendOnly(t, "-1001");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.body).toMatchObject({
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Follow on TapeVerify", url: `https://tape.example/call/${c.code}` }],
        ],
      },
      link_preview_options: { url: `https://share.tape.example/c/${c.code}` },
    });
    expect(mine[0]?.body.text).toContain("LONG BTC-USD 10x by ");
    expect(await row(c.id)).toMatchObject({ status: "sent", attempts: 1 });
    expect((await row(c.id)).external_id).toMatch(/^\d+$/);

    const again = fakeTelegram();
    await dispatchOutbox(pool, { telegram: again.api, x: null }, URLS, log);
    expect(sendOnly(again, "-1001")).toHaveLength(0);
  });

  it("posts the result when the call closes", async () => {
    const u = await trader();
    const c = await call(u, { status: "closed", exit: true });
    const ch = await channel(u, "telegram", "-1002");
    await queue(c.id, ch, "closed");
    const t = fakeTelegram();
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    const m = sendOnly(t, "-1002")[0]?.body;
    expect(m?.text).toContain("Closed +50.00% (take-profit)");
    expect(m?.reply_markup.inline_keyboard[0][0].text).toBe("See the result");
  });

  it("gives up on a group that removed the bot, switching the channel off", async () => {
    const u = await trader();
    const c = await call(u);
    const ch = await channel(u, "telegram", "-1003");
    await queue(c.id, ch);
    const t = fakeTelegram((m, b) =>
      m === "sendMessage" && String(b.chat_id) === "-1003"
        ? {
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was kicked from the supergroup chat",
          }
        : undefined,
    );
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    expect(await row(c.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect((await row(c.id)).error).toMatch(/kicked/);
    expect(
      (await pool.query("SELECT active FROM post_channels WHERE id = $1", [ch])).rows[0].active,
    ).toBe(false);
  });

  it("retries a temporary failure a few times, then fails it", async () => {
    const u = await trader();
    const c = await call(u);
    const ch = await channel(u, "telegram", "-1004");
    await queue(c.id, ch);
    const t = fakeTelegram((m, b) =>
      m === "sendMessage" && String(b.chat_id) === "-1004"
        ? { ok: false, error_code: 429, description: "Too Many Requests" }
        : undefined,
    );
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    expect(await row(c.id)).toMatchObject({ status: "pending", attempts: 1 });
    for (let i = 0; i < 4; i++) await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    expect(await row(c.id)).toMatchObject({ status: "failed", attempts: 5 });
    expect(
      (await pool.query("SELECT active FROM post_channels WHERE id = $1", [ch])).rows[0].active,
    ).toBe(true);
  });

  it("leaves posts pending when its sender isn't configured here", async () => {
    const u = await trader();
    const c = await call(u);
    await queue(c.id, await channel(u, "telegram", "-1005"));
    await dispatchOutbox(pool, { telegram: null, x: null }, URLS, log);
    expect(await row(c.id)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("escapes anything that could be markup", async () => {
    const u = await trader();
    await pool.query("UPDATE users SET handle = $2 WHERE id = $1", [u, "evil"]);
    await pool.query("UPDATE users SET address = $2 WHERE id = $1", [u, "<b>x</b>&"]);
    await pool.query("UPDATE users SET handle = NULL WHERE id = $1", [u]);
    const c = await call(u);
    await queue(c.id, await channel(u, "telegram", "-1006"));
    const t = fakeTelegram();
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    const text = sendOnly(t, "-1006")[0]?.body.text as string;
    expect(text).not.toContain("<b>x</b>");
  });
});

describe("posting calls to X", () => {
  function fakeX(status = 201, body: unknown = { data: { id: "1900" } }) {
    const calls: Array<{ url: string; auth: string; body: any }> = [];
    const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, auth: init.headers.authorization as string, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { client: new XClient("xtoken", f), calls };
  }

  it("posts text that ends with the share link, so X builds the preview card from the page", async () => {
    const u = await trader();
    const c = await call(u);
    await queue(c.id, await channel(u, "x", "tape"));
    const x = fakeX();
    await dispatchOutbox(pool, { telegram: null, x: x.client }, URLS, log);
    const mine = x.calls.filter((k) => k.body.text.endsWith(`/c/${c.code}`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ url: "https://api.x.com/2/tweets", auth: "Bearer xtoken" });
    expect(mine[0]?.body.text).toContain(`https://share.tape.example/c/${c.code}`);
    expect(await row(c.id)).toMatchObject({ status: "sent", external_id: "1900" });
  });

  it("fails a post X refuses for good (duplicate or forbidden) instead of retrying forever", async () => {
    const u = await trader();
    const c = await call(u);
    await queue(c.id, await channel(u, "x", "tape"));
    const x = fakeX(403, {
      title: "Forbidden",
      detail: "You are not permitted to create a duplicate Tweet.",
    });
    await dispatchOutbox(pool, { telegram: null, x: x.client }, URLS, log);
    expect(await row(c.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect((await row(c.id)).error).toMatch(/duplicate/);
  });
});

describe("a call posted from TapeVerify appears in a Telegram group and can be followed from there", () => {
  it("opens, is queued once, is posted to the group with a follow link, and its result is posted after it closes", async () => {
    const u = await trader();
    const ch = await channel(u, "telegram", "-2001", 60_000); // the group was registered a minute ago
    const c = await call(u, { entryTs: Date.now() }); // the call then opened and filled
    const urls = { web: URLS.web };

    const first = await fanOut(pool, urls, undefined, Date.now());
    expect(first.posts).toBeGreaterThanOrEqual(1);
    expect(
      (await pool.query("SELECT event, status FROM outbox WHERE call_id = $1", [c.id])).rows,
    ).toEqual([{ event: "opened", status: "pending" }]);
    await fanOut(pool, urls, undefined, Date.now()); // repeating changes nothing
    expect(
      (await pool.query("SELECT count(*) AS n FROM outbox WHERE call_id = $1", [c.id])).rows[0].n,
    ).toBe("1");

    const t = fakeTelegram();
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    const posted = sendOnly(t, "-2001");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body.reply_markup.inline_keyboard[0][0].url).toBe(
      `https://tape.example/call/${c.code}`,
    );

    // The call closes: its result is posted to the same group, because the opening was.
    await pool.query(
      "UPDATE calls SET status = 'closed', exit_price = 84000, exit_ts_ms = $2, exit_reason = 'tp' WHERE id = $1",
      [c.id, Date.now()],
    );
    await fanOut(pool, urls, undefined, Date.now());
    await dispatchOutbox(pool, { telegram: t.api, x: null }, URLS, log);
    const all = sendOnly(t, "-2001");
    expect(all).toHaveLength(2);
    expect(all[1]?.body.text).toContain("Closed +50.00%");
    expect(ch).toBeTruthy();
  });

  it("doesn't post calls that opened before the group was registered, or to a group that was switched off", async () => {
    const u = await trader();
    const old = await call(u, { status: "closed", exit: true, entryTs: Date.now() - 600_000 });
    await channel(u, "telegram", "-2002", 60_000);
    const off = await channel(u, "telegram", "-2003", 60_000);
    await pool.query("UPDATE post_channels SET active = false WHERE id = $1", [off]);
    const fresh = await call(u, { entryTs: Date.now() });
    await fanOut(pool, { web: URLS.web }, undefined, Date.now());
    const rows = (
      await pool.query("SELECT call_id, channel_id FROM outbox WHERE call_id = ANY($1)", [
        [old.id, fresh.id],
      ])
    ).rows;
    expect(rows.map((r) => r.call_id)).toEqual([fresh.id]);
    expect(rows.every((r) => r.channel_id !== off)).toBe(true);
  });

  it("never posts a result for a call whose opening was never posted", async () => {
    const u = await trader();
    await channel(u, "telegram", "-2004", 3_600_000);
    const c = await call(u, { status: "closed", exit: true, entryTs: Date.now() - 1000 });
    await pool.query("UPDATE outbox SET status = 'failed' WHERE call_id = $1", [c.id]);
    await fanOut(pool, { web: URLS.web }, undefined, Date.now());
    const evs = (await pool.query("SELECT event FROM outbox WHERE call_id = $1", [c.id])).rows.map(
      (r) => r.event,
    );
    expect(evs).not.toContain("closed");
  });
});
