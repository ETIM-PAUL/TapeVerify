import { type PostCall, telegramText } from "@pit/shared";
import type pg from "pg";
import { postCall, type Urls } from "./dispatch.js";
import { buttonable, type TelegramApi, type TgMessage, type TgUpdate } from "./telegram.js";

const HELP = [
  "<b>Pit bot</b>",
  "Post your Pit calls to a group, and let people follow them in one tap.",
  "",
  "1. In Pit, open Connections and copy your link code.",
  "2. Send it here: <code>/link CODE</code>",
  "3. Add me to your group, then send <code>/pit</code> there (group admins only).",
  "",
  "In a group: <code>/call CODE</code> shows a call, <code>/stop</code> stops posting.",
].join("\n");

/** "/pit@PitBot arg" → ["pit", "arg"]. Returns null for anything that isn't a command. */
export function parseCommand(text: string | undefined): { cmd: string; arg: string } | null {
  const m = text?.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  return m ? { cmd: (m[1] as string).toLowerCase(), arg: (m[2] ?? "").trim() } : null;
}

const isGroup = (m: TgMessage) => m.chat.type === "group" || m.chat.type === "supergroup";

async function linkedUser(pool: pg.Pool, tgUserId: number): Promise<string | null> {
  const r = await pool.query("SELECT user_id FROM telegram_links WHERE tg_user_id = $1", [
    tgUserId,
  ]);
  return r.rows[0]?.user_id ?? null;
}

/** Handles one Telegram update. Never throws for bad input: a chat command that can't be done gets a reply. */
export async function handleUpdate(
  pool: pg.Pool,
  api: TelegramApi,
  urls: Urls,
  u: TgUpdate,
  now = Date.now(),
): Promise<void> {
  const m = u.message;
  if (!m?.from || m.from.is_bot) return;
  const c = parseCommand(m.text);
  if (!c) return;
  const say = (text: string) =>
    api.sendMessage(m.chat.id, text, { link_preview_options: { is_disabled: true } });

  if (c.cmd === "start" || c.cmd === "help") {
    await say(HELP);
    return;
  }

  if (c.cmd === "link") {
    if (m.chat.type !== "private")
      return void (await say(
        "Send <code>/link CODE</code> to me in a private chat, not in a group.",
      ));
    const code = c.arg.toUpperCase();
    const hit = await pool.query(
      "DELETE FROM telegram_link_codes WHERE code = $1 AND expires_ms > $2 RETURNING user_id",
      [code, now],
    );
    if (!hit.rows[0])
      return void (await say(
        "That code is wrong or has expired. Get a new one in Pit under Connections.",
      ));
    try {
      await pool.query(
        `INSERT INTO telegram_links (user_id, tg_user_id, tg_username) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET tg_user_id = EXCLUDED.tg_user_id, tg_username = EXCLUDED.tg_username, linked_at = now()`,
        [hit.rows[0].user_id, m.from.id, m.from.username ?? null],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return void (await say("This Telegram account is already linked to another Pit account."));
      throw e;
    }
    await say("Linked. Now add me to a group and send <code>/pit</code> there.");
    return;
  }

  if (c.cmd === "pit" || c.cmd === "stop") {
    if (!isGroup(m)) return void (await say("Use this in a group I've been added to."));
    const user = await linkedUser(pool, m.from.id);
    if (!user)
      return void (await say(
        "Link your Pit account first: message me privately with <code>/link CODE</code>.",
      ));
    const member = await api.getChatMember(m.chat.id, m.from.id).catch(() => null);
    if (!member || (member.status !== "creator" && member.status !== "administrator"))
      return void (await say("Only group admins can do this."));
    if (c.cmd === "stop") {
      await pool.query(
        "UPDATE post_channels SET active = false WHERE user_id = $1 AND kind = 'telegram' AND target = $2",
        [user, String(m.chat.id)],
      );
      return void (await say("Stopped. Your calls won't be posted here any more."));
    }
    await pool.query(
      `INSERT INTO post_channels (user_id, kind, target, title) VALUES ($1,'telegram',$2,$3)
       ON CONFLICT (user_id, kind, target) DO UPDATE SET active = true, title = EXCLUDED.title, created_at = CASE WHEN post_channels.active THEN post_channels.created_at ELSE now() END`,
      [user, String(m.chat.id), m.chat.title ?? null],
    );
    await say("Done. Your new Pit calls will be posted here, with a button to follow them.");
    return;
  }

  if (c.cmd === "call") {
    const code = c.arg.replace(/[^A-Za-z0-9]/g, "");
    const r = await pool.query(
      `SELECT k.short_code, k.symbol, k.side, k.leverage, k.entry_price, k.tp_price, k.sl_price, k.exit_price, k.exit_reason, k.status, u.handle, u.address
         FROM calls k JOIN users u ON u.id = k.user_id WHERE k.short_code = $1`,
      [code],
    );
    if (!r.rows[0]) return void (await say("No call with that code."));
    const call: PostCall = postCall(r.rows[0]);
    const followUrl = `${urls.web.replace(/\/$/, "")}/call/${call.code}`;
    const event = r.rows[0].status === "closed" ? "closed" : "opened";
    const text = telegramText(event, call);
    const button = buttonable(followUrl);
    await api.sendMessage(m.chat.id, button ? text : `${text}\n${followUrl}`, {
      link_preview_options: {
        url: `${urls.share.replace(/\/$/, "")}/c/${call.code}`,
        prefer_large_media: true,
        show_above_text: false,
      },
      ...(button
        ? { reply_markup: { inline_keyboard: [[{ text: "Follow on Pit", url: followUrl }]] } }
        : {}),
    });
  }
}
