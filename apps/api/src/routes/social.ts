import { randomBytes } from "node:crypto";
import { vaultEligibility } from "@pit/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { argusFor } from "../argus.js";
import { findTrader, scoreAccount } from "../traders/service.js";

const MIN = 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const uuid = z.object({ id: z.string().uuid() });

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function socialRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };
  const write = {
    preHandler: d.requireUser,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  const read = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  // ── Following traders ──

  app.post("/v1/traders/:ref/follow", write, async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const me = req.user!.id;
    const t = await findTrader(d.pool, ref);
    if (!t) return reply.code(404).send({ error: "Trader not found" });
    if (t.userId === me)
      return reply.code(409).send({ error: "You can't follow yourself", code: "self" });
    const r = await d.pool.query(
      "INSERT INTO trader_follows (follower_id, trader_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [me, t.userId],
    );
    if (r.rowCount) {
      const who = req.user!;
      await d.pool.query(
        `INSERT INTO notifications (user_id, kind, ref, title, body, url) VALUES ($1,'new_follower',$2,'New follower',$3,NULL) ON CONFLICT DO NOTHING`,
        [
          t.userId,
          `follower:${me}`,
          `${(who as { handle?: string | null }).handle ?? short(who.address)} started following you.`,
        ],
      );
    }
    return { following: true };
  });

  app.delete("/v1/traders/:ref/follow", write, async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const t = await findTrader(d.pool, ref);
    if (!t) return reply.code(404).send({ error: "Trader not found" });
    await d.pool.query("DELETE FROM trader_follows WHERE follower_id = $1 AND trader_id = $2", [
      req.user!.id,
      t.userId,
    ]);
    return { following: false };
  });

  app.get("/v1/me/following", auth, async (req) => {
    const { rows } = await d.pool.query(
      `SELECT u.id, u.handle, u.chain, u.address FROM trader_follows tf JOIN users u ON u.id = tf.trader_id
        WHERE tf.follower_id = $1 ORDER BY tf.created_at DESC LIMIT 200`,
      [req.user!.id],
    );
    return {
      following: rows.map((r) => ({
        ref: r.handle ?? r.id,
        handle: r.handle,
        chain: r.chain,
        address: r.address,
      })),
    };
  });

  // ── Feed: calls opening and closing, and verified trades closing ──

  app.get("/v1/feed", read, async (req) => {
    const q = z
      .object({
        scope: z.enum(["following", "all"]).default("all"),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(25),
      })
      .parse(req.query);
    const viewer = await d.optionalUser(req);
    const followingOnly = q.scope === "following";
    if (followingOnly && !viewer) return { events: [], next: null, scope: q.scope };
    const before = q.before ?? Date.now() + MIN;
    const who = followingOnly
      ? "AND c.user_id IN (SELECT trader_id FROM trader_follows WHERE follower_id = $3)"
      : "";
    const whoT = followingOnly
      ? "AND u.id IN (SELECT trader_id FROM trader_follows WHERE follower_id = $3)"
      : "";
    const args = followingOnly ? [before, q.limit * 2, viewer!.id] : [before, q.limit * 2];

    const calls = await d.pool.query(
      `SELECT c.id, c.short_code, c.symbol, c.side, c.leverage, c.status, c.entry_price, c.entry_ts_ms, c.exit_price, c.exit_ts_ms, c.exit_reason,
              u.id AS uid, u.handle, u.chain, u.address,
              (SELECT count(*) FROM call_comments m WHERE m.call_id = c.id) AS comments
         FROM calls c JOIN users u ON u.id = c.user_id
        WHERE c.entry_price IS NOT NULL AND c.status IN ('open', 'expired', 'closed') AND c.entry_ts_ms < $1 ${who}
        ORDER BY c.entry_ts_ms DESC LIMIT $2`,
      args,
    );
    const closedCalls = await d.pool.query(
      `SELECT c.id, c.short_code, c.symbol, c.side, c.leverage, c.status, c.entry_price, c.entry_ts_ms, c.exit_price, c.exit_ts_ms, c.exit_reason,
              u.id AS uid, u.handle, u.chain, u.address,
              (SELECT count(*) FROM call_comments m WHERE m.call_id = c.id) AS comments
         FROM calls c JOIN users u ON u.id = c.user_id
        WHERE c.status = 'closed' AND c.exit_price IS NOT NULL AND c.exit_ts_ms < $1 ${who}
        ORDER BY c.exit_ts_ms DESC LIMIT $2`,
      args,
    );
    const trades = await d.pool.query(
      `SELECT t.id, t.symbol, t.side, t.closed_ms, t.entry_price, t.exit_price, t.net_pnl, t.liquidated, u.id AS uid, u.handle, u.chain, u.address
         FROM trades t JOIN users u ON u.strike_account_id = t.account_id
        WHERE t.closed_ms < $1 ${whoT} ORDER BY t.closed_ms DESC LIMIT $2`,
      args,
    );

    const trader = (r: { uid: string; handle: string | null; chain: string; address: string }) => ({
      ref: r.handle ?? r.uid,
      name: r.handle ?? short(r.address),
      chain: r.chain,
    });
    const callView = (r: Record<string, unknown>) => ({
      code: r.short_code,
      symbol: r.symbol,
      side: r.side,
      leverage: r.leverage,
      entryPrice: String(r.entry_price),
      exitPrice: r.exit_price === null ? null : String(r.exit_price),
      exitReason: r.exit_reason,
      comments: Number(r.comments),
    });
    type Row = Record<string, unknown> & {
      uid: string;
      handle: string | null;
      chain: string;
      address: string;
    };
    const events = [
      ...(calls.rows as Row[]).map((r) => ({
        kind: "call_opened" as const,
        at: Number(r.entry_ts_ms),
        trader: trader(r),
        uid: r.uid,
        call: callView(r),
      })),
      ...(closedCalls.rows as Row[]).map((r) => ({
        kind: "call_closed" as const,
        at: Number(r.exit_ts_ms),
        trader: trader(r),
        uid: r.uid,
        call: callView(r),
      })),
      ...(trades.rows as Row[]).map((r) => ({
        kind: "trade_closed" as const,
        at: Number(r.closed_ms),
        trader: trader(r),
        uid: r.uid,
        trade: {
          symbol: r.symbol,
          side: r.side,
          entryPrice: String(r.entry_price),
          exitPrice: String(r.exit_price),
          netPnl: String(r.net_pnl),
          liquidated: r.liquidated,
        },
      })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, q.limit);

    const rep = await argusFor(d.pool, [...new Set(events.map((e) => e.uid))]);
    return {
      scope: q.scope,
      events: events.map(({ uid, ...e }) => ({
        ...e,
        trader: {
          ...e.trader,
          argus: rep.get(uid)
            ? {
                clean: rep.get(uid)?.clean,
                underReview: rep.get(uid)?.underReview,
                score: rep.get(uid)?.score,
              }
            : null,
        },
      })),
      next: events.length === q.limit ? (events[events.length - 1]?.at ?? null) : null,
    };
  });

  // ── Comments ──

  const CODE = z.object({ code: z.string().regex(/^[A-Za-z0-9]{4,16}$/) });
  app.get("/v1/calls/:code/comments", read, async (req, reply) => {
    const { code } = CODE.parse(req.params);
    const call = (await d.pool.query("SELECT id, user_id FROM calls WHERE short_code = $1", [code]))
      .rows[0];
    if (!call) return reply.code(404).send({ error: "Call not found" });
    const viewer = await d.optionalUser(req);
    const { rows } = await d.pool.query(
      `SELECT m.id, m.body, m.created_at, m.user_id, u.handle, u.address FROM call_comments m JOIN users u ON u.id = m.user_id
        WHERE m.call_id = $1 ORDER BY m.created_at ASC LIMIT 200`,
      [call.id],
    );
    return {
      comments: rows.map((r) => ({
        id: r.id,
        body: r.body,
        at: r.created_at.getTime(),
        author: {
          ref: r.handle ?? r.user_id,
          name: r.handle ?? short(r.address),
          isCaller: r.user_id === call.user_id,
        },
        canDelete: Boolean(viewer && (viewer.id === r.user_id || viewer.id === call.user_id)),
      })),
    };
  });

  app.post(
    "/v1/calls/:code/comments",
    { preHandler: d.requireUser, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { code } = CODE.parse(req.params);
      const { body } = z.object({ body: z.string().trim().min(1).max(500) }).parse(req.body);
      const call = (
        await d.pool.query("SELECT id, user_id, symbol, side FROM calls WHERE short_code = $1", [
          code,
        ])
      ).rows[0];
      if (!call) return reply.code(404).send({ error: "Call not found" });
      const me = req.user!;
      const { rows } = await d.pool.query(
        "INSERT INTO call_comments (call_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, created_at",
        [call.id, me.id, body],
      );
      if (call.user_id !== me.id) {
        await d.pool.query(
          `INSERT INTO notifications (user_id, kind, ref, title, body, url) VALUES ($1,'comment',$2,'New comment on your call',$3,$4) ON CONFLICT DO NOTHING`,
          [
            call.user_id,
            `comment:${rows[0].id}`,
            `${(me as { handle?: string | null }).handle ?? short(me.address)}: ${body.slice(0, 120)}`,
            `${d.api.publicWebUrl.replace(/\/$/, "")}/call/${code}`,
          ],
        );
      }
      return reply.code(201).send({ id: rows[0].id, at: rows[0].created_at.getTime() });
    },
  );

  app.delete("/v1/comments/:id", write, async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const r = await d.pool.query(
      `DELETE FROM call_comments m USING calls c WHERE m.id = $1 AND c.id = m.call_id AND (m.user_id = $2 OR c.user_id = $2)`,
      [id, req.user!.id],
    );
    if (!r.rowCount) return reply.code(404).send({ error: "Comment not found" });
    return { ok: true };
  });

  // ── Notifications ──

  app.get("/v1/notifications", auth, async (req) => {
    const me = req.user!.id;
    const { rows } = await d.pool.query(
      "SELECT id, kind, title, body, url, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [me],
    );
    const unread = (
      await d.pool.query(
        "SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [me],
      )
    ).rows[0].n;
    return {
      unread: Number(unread),
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        url: r.url,
        at: r.created_at.getTime(),
        read: r.read_at !== null,
      })),
    };
  });

  app.post("/v1/notifications/read", write, async (req) => {
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).max(100).optional() })
      .parse(req.body ?? {});
    await d.pool.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL ${ids ? "AND id = ANY($2)" : ""}`,
      ids ? [req.user!.id, ids] : [req.user!.id],
    );
    return { ok: true };
  });

  // ── Where calls get posted ──

  app.get("/v1/me/connections", auth, async (req) => {
    const me = req.user!.id;
    const tg = (
      await d.pool.query("SELECT tg_username FROM telegram_links WHERE user_id = $1", [me])
    ).rows[0];
    const ch = await d.pool.query(
      "SELECT id, kind, target, title, active FROM post_channels WHERE user_id = $1 ORDER BY created_at",
      [me],
    );
    return {
      telegram: {
        available: Boolean(d.api.telegramBot),
        bot: d.api.telegramBot,
        linked: Boolean(tg),
        username: tg?.tg_username ?? null,
      },
      x: { available: d.api.xPosting },
      channels: ch.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.kind === "x" ? "Pit's X account" : (r.title ?? r.target),
        active: r.active,
      })),
    };
  });

  app.post(
    "/v1/telegram/link-code",
    { preHandler: d.requireUser, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!d.api.telegramBot)
        return reply
          .code(503)
          .send({ error: "The Telegram bot isn't set up on this server", code: "not_configured" });
      const me = req.user!.id;
      const bytes = randomBytes(8);
      const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      await d.pool.query("DELETE FROM telegram_link_codes WHERE user_id = $1", [me]);
      await d.pool.query(
        "INSERT INTO telegram_link_codes (code, user_id, expires_ms) VALUES ($1,$2,$3)",
        [code, me, Date.now() + 10 * MIN],
      );
      return { code, expiresInSeconds: 600, bot: d.api.telegramBot, command: `/link ${code}` };
    },
  );

  app.post("/v1/me/channels/x", write, async (req, reply) => {
    if (!d.api.xPosting)
      return reply
        .code(503)
        .send({ error: "Posting to X isn't set up on this server", code: "not_configured" });
    await d.pool.query(
      `INSERT INTO post_channels (user_id, kind, target, title) VALUES ($1,'x','pit','Pit''s X account')
       ON CONFLICT (user_id, kind, target) DO UPDATE SET active = true, created_at = CASE WHEN post_channels.active THEN post_channels.created_at ELSE now() END`,
      [req.user!.id],
    );
    return { ok: true };
  });

  app.delete("/v1/me/channels/:id", write, async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const r = await d.pool.query("DELETE FROM post_channels WHERE id = $1 AND user_id = $2", [
      id,
      req.user!.id,
    ]);
    if (!r.rowCount) return reply.code(404).send({ error: "Channel not found" });
    return { ok: true };
  });

  // ── Vault graduation: a guided hand-off. Strike's app creates the vault; Pit says who has earned it. ──

  async function vaultState(meId: string) {
    const me = { id: meId };
    const row = (
      await d.pool.query(
        "SELECT strike_account_id, handle, chain, address FROM users WHERE id = $1",
        [me.id],
      )
    ).rows[0];
    let eligibility = vaultEligibility({
      trades: 0,
      activeDays: 0,
      totalReturnPct: null,
      maxDrawdownPct: null,
      clean: false,
      reputation: null,
    });
    if (row.strike_account_id) {
      const { scored } = await scoreAccount(
        d.pool,
        {
          userId: me.id,
          accountId: row.strike_account_id,
          handle: row.handle,
          chain: row.chain,
          address: row.address,
        },
        "all",
      );
      const rep = (await argusFor(d.pool, [me.id])).get(me.id);
      eligibility = vaultEligibility({
        trades: scored.stats.trades,
        activeDays: scored.stats.activeDays,
        totalReturnPct: scored.stats.totalReturnPct,
        maxDrawdownPct: scored.stats.maxDrawdownPct,
        clean: rep?.clean ?? false,
        reputation: rep?.score ?? null,
      });
    }
    // If they already launched one in the Strike app, it shows up in Strike's public vault list.
    let vault: Record<string, unknown> | null = null;
    let lookupFailed = false;
    if (row.strike_account_id) {
      try {
        const r = await (await d.gateway.anon()).publicGet<{
          vaults: Array<Record<string, unknown>>;
        }>(`/v2/vaults?leader_account_id=${encodeURIComponent(row.strike_account_id)}`);
        const v = r.vaults?.find((x) => x.type === "user" && x.status !== "closed") ?? null;
        vault = v && {
          id: v.vault_id,
          name: v.name,
          status: v.status,
          equity: String(v.equity),
          sharePrice: String(v.share_price),
          depositors: Number(v.depositors),
          allTimePnl: String(v.all_time_pnl),
          leaderCommissionBps: Number(v.leader_commission_bps),
        };
      } catch {
        lookupFailed = true;
      }
    }
    const handoff = (
      await d.pool.query("SELECT noted_ms FROM vault_handoffs WHERE user_id = $1", [me.id])
    ).rows[0];
    return {
      ...eligibility,
      vault,
      lookupFailed,
      handedOffAt: handoff ? Number(handoff.noted_ms) : null,
      steps: [
        "Open the Strike app and go to Vaults.",
        "Create a vault. Strike charges a 100 USDC creation fee from your own account.",
        "You choose your commission (up to 50%) and keep at least 5% of the shares.",
        "Once it's live, it appears here automatically with its stats.",
      ],
      note: "Strike has no API to create a vault for someone else, so Pit can only point eligible traders to it.",
    };
  }

  app.get("/v1/me/vault", auth, async (req) => vaultState(req.user!.id));

  app.post("/v1/me/vault/handoff", write, async (req, reply) => {
    const v = (
      await app.inject({
        method: "GET",
        url: "/v1/me/vault",
        headers: { cookie: req.headers.cookie ?? "" },
      })
    ).json() as { eligible?: boolean };
    if (!v.eligible)
      return reply.code(409).send({ error: "Not eligible yet", code: "not_eligible" });
    await d.pool.query(
      "INSERT INTO vault_handoffs (user_id, noted_ms) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.user!.id, Date.now()],
    );
    return { ok: true };
  });
}
