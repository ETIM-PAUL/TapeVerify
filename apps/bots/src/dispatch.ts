import { type PostCall, telegramText, xText } from "@tapeverify/shared";
import type pg from "pg";
import { buttonable, TelegramApi, TelegramError } from "./telegram.js";
import { XClient, XError } from "./x.js";

export interface Urls {
  web: string;
  share: string;
}
export interface Senders {
  telegram: TelegramApi | null;
  x: XClient | null;
}
export interface Log {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
}

const MAX_ATTEMPTS = 5;
const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function postCall(r: Record<string, unknown>): PostCall {
  return {
    code: String(r.short_code),
    symbol: String(r.symbol),
    side: r.side as "long" | "short",
    leverage: Number(r.leverage),
    entryPrice: r.entry_price === null ? null : String(r.entry_price),
    tpPrice: r.tp_price === null ? null : String(r.tp_price),
    slPrice: r.sl_price === null ? null : String(r.sl_price),
    exitPrice: r.exit_price === null ? null : String(r.exit_price),
    exitReason: (r.exit_reason as string | null) ?? null,
    trader: (r.handle as string | null) ?? short(String(r.address)),
  };
}

/**
 * Sends pending posts. A post that fails is retried a few times; one the platform refuses for good
 * (the bot was removed from the group, the account can't post) is failed at once and its channel switched off.
 */
export async function dispatchOutbox(
  pool: pg.Pool,
  senders: Senders,
  urls: Urls,
  log: Log,
  now = Date.now(),
  limit = 20,
) {
  const c = await pool.connect();
  let sent = 0;
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      `SELECT o.id, o.event, o.attempts, ch.id AS channel_id, ch.kind, ch.target, k.short_code, k.symbol, k.side, k.leverage, k.entry_price,
              k.tp_price, k.sl_price, k.exit_price, k.exit_reason, u.handle, u.address
         FROM outbox o JOIN post_channels ch ON ch.id = o.channel_id AND ch.active
         JOIN calls k ON k.id = o.call_id JOIN users u ON u.id = k.user_id
        WHERE o.status = 'pending' AND o.attempts < $1 ORDER BY o.id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`,
      [MAX_ATTEMPTS, limit],
    );
    for (const r of rows) {
      const call = postCall(r);
      const shareUrl = `${urls.share.replace(/\/$/, "")}/c/${call.code}`;
      const followUrl = `${urls.web.replace(/\/$/, "")}/call/${call.code}`;
      try {
        let externalId: string;
        if (r.kind === "telegram") {
          if (!senders.telegram) continue; // not configured here: leave it pending
          const text = telegramText(r.event, call);
          const useButton = buttonable(followUrl);
          const m = await senders.telegram.sendMessage(
            r.target,
            useButton ? text : `${text}\n${followUrl}`,
            {
              link_preview_options: {
                url: shareUrl,
                prefer_large_media: true,
                show_above_text: false,
              },
              ...(useButton
                ? {
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: r.event === "opened" ? "Follow on TapeVerify" : "See the result",
                            url: followUrl,
                          },
                        ],
                      ],
                    },
                  }
                : {}),
            },
          );
          externalId = String(m.message_id);
        } else {
          if (!senders.x) continue;
          externalId = await senders.x.post(xText(r.event, call, shareUrl));
        }
        await c.query(
          "UPDATE outbox SET status = 'sent', sent_ms = $2, external_id = $3, attempts = attempts + 1, error = NULL WHERE id = $1",
          [r.id, now, externalId],
        );
        sent++;
      } catch (e) {
        const permanent = (e instanceof TelegramError || e instanceof XError) && e.permanent;
        const msg = (e as Error).message.slice(0, 300);
        const attempts = Number(r.attempts) + 1;
        await c.query("UPDATE outbox SET attempts = $2, error = $3, status = $4 WHERE id = $1", [
          r.id,
          attempts,
          msg,
          permanent || attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        ]);
        if (permanent && r.kind === "telegram")
          await c.query("UPDATE post_channels SET active = false WHERE id = $1", [r.channel_id]);
        log.warn("post failed", { outbox: r.id, kind: r.kind, permanent, err: msg });
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  if (sent) log.info("posts sent", { sent });
  return sent;
}
