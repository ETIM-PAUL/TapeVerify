import {
  buildDepositTx,
  confirmDeposit,
  confirmWithdraw,
  DEPOSIT_ASSETS,
  getDepositQuote,
  getPortfolio,
  getWithdrawQuote,
  StrikeApiError,
  toBaseUnits,
} from "@tapeverify/strike-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";

/** Strike's documented minimum deposit and withdrawal, USD. The deposit minimum is read from Strike when it can be. */
const MIN_USD = 5;

const trim = (n: number, places: number) => n.toFixed(places).replace(/\.?0+$/, "");

/** An amount of the asset that clears the minimum with a little room, rounded up so it never falls just short. */
export function suggestAmount(minUsd: number, usdPerUnit: number): string | null {
  if (!(usdPerUnit > 0)) return null;
  const need = (minUsd / usdPerUnit) * 1.005;
  return need >= 1 ? trim(Math.ceil(need * 100) / 100, 2) : trim(Math.ceil(need * 1e6) / 1e6, 6);
}

const usd = z.string().regex(/^\d+(\.\d{1,2})?$/, "Invalid USD amount");

export function fundsRoutes(app: FastifyInstance, d: AppDeps) {
  const guard = {
    preHandler: d.requireUser,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };

  // Strike publishes the minimum it will credit; a deposit below it can't be credited, so it is refused before any money moves.
  const minCache = new Map<string, { at: number; usd: number }>();
  async function minDepositUsd(userId: string): Promise<number> {
    const hit = minCache.get(userId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.usd;
    let usd = MIN_USD;
    try {
      const p = await d.gateway.run(userId, (c) => getPortfolio(c));
      const n = Number((p as { min_deposit_usd?: unknown }).min_deposit_usd);
      if (Number.isFinite(n) && n > 0) usd = n;
    } catch {
      /* fall back to the documented minimum */
    }
    minCache.set(userId, { at: Date.now(), usd });
    return usd;
  }

  // ── Deposit: quote -> build-tx -> (wallet signs + submits) -> confirm ──

  app.post("/v1/deposit/quote", guard, async (req, reply) => {
    const user = req.user!;
    const body = z
      .object({ asset: z.string().max(10), amount: z.string().max(40) })
      .parse(req.body);
    const decimals = DEPOSIT_ASSETS[user.chain][body.asset];
    if (decimals === undefined)
      return reply.code(400).send({ error: `${body.asset} is not depositable on ${user.chain}` });
    let assetAmount: string;
    try {
      assetAmount = toBaseUnits(body.amount, decimals);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const q = await d.gateway.run(user.id, (c) =>
      getDepositQuote(c, {
        blockchain: user.chain,
        asset_symbol: body.asset,
        asset_amount: assetAmount,
      }),
    );
    const minUsd = await minDepositUsd(user.id);
    const usdValue = Number(q.quote.usd_value);
    if (usdValue < minUsd) {
      const perUnit = usdValue / Number(body.amount);
      const suggested = suggestAmount(minUsd, perUnit);
      return reply.code(400).send({
        error: `Minimum deposit is $${minUsd}. ${body.amount} ${body.asset} is worth $${trim(usdValue, 4)} at the current rate${suggested ? `, so try about ${suggested} ${body.asset}` : ""}.`,
        code: "below_minimum",
        minUsd,
        usdValue,
        suggestedAmount: suggested,
      });
    }
    await d.pool.query(
      `INSERT INTO deposits (request_id, user_id, chain, asset_symbol, asset_amount, usd_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [q.request_id, user.id, user.chain, body.asset, assetAmount, q.quote.usd_value],
    );
    return {
      requestId: q.request_id,
      usdValue: q.quote.usd_value,
      assetAmount,
      asset: body.asset,
      depositAddress: q.deposit_address,
      confirmationsRequired: q.confirmations_required,
      expiresAt: q.quote.expiration_at,
    };
  });

  app.post("/v1/deposit/build", guard, async (req, reply) => {
    const user = req.user!;
    const body = z
      .object({
        requestId: z.string().max(100),
        utxos: z.array(z.string().max(4096)).max(500).optional(),
      })
      .parse(req.body);
    const dep = await ownedDeposit(d, user.id, body.requestId);
    if (!dep || dep.status !== "quoted") return reply.code(404).send({ error: "Quote not found" });
    if (user.chain === "cardano" && !body.utxos?.length) {
      return reply.code(400).send({ error: "Cardano deposits require wallet UTxOs" });
    }
    // user_address is always the connected wallet: funds can't be pulled from anywhere else.
    return d.gateway.run(user.id, (c) =>
      buildDepositTx(c, {
        request_id: body.requestId,
        user_address: user.address,
        utxos: body.utxos,
      }),
    );
  });

  app.post("/v1/deposit/confirm", guard, async (req, reply) => {
    const user = req.user!;
    const body = z
      .object({ requestId: z.string().max(100), txHash: z.string().min(10).max(200) })
      .parse(req.body);
    const dep = await ownedDeposit(d, user.id, body.requestId);
    if (!dep) return reply.code(404).send({ error: "Quote not found" });
    try {
      await d.gateway.run(user.id, (c) =>
        confirmDeposit(c, { request_id: body.requestId, tx_hash: body.txHash }),
      );
    } catch (e) {
      if (!(e instanceof StrikeApiError && e.status === 409)) throw e; // 409: already submitted
    }
    await d.pool.query(
      "UPDATE deposits SET status = 'submitted', tx_hash = $2, updated_at = now() WHERE request_id = $1",
      [body.requestId, body.txHash],
    );
    return { status: "pending" };
  });

  // ── Withdraw: quote -> (wallet signs message) -> confirm. Destination is always the connected wallet. ──

  app.post("/v1/withdraw/quote", guard, async (req, reply) => {
    const user = req.user!;
    const body = z
      .object({ usd: usd, asset: z.string().regex(/^[A-Za-z0-9]{2,10}$/) })
      .parse(req.body);
    if (Number(body.usd) < MIN_USD)
      return reply.code(400).send({ error: `Minimum withdrawal is $${MIN_USD}` });
    const q = await d.gateway.run(user.id, (c) =>
      getWithdrawQuote(c, {
        usd_value: body.usd,
        blockchain: user.chain,
        asset: body.asset,
        wallet_address: user.address,
      }),
    );
    await d.pool.query(
      `INSERT INTO withdrawals (withdraw_id, user_id, chain, asset, usd_value, fee) VALUES ($1, $2, $3, $4, $5, $6)`,
      [q.withdraw_id, user.id, user.chain, body.asset, body.usd, q.fee],
    );
    return {
      withdrawId: q.withdraw_id,
      fee: q.fee,
      messageToSign: q.message_to_sign,
      txCbor: q.tx_cbor ?? null,
      // Cardano message_to_sign is already hex; the web app must not hex-encode it again.
      payloadIsHex: user.chain === "cardano",
    };
  });

  app.post("/v1/withdraw/confirm", guard, async (req, reply) => {
    const user = req.user!;
    const body = z
      .object({
        withdrawId: z.string().max(100),
        signature: z.string().min(8).max(8192),
        signedTxCbor: z.string().max(65536).optional(),
      })
      .parse(req.body);
    // Atomically claim the quote so a replayed confirm can't double-submit.
    const { rows } = await d.pool.query(
      `UPDATE withdrawals SET status = 'submitted', updated_at = now()
        WHERE withdraw_id = $1 AND user_id = $2 AND status = 'quoted' RETURNING withdraw_id`,
      [body.withdrawId, user.id],
    );
    if (!rows[0])
      return reply.code(404).send({ error: "Withdrawal quote not found or already used" });
    try {
      const r = await d.gateway.run(user.id, (c) =>
        confirmWithdraw(c, {
          withdraw_id: body.withdrawId,
          wallet_signature: body.signature,
          signed_tx_cbor: body.signedTxCbor,
        }),
      );
      return { status: r.status };
    } catch (e) {
      await d.pool.query(
        "UPDATE withdrawals SET status = 'failed', updated_at = now() WHERE withdraw_id = $1",
        [body.withdrawId],
      );
      throw e;
    }
  });
}

async function ownedDeposit(d: AppDeps, userId: string, requestId: string) {
  const { rows } = await d.pool.query(
    "SELECT status FROM deposits WHERE request_id = $1 AND user_id = $2",
    [requestId, userId],
  );
  return (rows[0] as { status: string } | undefined) ?? null;
}
