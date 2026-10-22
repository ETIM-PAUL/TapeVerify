import type pg from "pg";
import type { Logger } from "../log.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SocialUrls {
  web: string;
}

const STOP_WORDS: Record<string, string> = {
  loss_cap: "it reached its loss limit",
  wallet_revoked: "its API wallet was revoked",
  emergency_stop: "the operator emergency stop was on",
  kill_switch: "a kill switch tripped",
};

/**
 * Turns what happened into notifications and posts. Everything is keyed so a repeat run is a no-op:
 * a notification's ref is unique per person, and an outbox row is unique per call, channel and event.
 */
export async function fanOut(pool: pg.Pool, urls: SocialUrls, log?: Logger, now = Date.now()) {
  const web = urls.web.replace(/\/$/, "");
  const since = now - DAY;
  const out = { calls: 0, liquidations: 0, stops: 0, posts: 0 };

  // New calls from traders a person follows. Only calls that opened after they started following.
  out.calls =
    (
      await pool.query(
        `INSERT INTO notifications (user_id, kind, ref, title, body, url)
         SELECT tf.follower_id, 'new_call', 'call:' || c.id,
                'New call from ' || COALESCE(u.handle, left(u.address, 6) || '…'),
                upper(c.side) || ' ' || c.symbol || ' ' || c.leverage || 'x, entry ' || trim_scale(c.entry_price)::text,
                $1 || '/call/' || c.short_code
           FROM calls c
           JOIN users u ON u.id = c.user_id
           JOIN trader_follows tf ON tf.trader_id = c.user_id
          WHERE c.status IN ('open', 'closed', 'expired') AND c.entry_price IS NOT NULL AND c.entry_ts_ms > $2
            AND c.entry_ts_ms > extract(epoch FROM tf.created_at) * 1000
         ON CONFLICT (user_id, ref) DO NOTHING`,
        [web, since],
      )
    ).rowCount ?? 0;

  // Liquidation alerts: one notification per level reached, so an escalation notifies again.
  out.liquidations =
    (
      await pool.query(
        `INSERT INTO notifications (user_id, kind, ref, title, body, url)
         SELECT a.user_id, 'liquidation', 'liq:' || a.id || ':' || a.level,
                CASE a.level WHEN 'warn' THEN 'Getting close to liquidation' WHEN 'danger' THEN 'Close to liquidation' ELSE 'About to be liquidated' END,
                upper(f.side) || ' ' || a.symbol || ' ' || f.leverage || 'x: price ' || trim_scale(a.mark_price)::text
                  || ', liquidation at ' || trim_scale(a.liq_price)::text,
                $1 || '/call/' || c.short_code
           FROM liquidation_alerts a JOIN follows f ON f.id = a.follow_id JOIN calls c ON c.id = f.call_id
          WHERE a.resolved_ms IS NULL AND a.created_ms > $2
         ON CONFLICT (user_id, ref) DO NOTHING`,
        [web, since - DAY],
      )
    ).rowCount ?? 0;

  // Strategies that stopped on their own (not because the person pressed stop).
  const stops = await pool.query(
    `SELECT id, user_id, name, status, stop_reason FROM live_runs
      WHERE status IN ('stopped', 'halted', 'error') AND stopped_at > to_timestamp($1 / 1000.0)
        AND COALESCE(stop_reason, '') NOT IN ('user_stop', 'stop')`,
    [since],
  );
  for (const r of stops.rows) {
    const why =
      STOP_WORDS[r.stop_reason ?? ""] ??
      (r.stop_reason ? String(r.stop_reason).replaceAll("_", " ") : "it hit a problem");
    const res = await pool.query(
      `INSERT INTO notifications (user_id, kind, ref, title, body, url) VALUES ($1,'strategy_stop',$2,$3,$4,$5)
       ON CONFLICT (user_id, ref) DO NOTHING`,
      [
        r.user_id,
        `stop:${r.id}`,
        `Strategy stopped: ${r.name}`,
        `Your live strategy stopped because ${why}. Check it before restarting.`,
        `${web}/studio`,
      ],
    );
    out.stops += res.rowCount ?? 0;
  }

  // Posts: a call opened after the channel was added is posted once per channel; a close follows only an open that was sent.
  out.posts +=
    (
      await pool.query(
        `INSERT INTO outbox (call_id, channel_id, event, created_ms)
         SELECT c.id, ch.id, 'opened', $1
           FROM calls c JOIN post_channels ch ON ch.user_id = c.user_id AND ch.active
          WHERE c.status IN ('open', 'closed', 'expired') AND c.entry_price IS NOT NULL AND c.entry_ts_ms > $2
            AND c.entry_ts_ms > extract(epoch FROM ch.created_at) * 1000
         ON CONFLICT (call_id, channel_id, event) DO NOTHING`,
        [now, since],
      )
    ).rowCount ?? 0;
  out.posts +=
    (
      await pool.query(
        `INSERT INTO outbox (call_id, channel_id, event, created_ms)
         SELECT c.id, o.channel_id, 'closed', $1
           FROM calls c JOIN outbox o ON o.call_id = c.id AND o.event = 'opened' AND o.status = 'sent'
           JOIN post_channels ch ON ch.id = o.channel_id AND ch.active
          WHERE c.status = 'closed' AND c.exit_price IS NOT NULL AND c.exit_ts_ms > $2
         ON CONFLICT (call_id, channel_id, event) DO NOTHING`,
        [now, since],
      )
    ).rowCount ?? 0;

  await pool.query("DELETE FROM notifications WHERE created_at < now() - interval '60 days'");
  await pool.query("DELETE FROM telegram_link_codes WHERE expires_ms < $1", [now]);
  if (out.calls || out.liquidations || out.stops || out.posts) log?.info("social fan-out", out);
  return out;
}
