import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  describeStrategy,
  initialState,
  type LiveRecord,
  liveRecord,
  type MarketLimits,
  type RecordTrade,
  rulesHash,
  specHash,
  strategySpecSchema,
  validateStrategy,
} from "@tapeverify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { startLive } from "./live.js";

const MAX_STRATEGIES = 50;
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface ListingRow {
  id: string;
  creator_id: string;
  strategy_id: string | null;
  title: string;
  description: string;
  spec: unknown;
  spec_hash: string;
  version: number;
  status: "published" | "unlisted";
  creator_share_bps: number;
  created_at: Date;
  updated_at: Date;
  handle?: string | null;
  chain?: string;
  address?: string;
}

const cloneBody = z.object({
  maxMarginUsd: z.number().min(5).max(1_000_000),
  maxLossUsd: z.number().gt(0).max(1_000_000),
  mode: z.enum(["save", "paper", "live"]).default("save"),
  /** Needed for mode "live": it trades real funds. */
  acknowledge: z.boolean().optional(),
  subAccountId: z.string().min(8).max(64).optional(),
});

export function marketRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };
  const builderBps = d.gateway.cfg.builderFeeBps;

  async function limits(): Promise<Record<string, MarketLimits>> {
    const out: Record<string, MarketLimits> = {};
    for (const m of Object.values(await d.gateway.marketRules())) {
      if (m.status === "trading" && !m.reduce_only)
        out[m.symbol] = {
          maxLeverage: m.margin_tiers[0]?.max_leverage ?? 1,
          minNotional: Number(m.order_min_notional),
        };
    }
    return out;
  }

  /** Closed live trades made by the creator with exactly the listing's rules and sizing: the verified record. */
  async function recordTrades(creatorId: string, hashes: string[]) {
    const { rows } = await d.pool.query(
      `SELECT t.id, t.seq, t.side, t.margin_usd, t.entry_price, t.entry_size, t.exit_price, t.entry_ts_ms, t.exit_ts_ms,
              t.realized_pnl, t.entry_fee, t.exit_fee, t.exit_reason, t.primary_client_order_id, t.entry_order_id, r.account_id, r.spec_hash
         FROM live_trades t JOIN live_runs r ON r.id = t.run_id
        WHERE r.user_id = $1 AND r.spec_hash = ANY($2) AND t.status = 'closed' AND t.entry_price IS NOT NULL AND t.exit_price IS NOT NULL
        ORDER BY t.exit_ts_ms, t.id`,
      [creatorId, hashes],
    );
    return rows;
  }
  const toRecord = (rows: Awaited<ReturnType<typeof recordTrades>>): RecordTrade[] =>
    rows.map((r) => ({
      id: String(r.id),
      seq: r.seq,
      side: r.side,
      marginUsd: Number(r.margin_usd),
      entryPrice: Number(r.entry_price),
      entrySize: Number(r.entry_size),
      exitPrice: Number(r.exit_price),
      entryTs: Number(r.entry_ts_ms),
      exitTs: Number(r.exit_ts_ms),
      realizedPnl: Number(r.realized_pnl ?? 0),
      fees: Number(r.entry_fee ?? 0) + Number(r.exit_fee ?? 0),
      exitReason: r.exit_reason,
    }));

  const creatorOf = (l: ListingRow) => ({
    handle: l.handle ?? null,
    chain: l.chain ?? "",
    address: l.address ?? "",
  });
  const terms = (l: ListingRow) => ({
    creatorShareBps: l.creator_share_bps,
    builderBps,
    note: `TapeVerify charges a ${builderBps / 100}% builder fee on every fill you trade, with or without a clone. The creator receives ${l.creator_share_bps / 100}% of that fee from TapeVerify's side: cloning costs you nothing extra.`,
  });

  async function counts(ids: string[]) {
    const out = new Map<string, { clones: number; liveClones: number }>();
    for (const id of ids) out.set(id, { clones: 0, liveClones: 0 });
    if (!ids.length) return out;
    const c = await d.pool.query(
      "SELECT cloned_from_listing AS id, count(DISTINCT user_id) AS n FROM strategies WHERE cloned_from_listing = ANY($1) GROUP BY 1",
      [ids],
    );
    for (const r of c.rows) (out.get(r.id) as { clones: number }).clones = Number(r.n);
    const l = await d.pool.query(
      "SELECT listing_id AS id, count(DISTINCT user_id) AS n FROM live_runs WHERE listing_id = ANY($1) GROUP BY 1",
      [ids],
    );
    for (const r of l.rows) (out.get(r.id) as { liveClones: number }).liveClones = Number(r.n);
    return out;
  }

  const headline = (r: LiveRecord) => ({
    trades: r.trades,
    winRate: r.winRate,
    netPnl: r.netPnl,
    maxDrawdownUsd: r.maxDrawdownUsd,
    profitFactor: r.profitFactor,
    avgReturnOnMarginPct: r.avgReturnOnMarginPct,
  });

  // ── Browse ──

  app.get(
    "/v1/market",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const q = z
        .object({
          market: z
            .string()
            .regex(/^[A-Z0-9]{2,10}-USD$/)
            .optional(),
          sort: z.enum(["pnl", "winrate", "clones", "newest"]).default("pnl"),
          minTrades: z.coerce.number().int().min(0).max(10_000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(req.query);
      const { rows } = await d.pool.query(
        `SELECT l.*, u.handle, u.chain, u.address FROM listings l JOIN users u ON u.id = l.creator_id
        WHERE l.status = 'published' AND ($1::text IS NULL OR l.spec->>'market' = $1) ORDER BY l.created_at DESC LIMIT 200`,
        [q.market ?? null],
      );
      const listings = rows as ListingRow[];
      const cnt = await counts(listings.map((l) => l.id));
      const all = await Promise.all(
        listings.map(async (l) => {
          const rec = liveRecord(toRecord(await recordTrades(l.creator_id, [l.spec_hash])));
          const spec = strategySpecSchema.safeParse(l.spec);
          return {
            id: l.id,
            title: l.title,
            creator: creatorOf(l),
            version: l.version,
            publishedAt: l.created_at.getTime(),
            market: spec.success ? spec.data.market : "",
            timeframe: spec.success ? spec.data.timeframe : "",
            direction: spec.success ? spec.data.direction : "",
            leverage: spec.success ? spec.data.sizing.leverage : 0,
            record: headline(rec),
            ...cnt.get(l.id)!,
            creatorShareBps: l.creator_share_bps,
          };
        }),
      );
      const key = {
        pnl: (e: (typeof all)[number]) => e.record.netPnl,
        winrate: (e: (typeof all)[number]) => e.record.winRate ?? -1,
        clones: (e: (typeof all)[number]) => e.clones,
        newest: (e: (typeof all)[number]) => e.publishedAt,
      }[q.sort];
      const sorted = all
        .filter((e) => e.record.trades >= q.minTrades)
        .sort((a, b) => key(b) - key(a));
      return { total: sorted.length, listings: sorted.slice(q.offset, q.offset + q.limit) };
    },
  );

  app.get("/v1/market/mine", auth, async (req) => {
    const { rows } = await d.pool.query(
      "SELECT l.*, u.handle, u.chain, u.address FROM listings l JOIN users u ON u.id = l.creator_id WHERE l.creator_id = $1 ORDER BY l.created_at DESC",
      [req.user!.id],
    );
    const cnt = await counts(rows.map((r) => r.id));
    return {
      listings: await Promise.all(
        (rows as ListingRow[]).map(async (l) => ({
          id: l.id,
          title: l.title,
          status: l.status,
          version: l.version,
          strategyId: l.strategy_id,
          record: headline(liveRecord(toRecord(await recordTrades(l.creator_id, [l.spec_hash])))),
          ...cnt.get(l.id)!,
        })),
      ),
    };
  });

  app.get(
    "/v1/market/:id",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await d.pool.query(
        "SELECT l.*, u.handle, u.chain, u.address FROM listings l JOIN users u ON u.id = l.creator_id WHERE l.id = $1",
        [id],
      );
      const l = rows[0] as ListingRow | undefined;
      const viewer = await d.optionalUser(req);
      if (!l || (l.status !== "published" && viewer?.id !== l.creator_id))
        return reply.code(404).send({ error: "Listing not found" });
      const spec = strategySpecSchema.safeParse(l.spec);
      if (!spec.success) return reply.code(500).send({ error: "Listing is unreadable" });
      const raw = await recordTrades(l.creator_id, [l.spec_hash]);
      const rec = liveRecord(toRecord(raw));
      const c = (await counts([l.id])).get(l.id)!;
      const warnings = [
        "Past results don't predict future ones. This is a record of real trades by the creator, not a promise.",
        ...(rec.trades < 10
          ? [
              `Only ${rec.trades} closed live trade${rec.trades === 1 ? "" : "s"}: too few to say much.`,
            ]
          : []),
        "You trade with your own budget: TapeVerify's caps, stop-loss and loss limit apply to your clone exactly as to any live run.",
      ];
      return {
        id: l.id,
        title: l.title,
        description: l.description,
        status: l.status,
        version: l.version,
        publishedAt: l.created_at.getTime(),
        creator: creatorOf(l),
        rules: describeStrategy(spec.data),
        market: spec.data.market,
        timeframe: spec.data.timeframe,
        direction: spec.data.direction,
        leverage: spec.data.sizing.leverage,
        record: rec,
        ...c,
        terms: terms(l),
        warnings,
        trades: raw
          .slice(-100)
          .reverse()
          .map((r) => ({
            seq: r.seq,
            side: r.side,
            entryPrice: String(r.entry_price),
            exitPrice: String(r.exit_price),
            entryTs: Number(r.entry_ts_ms),
            exitTs: Number(r.exit_ts_ms),
            net: Number(r.realized_pnl ?? 0) - Number(r.entry_fee ?? 0) - Number(r.exit_fee ?? 0),
            reason: r.exit_reason,
            orderId: r.entry_order_id === null ? null : String(r.entry_order_id),
            clientOrderId: r.primary_client_order_id,
          })),
        verification: {
          source:
            "Closed live trades made by the creator with exactly these rules and sizing, from Strike's fills.",
          strikeAccountIds: [...new Set(raw.map((r) => r.account_id as string))],
          check:
            "Each trade's order id can be looked up in Strike's public order and fill history for that account.",
        },
      };
    },
  );

  // ── Publish and unlist ──

  app.post(
    "/v1/strategies/:id/publish",
    { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = req.user!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ title: z.string().min(3).max(60), description: z.string().max(500).default("") })
        .parse(req.body);
      const { rows: st } = await d.pool.query(
        "SELECT id, spec, cloned_from_listing FROM strategies WHERE id = $1 AND user_id = $2",
        [id, user.id],
      );
      if (!st[0]) return reply.code(404).send({ error: "Strategy not found" });
      const v = validateStrategy(st[0].spec, { markets: await limits() });
      if (!v.ok || !v.spec)
        return reply.code(400).send({ error: "The strategy has problems", issues: v.issues });

      if (st[0].cloned_from_listing) {
        const src = await d.pool.query("SELECT spec FROM listings WHERE id = $1", [
          st[0].cloned_from_listing,
        ]);
        if (src.rows[0] && rulesHash(src.rows[0].spec) === rulesHash(v.spec)) {
          return reply.code(409).send({
            error:
              "This is a copy of someone else's listing. Change its rules first, or build your own.",
            code: "is_a_clone",
          });
        }
      }
      const hash = specHash(v.spec);
      const rec = liveRecord(toRecord(await recordTrades(user.id, [hash])));
      if (rec.trades < d.api.marketMinLiveTrades) {
        return reply.code(409).send({
          error: `A listing needs a live record: at least ${d.api.marketMinLiveTrades} closed live trades with these exact rules (you have ${rec.trades}). Run it live first.`,
          code: "needs_live_record",
          have: rec.trades,
          need: d.api.marketMinLiveTrades,
        });
      }

      const existing = await d.pool.query(
        "SELECT id, spec_hash, version FROM listings WHERE strategy_id = $1 AND status = 'published'",
        [id],
      );
      if (existing.rows[0]) {
        const e = existing.rows[0];
        const version = e.spec_hash === hash ? e.version : e.version + 1;
        await d.pool.query(
          "UPDATE listings SET title = $2, description = $3, spec = $4, spec_hash = $5, version = $6, updated_at = now() WHERE id = $1",
          [e.id, body.title, body.description, JSON.stringify(v.spec), hash, version],
        );
        return { id: e.id, version, record: headline(rec) };
      }
      const { rows } = await d.pool.query(
        "INSERT INTO listings (creator_id, strategy_id, title, description, spec, spec_hash, creator_share_bps) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          user.id,
          id,
          body.title,
          body.description,
          JSON.stringify(v.spec),
          hash,
          d.api.creatorShareBps,
        ],
      );
      return reply.code(201).send({
        id: rows[0].id,
        version: 1,
        creatorShareBps: d.api.creatorShareBps,
        record: headline(rec),
      });
    },
  );

  app.post(
    "/v1/market/:id/unlist",
    { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const r = await d.pool.query(
        "UPDATE listings SET status = 'unlisted', updated_at = now() WHERE id = $1 AND creator_id = $2 AND status = 'published'",
        [id, req.user!.id],
      );
      if (!r.rowCount) return reply.code(404).send({ error: "Listing not found" });
      return { ok: true };
    },
  );

  // ── Clone into your own capped budget ──

  app.post(
    "/v1/market/:id/clone",
    { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = req.user!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = cloneBody.parse(req.body);
      const { rows } = await d.pool.query(
        "SELECT * FROM listings WHERE id = $1 AND status = 'published'",
        [id],
      );
      const l = rows[0] as ListingRow | undefined;
      if (!l) return reply.code(404).send({ error: "Listing not found" });
      if (l.creator_id === user.id)
        return reply.code(409).send({ error: "That's your own listing.", code: "own_listing" });

      const n = await d.pool.query("SELECT count(*) AS n FROM strategies WHERE user_id = $1", [
        user.id,
      ]);
      if (Number(n.rows[0].n) >= MAX_STRATEGIES)
        return reply.code(409).send({ error: `You can keep up to ${MAX_STRATEGIES} strategies` });
      if (body.mode === "live" && body.acknowledge !== true) {
        return reply.code(400).send({
          error: "Confirm that you understand this trades real funds (acknowledge: true).",
          code: "acknowledge_required",
        });
      }

      // The clone is the listed rules inside the cloner's own limits: margin and loss never exceed what they set.
      const spec = structuredClone(strategySpecSchema.parse(l.spec));
      if (spec.sizing.mode === "fixed_margin_usd")
        spec.sizing.value = Math.min(spec.sizing.value, body.maxMarginUsd);
      spec.risk.maxLossUsd = Math.min(spec.risk.maxLossUsd, body.maxLossUsd);
      spec.name = `${l.title} (clone)`.slice(0, 60);
      const v = validateStrategy(spec, { markets: await limits() });
      if (!v.ok || !v.spec) {
        return reply.code(400).send({
          error: v.issues[0]?.message ?? "These limits don't work with this strategy",
          code: "limits_conflict",
          issues: v.issues,
        });
      }

      const ins = await d.pool.query(
        "INSERT INTO strategies (user_id, name, spec, source, cloned_from_listing, cloned_from_version) VALUES ($1,$2,$3,'clone',$4,$5) RETURNING id",
        [user.id, v.spec.name, JSON.stringify(v.spec), l.id, l.version],
      );
      const strategyId = ins.rows[0].id as string;
      const out: Record<string, unknown> = { strategyId, terms: terms(l), spec: v.spec };

      if (body.mode === "paper") {
        const s = await d.pool.query(
          `INSERT INTO paper_sessions (user_id, strategy_id, name, spec, params, start_equity, started_ms, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            user.id,
            strategyId,
            v.spec.name,
            JSON.stringify(v.spec),
            JSON.stringify({ slippageBps: 5 }),
            10_000,
            Date.now(),
            JSON.stringify(initialState(10_000)),
          ],
        );
        out.paperId = s.rows[0].id;
      }
      if (body.mode === "live") {
        let captured: { status: number; body: unknown } = { status: 500, body: null };
        const fake = {
          code: (status: number) => ({
            send: (b: unknown) => {
              captured = { status, body: b };
              return b;
            },
          }),
        };
        await startLive(
          d,
          user.id,
          strategyId,
          {
            maxMarginUsd: body.maxMarginUsd,
            maxLossUsd: body.maxLossUsd,
            acknowledge: true,
            subAccountId: body.subAccountId,
          },
          fake,
        );
        // The clone is kept even if the live run can't start (for example no balance yet): the reason comes back.
        if (captured.status === 201) out.live = { ok: true, ...(captured.body as object) };
        else out.live = { ok: false, status: captured.status, ...(captured.body as object) };
      }
      return reply.code(201).send(out);
    },
  );

  // ── Creator earnings ──

  app.get("/v1/creator/earnings", auth, async (req) => {
    const uid = req.user!.id;
    const t = await d.pool.query(
      `SELECT COALESCE(sum(creator_amount) FILTER (WHERE status = 'accrued'), 0) AS accrued, COALESCE(sum(creator_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
              COALESCE(sum(builder_fee), 0) AS builder_fees, COALESCE(sum(entry_notional + exit_notional), 0) AS volume, count(*) AS trades,
              count(DISTINCT clone_user_id) AS payers
         FROM creator_earnings WHERE creator_id = $1`,
      [uid],
    );
    const per = await d.pool.query(
      `SELECT l.id, l.title, l.status, l.version, l.creator_share_bps,
              COALESCE(sum(e.creator_amount) FILTER (WHERE e.status = 'accrued'), 0) AS accrued, COALESCE(sum(e.creator_amount) FILTER (WHERE e.status = 'paid'), 0) AS paid,
              COALESCE(sum(e.entry_notional + e.exit_notional), 0) AS volume, count(e.id) AS trades
         FROM listings l LEFT JOIN creator_earnings e ON e.listing_id = l.id WHERE l.creator_id = $1 GROUP BY l.id ORDER BY l.created_at DESC`,
      [uid],
    );
    const cnt = await counts(per.rows.map((r) => r.id));
    const recent = await d.pool.query(
      `SELECT e.id, e.listing_id, l.title, e.creator_amount, e.builder_fee, e.builder_bps, e.creator_share_bps, e.entry_notional, e.exit_notional, e.status, e.accrued_at, e.payout_ref
         FROM creator_earnings e JOIN listings l ON l.id = e.listing_id WHERE e.creator_id = $1 ORDER BY e.id DESC LIMIT 50`,
      [uid],
    );
    const daily = await d.pool.query(
      `SELECT date_trunc('day', accrued_at) AS day, sum(creator_amount) AS amount FROM creator_earnings
        WHERE creator_id = $1 AND accrued_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
      [uid],
    );
    const r = t.rows[0];
    return {
      totals: {
        accrued: String(r.accrued),
        paid: String(r.paid),
        builderFees: String(r.builder_fees),
        volume: String(r.volume),
        trades: Number(r.trades),
        payingClones: Number(r.payers),
      },
      listings: per.rows.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        version: p.version,
        creatorShareBps: p.creator_share_bps,
        accrued: String(p.accrued),
        paid: String(p.paid),
        volume: String(p.volume),
        trades: Number(p.trades),
        ...cnt.get(p.id)!,
      })),
      recent: recent.rows.map((e) => ({
        id: Number(e.id),
        listingId: e.listing_id,
        title: e.title,
        amount: String(e.creator_amount),
        builderFee: String(e.builder_fee),
        builderBps: e.builder_bps,
        shareBps: e.creator_share_bps,
        notional: String(Number(e.entry_notional) + Number(e.exit_notional)),
        status: e.status,
        at: e.accrued_at.getTime(),
        payoutRef: e.payout_ref,
      })),
      daily: daily.rows.map((x) => ({
        day: x.day.toISOString().slice(0, 10),
        amount: String(x.amount),
      })),
      note: "Earnings accrue per closed trade from Strike's fills and TapeVerify's published builder fee. Accruals are paid out by the operator; paid entries show their payout reference.",
    };
  });

  // Operator: mark a creator's accrued earnings as paid, with a reference for the transfer made off-platform.
  app.post(
    "/v1/admin/payouts",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!d.api.adminToken)
        return reply
          .code(503)
          .send({ error: "Operator endpoints are disabled (no ADMIN_TOKEN set)" });
      if (!safeEqual(String(req.headers["x-admin-token"] ?? ""), d.api.adminToken))
        return reply.code(401).send({ error: "Unauthorized" });
      const body = z
        .object({
          creatorId: z.string().uuid(),
          reference: z.string().min(3).max(100),
          upTo: z.string().datetime().optional(),
        })
        .parse(req.body);
      const { rows } = await d.pool.query(
        `UPDATE creator_earnings SET status = 'paid', payout_ref = $2, paid_at = now()
        WHERE creator_id = $1 AND status = 'accrued' AND ($3::timestamptz IS NULL OR accrued_at <= $3) RETURNING creator_amount`,
        [body.creatorId, body.reference, body.upTo ?? null],
      );
      return {
        paid: rows.length,
        amount: String(rows.reduce((s, r) => s + Number(r.creator_amount), 0)),
        reference: body.reference,
        id: randomUUID(),
      };
    },
  );
}
