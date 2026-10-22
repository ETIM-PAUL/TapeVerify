import { randomBytes } from "node:crypto";
import { extendSubscription, usdcToBaseUnits } from "@tapeverify/shared";
import { base58Decode } from "@tapeverify/verify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { verifyTokenPayment } from "../solana-pay.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTENT_TTL_MS = 60 * 60_000;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const planBody = z.object({
  priceUsdc: z
    .number()
    .min(1)
    .max(100_000)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "Use at most 2 decimal places"),
  periodDays: z.number().int().min(1).max(365),
  payAddress: z.string().min(32).max(44),
  active: z.boolean(),
});

function validSolanaAddress(a: string): boolean {
  try {
    return base58Decode(a).length === 32;
  } catch {
    return false;
  }
}

export function subscriptionsRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };
  const write = {
    preHandler: d.requireUser,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  };
  const read = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  async function creatorByRef(ref: string) {
    const r = (
      await d.pool.query(
        "SELECT id, handle, address FROM users WHERE lower(handle) = lower($1) OR ($2 AND id = $1::uuid) LIMIT 1",
        [ref, UUID.test(ref)],
      )
    ).rows[0];
    return r
      ? { id: r.id as string, handle: r.handle as string | null, address: r.address as string }
      : null;
  }

  // ── The creator's plan ──

  app.get("/v1/creators/:ref/plan", read, async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const c = await creatorByRef(ref);
    if (!c) return reply.code(404).send({ error: "Creator not found" });
    const plan = (
      await d.pool.query(
        "SELECT price_usdc, period_days, active FROM subscription_plans WHERE creator_id = $1",
        [c.id],
      )
    ).rows[0];
    const now = Date.now();
    const viewer = await d.optionalUser(req);
    const mine = viewer
      ? (
          await d.pool.query(
            "SELECT ends_ms FROM subscriptions WHERE creator_id = $1 AND subscriber_id = $2",
            [c.id, viewer.id],
          )
        ).rows[0]
      : null;
    const count = (
      await d.pool.query(
        "SELECT count(*) AS n FROM subscriptions WHERE creator_id = $1 AND ends_ms > $2",
        [c.id, now],
      )
    ).rows[0].n;
    const premiumOpen = (
      await d.pool.query(
        "SELECT count(*) AS n FROM calls WHERE user_id = $1 AND premium AND status IN ('open', 'pending')",
        [c.id],
      )
    ).rows[0].n;
    return {
      creator: { ref: c.handle ?? c.id, name: c.handle ?? short(c.address) },
      plan: plan?.active
        ? { priceUsdc: String(plan.price_usdc), periodDays: Number(plan.period_days) }
        : null,
      subscribers: Number(count),
      premiumOpen: Number(premiumOpen),
      viewer: viewer
        ? {
            isSelf: viewer.id === c.id,
            subscribed: Boolean(mine && Number(mine.ends_ms) > now),
            endsAt: mine ? Number(mine.ends_ms) : null,
          }
        : null,
    };
  });

  app.put("/v1/me/plan", write, async (req, reply) => {
    const b = planBody.parse(req.body);
    if (!validSolanaAddress(b.payAddress))
      return reply
        .code(400)
        .send({ error: "That isn't a valid Solana address", code: "bad_address" });
    await d.pool.query(
      `INSERT INTO subscription_plans (creator_id, price_usdc, period_days, pay_address, active) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (creator_id) DO UPDATE SET price_usdc = EXCLUDED.price_usdc, period_days = EXCLUDED.period_days, pay_address = EXCLUDED.pay_address, active = EXCLUDED.active, updated_at = now()`,
      [req.user!.id, b.priceUsdc, b.periodDays, b.payAddress, b.active],
    );
    return { ok: true };
  });

  app.get("/v1/me/plan", auth, async (req) => {
    const me = req.user!.id;
    const now = Date.now();
    const plan = (
      await d.pool.query(
        "SELECT price_usdc, period_days, pay_address, active FROM subscription_plans WHERE creator_id = $1",
        [me],
      )
    ).rows[0];
    const subs = await d.pool.query(
      `SELECT s.ends_ms, s.started_ms, u.handle, u.address FROM subscriptions s JOIN users u ON u.id = s.subscriber_id
        WHERE s.creator_id = $1 ORDER BY s.ends_ms DESC LIMIT 200`,
      [me],
    );
    const rev = (
      await d.pool.query(
        "SELECT COALESCE(sum(amount_usdc), 0) AS total, count(*) AS n FROM subscription_payments WHERE creator_id = $1 AND status = 'paid'",
        [me],
      )
    ).rows[0];
    const pays = await d.pool.query(
      `SELECT p.amount_usdc, p.paid_ms, p.signature, u.handle, u.address FROM subscription_payments p JOIN users u ON u.id = p.subscriber_id
        WHERE p.creator_id = $1 AND p.status = 'paid' ORDER BY p.paid_ms DESC LIMIT 20`,
      [me],
    );
    return {
      plan: plan
        ? {
            priceUsdc: String(plan.price_usdc),
            periodDays: Number(plan.period_days),
            payAddress: plan.pay_address,
            active: plan.active,
          }
        : null,
      activeSubscribers: subs.rows.filter((r) => Number(r.ends_ms) > now).length,
      subscribers: subs.rows.map((r) => ({
        name: r.handle ?? short(r.address),
        endsAt: Number(r.ends_ms),
        active: Number(r.ends_ms) > now,
      })),
      revenueUsdc: String(rev.total),
      payments: Number(rev.n),
      recent: pays.rows.map((r) => ({
        name: r.handle ?? short(r.address),
        amountUsdc: String(r.amount_usdc),
        at: Number(r.paid_ms),
        signature: r.signature,
      })),
      network: d.gateway.cfg.network,
    };
  });

  // ── Subscribing: start a payment, pay on-chain, then prove it ──

  app.post("/v1/creators/:ref/subscribe", write, async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const me = req.user!.id;
    const c = await creatorByRef(ref);
    if (!c) return reply.code(404).send({ error: "Creator not found" });
    if (c.id === me)
      return reply.code(409).send({ error: "You can't subscribe to yourself", code: "self" });
    const plan = (
      await d.pool.query(
        "SELECT price_usdc, period_days, pay_address FROM subscription_plans WHERE creator_id = $1 AND active",
        [c.id],
      )
    ).rows[0];
    if (!plan)
      return reply
        .code(409)
        .send({ error: "This creator has no subscription open", code: "no_plan" });
    const now = Date.now();

    const same = (
      await d.pool.query(
        `SELECT * FROM subscription_payments WHERE creator_id = $1 AND subscriber_id = $2 AND status = 'awaiting' AND expires_ms > $3
            AND amount_usdc = $4 AND pay_address = $5 AND mint = $6 ORDER BY created_ms DESC LIMIT 1`,
        [c.id, me, now, plan.price_usdc, plan.pay_address, d.api.usdcMint],
      )
    ).rows[0];
    let row = same;
    if (!row) {
      const reference = `TV-${[...randomBytes(8)].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("")}`;
      row = (
        await d.pool.query(
          `INSERT INTO subscription_payments (creator_id, subscriber_id, amount_usdc, period_days, pay_address, mint, reference, created_ms, expires_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            c.id,
            me,
            plan.price_usdc,
            plan.period_days,
            plan.pay_address,
            d.api.usdcMint,
            reference,
            now,
            now + INTENT_TTL_MS,
          ],
        )
      ).rows[0];
    }
    return reply.code(201).send({
      paymentId: row.id,
      pay: {
        address: row.pay_address,
        amountUsdc: String(row.amount_usdc),
        mint: row.mint,
        memo: row.reference,
        chain: "solana",
        network: d.gateway.cfg.network,
      },
      periodDays: row.period_days,
      expiresAt: Number(row.expires_ms),
      steps: [
        `Send at least ${String(row.amount_usdc)} USDC on Solana to the address above.`,
        `Add this memo to the transaction: ${row.reference}`,
        "Then paste the transaction signature here. Tape checks it on-chain; it never holds your payment.",
      ],
    });
  });

  app.post(
    "/v1/subscriptions/payments/:id/confirm",
    { preHandler: d.requireUser, config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { signature } = z
        .object({
          signature: z
            .string()
            .regex(
              /^[1-9A-HJ-NP-Za-km-z]{64,100}$/,
              "That doesn't look like a transaction signature",
            ),
        })
        .parse(req.body);
      const me = req.user!.id;
      const pay = (
        await d.pool.query(
          "SELECT * FROM subscription_payments WHERE id = $1 AND subscriber_id = $2",
          [id, me],
        )
      ).rows[0];
      if (!pay) return reply.code(404).send({ error: "Payment not found" });
      if (pay.status === "paid") {
        const s = (
          await d.pool.query(
            "SELECT ends_ms FROM subscriptions WHERE creator_id = $1 AND subscriber_id = $2",
            [pay.creator_id, me],
          )
        ).rows[0];
        return { ok: true, endsAt: s ? Number(s.ends_ms) : null, alreadyConfirmed: true };
      }
      if (!d.api.anchorRpcUrl)
        return reply.code(503).send({
          error: "On-chain payments aren't configured on this server",
          code: "not_configured",
        });

      let check: Awaited<ReturnType<typeof verifyTokenPayment>>;
      try {
        check = await verifyTokenPayment(
          d.api.anchorRpcUrl,
          signature,
          {
            recipient: pay.pay_address,
            mint: pay.mint,
            minBaseUnits: usdcToBaseUnits(String(pay.amount_usdc)),
            memo: pay.reference,
            notBeforeMs: Number(pay.created_ms),
          },
          d.fetchImpl ?? fetch,
        );
      } catch (e) {
        return reply.code(502).send({
          error: `Couldn't reach the Solana network: ${(e as Error).message}`,
          code: "chain_unreachable",
        });
      }
      if (!check.ok) return reply.code(422).send({ error: check.message, code: check.code });

      const c = await d.pool.connect();
      try {
        await c.query("BEGIN");
        const upd = await c.query(
          "UPDATE subscription_payments SET status = 'paid', signature = $2, paid_ms = $3, slot = $4 WHERE id = $1 AND status = 'awaiting' RETURNING creator_id, period_days",
          [id, signature, Date.now(), check.slot],
        );
        if (!upd.rows[0]) {
          await c.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: "That payment was already confirmed", code: "already_confirmed" });
        }
        const cur = (
          await c.query(
            "SELECT ends_ms FROM subscriptions WHERE creator_id = $1 AND subscriber_id = $2 FOR UPDATE",
            [pay.creator_id, me],
          )
        ).rows[0];
        const next = extendSubscription(
          cur ? Number(cur.ends_ms) : null,
          Date.now(),
          Number(upd.rows[0].period_days),
        );
        await c.query(
          `INSERT INTO subscriptions (creator_id, subscriber_id, started_ms, ends_ms) VALUES ($1,$2,$3,$4)
         ON CONFLICT (creator_id, subscriber_id) DO UPDATE SET ends_ms = EXCLUDED.ends_ms`,
          [pay.creator_id, me, next.startedMs, next.endsMs],
        );
        await c.query("COMMIT");
        await d.pool.query(
          `INSERT INTO notifications (user_id, kind, ref, title, body, url) VALUES ($1,'new_follower',$2,'New subscriber',$3,NULL) ON CONFLICT DO NOTHING`,
          [
            pay.creator_id,
            `sub:${id}`,
            `${(req.user as { handle?: string | null }).handle ?? short(req.user!.address)} subscribed for ${upd.rows[0].period_days} days.`,
          ],
        );
        return { ok: true, endsAt: next.endsMs };
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        if ((e as { code?: string }).code === "23505")
          return reply.code(409).send({
            error: "That transaction has already paid for a subscription",
            code: "signature_used",
          });
        throw e;
      } finally {
        c.release();
      }
    },
  );

  app.get("/v1/me/subscriptions", auth, async (req) => {
    const now = Date.now();
    const { rows } = await d.pool.query(
      `SELECT s.creator_id, s.ends_ms, u.handle, u.address,
              (SELECT count(*) FROM calls c WHERE c.user_id = s.creator_id AND c.premium AND c.status IN ('open', 'pending')) AS premium_open
         FROM subscriptions s JOIN users u ON u.id = s.creator_id WHERE s.subscriber_id = $1 ORDER BY s.ends_ms DESC`,
      [req.user!.id],
    );
    return {
      subscriptions: rows.map((r) => ({
        ref: r.handle ?? r.creator_id,
        name: r.handle ?? short(r.address),
        endsAt: Number(r.ends_ms),
        active: Number(r.ends_ms) > now,
        premiumOpen: Number(r.premium_open),
      })),
    };
  });
}
