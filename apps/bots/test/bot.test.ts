import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleUpdate, parseCommand } from "../src/bot.js";
import type { TgUpdate } from "../src/telegram.js";
import { fakeTelegram, testPool, URLS } from "./helpers.js";

let pool: pg.Pool;
const users: string[] = [];
let nextTg = 7_000_000 + (Date.now() % 1_000_000);

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

async function user() {
  const r = await pool.query(
    "INSERT INTO users (chain, address, handle) VALUES ('solana', $1, $2) RETURNING id",
    [`bot-${crypto.randomUUID()}`, `bot${Math.floor(Math.random() * 1e9)}`],
  );
  users.push(r.rows[0].id);
  return r.rows[0].id as string;
}
const msg = (
  from: number,
  chat: { id: number; type: "private" | "group" | "supergroup"; title?: string },
  text: string,
): TgUpdate => ({
  update_id: 1,
  message: { message_id: 1, from: { id: from, username: `tg${from}` }, chat, text },
});
const dm = (from: number, text: string) => msg(from, { id: from, type: "private" }, text);
const group = (from: number, text: string, id = -1_000_000_000 - (nextTg % 1000)) =>
  msg(from, { id, type: "supergroup", title: "Alpha Room" }, text);

async function code(userId: string, expiresMs = Date.now() + 600_000) {
  const c = `T${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  await pool.query(
    "INSERT INTO telegram_link_codes (code, user_id, expires_ms) VALUES ($1,$2,$3)",
    [c, userId, expiresMs],
  );
  return c;
}

describe("parsing commands", () => {
  it("handles bot-name suffixes, arguments and non-commands", () => {
    expect(parseCommand("/tape")).toEqual({ cmd: "tape", arg: "" });
    expect(parseCommand("/tape@TapeVerifyBot")).toEqual({ cmd: "tape", arg: "" });
    expect(parseCommand("/LINK  ABC123 ")).toEqual({ cmd: "link", arg: "ABC123" });
    expect(parseCommand("hello /tape")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe("linking a Telegram account", () => {
  it("links with a valid one-time code, and the code can't be used twice", async () => {
    const u = await user();
    const tg = ++nextTg;
    const c = await code(u);
    const t = fakeTelegram();
    await handleUpdate(pool, t.api, URLS, dm(tg, `/link ${c.toLowerCase()}`));
    expect(t.messages()[0]?.body.text).toMatch(/Linked/);
    expect(
      (await pool.query("SELECT tg_user_id FROM telegram_links WHERE user_id = $1", [u])).rows[0]
        .tg_user_id,
    ).toBe(String(tg));

    const other = fakeTelegram();
    await handleUpdate(pool, other.api, URLS, dm(++nextTg, `/link ${c}`));
    expect(other.messages()[0]?.body.text).toMatch(/wrong or has expired/);
  });

  it("refuses an expired code, a wrong code and linking from a group", async () => {
    const u = await user();
    const t = fakeTelegram();
    await handleUpdate(
      pool,
      t.api,
      URLS,
      dm(++nextTg, `/link ${await code(u, Date.now() - 1000)}`),
    );
    await handleUpdate(pool, t.api, URLS, dm(++nextTg, "/link NOPE1234"));
    await handleUpdate(pool, t.api, URLS, group(++nextTg, `/link ${await code(u)}`));
    const texts = t.messages().map((m) => m.body.text as string);
    expect(texts[0]).toMatch(/wrong or has expired/);
    expect(texts[1]).toMatch(/wrong or has expired/);
    expect(texts[2]).toMatch(/private chat/);
    expect(
      (await pool.query("SELECT 1 FROM telegram_links WHERE user_id = $1", [u])).rowCount,
    ).toBe(0);
  });

  it("won't link one Telegram account to two TapeVerify accounts", async () => {
    const [a, b] = [await user(), await user()];
    const tg = ++nextTg;
    await handleUpdate(pool, fakeTelegram().api, URLS, dm(tg, `/link ${await code(a)}`));
    const t = fakeTelegram();
    await handleUpdate(pool, t.api, URLS, dm(tg, `/link ${await code(b)}`));
    expect(t.messages()[0]?.body.text).toMatch(/already linked/);
  });

  it("ignores messages from bots and anything that isn't a command", async () => {
    const t = fakeTelegram();
    await handleUpdate(pool, t.api, URLS, {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 1, is_bot: true },
        chat: { id: 1, type: "private" },
        text: "/start",
      },
    });
    await handleUpdate(pool, t.api, URLS, dm(++nextTg, "just chatting"));
    expect(t.sent).toEqual([]);
  });
});

describe("registering a group", () => {
  async function linked() {
    const u = await user();
    const tg = ++nextTg;
    await pool.query("INSERT INTO telegram_links (user_id, tg_user_id) VALUES ($1,$2)", [u, tg]);
    return { u, tg };
  }
  const channels = async (u: string) =>
    (await pool.query("SELECT target, title, active FROM post_channels WHERE user_id = $1", [u]))
      .rows;

  it("lets a linked group admin start and stop posting", async () => {
    const { u, tg } = await linked();
    const t = fakeTelegram();
    await handleUpdate(pool, t.api, URLS, group(tg, "/tape@TapeVerifyBot", -4242));
    expect(await channels(u)).toEqual([{ target: "-4242", title: "Alpha Room", active: true }]);
    expect(t.sent.find((s) => s.method === "getChatMember")?.body).toMatchObject({
      chat_id: -4242,
      user_id: tg,
    });
    await handleUpdate(pool, t.api, URLS, group(tg, "/stop", -4242));
    expect((await channels(u))[0]?.active).toBe(false);
    await handleUpdate(pool, t.api, URLS, group(tg, "/tape", -4242));
    expect(await channels(u)).toHaveLength(1);
    expect((await channels(u))[0]?.active).toBe(true);
  });

  it("refuses someone who isn't linked, isn't an admin, or is in a private chat", async () => {
    const stranger = ++nextTg;
    const t1 = fakeTelegram();
    await handleUpdate(pool, t1.api, URLS, group(stranger, "/tape", -5151));
    expect(t1.messages()[0]?.body.text).toMatch(/Link your TapeVerify account first/);

    const { u, tg } = await linked();
    const member = fakeTelegram((m) =>
      m === "getChatMember" ? { ok: true, result: { status: "member" } } : undefined,
    );
    await handleUpdate(pool, member.api, URLS, group(tg, "/tape", -5252));
    expect(member.messages()[0]?.body.text).toMatch(/Only group admins/);

    const priv = fakeTelegram();
    await handleUpdate(pool, priv.api, URLS, dm(tg, "/tape"));
    expect(priv.messages()[0]?.body.text).toMatch(/group/);
    expect(await channels(u)).toEqual([]);
  });
});

describe("showing a call in a group", () => {
  async function aCall() {
    const u = await user();
    const code = `K${Math.random().toString(36).slice(2, 9)}`;
    await pool.query(
      `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms, tp_price)
       VALUES ($1,$2,'BTC-USD','long',10,1,$3,50,'open',80000,1,1,84000)`,
      [code, u, Date.now() + 3_600_000],
    );
    return code;
  }

  it("posts the call with a follow button and a link preview of the share card", async () => {
    const code = await aCall();
    const t = fakeTelegram();
    await handleUpdate(pool, t.api, URLS, group(++nextTg, `/call ${code}`));
    const m = t.messages()[0]?.body as Record<string, any>;
    expect(m.text).toContain("LONG BTC-USD 10x");
    expect(m.text).toContain("Entry 80,000 (from the fill)");
    expect(m.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "Follow on TapeVerify",
      url: `https://tape.example/call/${code}`,
    });
    expect(m.link_preview_options.url).toBe(`https://share.tape.example/c/${code}`);
  });

  it("falls back to a plain link where Telegram would reject a localhost button, and says when a call doesn't exist", async () => {
    const code = await aCall();
    const t = fakeTelegram();
    await handleUpdate(
      pool,
      t.api,
      { web: "http://localhost:5173", share: "http://localhost:3001" },
      group(++nextTg, `/call ${code}`),
    );
    const m = t.messages()[0]?.body as Record<string, any>;
    expect(m.reply_markup).toBeUndefined();
    expect(m.text).toContain(`http://localhost:5173/call/${code}`);
    await handleUpdate(pool, t.api, URLS, group(++nextTg, "/call ZZZZZZZZ"));
    expect(t.messages().at(-1)?.body.text).toMatch(/No call with that code/);
  });
});
