import { randomUUID } from "node:crypto";
import type { SealedSecret } from "@pit/shared";
import {
  generateApiWalletKeys,
  requestBuilderSignature,
  verifyBuilderSignature,
} from "@pit/strike-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeAddress } from "../addresses.js";
import type { AppDeps } from "../app.js";
import { recordLogin } from "../argus.js";
import { createSession, deleteSession } from "../sessions.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

const challengeBody = z.object({
  chain: z.enum(["cardano", "ethereum", "solana"]),
  address: z.string().min(20).max(120),
});
const verifyBody = z.object({
  nonce: z.string().min(8).max(100),
  signature: z.string().min(8).max(4096),
});

const limit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export function authRoutes(app: FastifyInstance, d: AppDeps) {
  const network = d.gateway.cfg.network;

  // Step 1: generate the API wallet server-side (key sealed immediately), ask Strike for a challenge.
  app.post("/v1/auth/challenge", { config: limit }, async (req, reply) => {
    const body = challengeBody.parse(req.body);
    let address: string;
    try {
      address = normalizeAddress(body.chain, body.address, network);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const keys = generateApiWalletKeys();
    const feeShareBps = d.gateway.cfg.builderFeeBps;
    const strike = await d.gateway.anon();
    const ch = await requestBuilderSignature(strike, {
      address,
      chain: body.chain,
      publicKey: keys.publicKey,
      builderCode: d.gateway.cfg.builderCode,
      feeShareBps,
    });

    const sealed = d.vault.seal(keys.privateKey, `pending_connect:${ch.nonce}`);
    await d.pool.query(
      `INSERT INTO pending_connects (nonce, chain, address, public_key, sealed_private_key, fee_share_bps, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ch.nonce,
        body.chain,
        address,
        keys.publicKey,
        sealed,
        feeShareBps,
        new Date(Date.now() + CHALLENGE_TTL_MS),
      ],
    );
    // Clean up stale challenges opportunistically.
    await d.pool.query("DELETE FROM pending_connects WHERE expires_at < now()");

    return { nonce: ch.nonce, message: ch.message_to_sign, feeShareBps };
  });

  // Step 2: wallet signature -> Strike verifies -> persist user + sealed API wallet -> session cookie.
  app.post("/v1/auth/verify", { config: limit }, async (req, reply) => {
    const body = verifyBody.parse(req.body);

    // Single use: consume the pending challenge atomically.
    const { rows } = await d.pool.query(
      "DELETE FROM pending_connects WHERE nonce = $1 AND expires_at > now() RETURNING *",
      [body.nonce],
    );
    const p = rows[0];
    if (!p) return reply.code(400).send({ error: "Challenge expired or already used" });

    const privateKey = d.vault
      .open(p.sealed_private_key as SealedSecret, `pending_connect:${p.nonce}`)
      .reveal();
    const strike = await d.gateway.anon();
    const result = await verifyBuilderSignature(strike, {
      nonce: body.nonce,
      walletSignature: body.signature,
    });
    if (result.api_wallet_public_key !== p.public_key) {
      return reply.code(502).send({ error: "Strike returned an unexpected API wallet" });
    }

    const client = await d.pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query(
        `INSERT INTO users (chain, address, strike_account_id) VALUES ($1, $2, $3)
         ON CONFLICT (chain, address) DO UPDATE SET strike_account_id = EXCLUDED.strike_account_id
         RETURNING id, chain, address, handle`,
        [p.chain, p.address, result.account_id],
      );
      const user = u.rows[0];
      // Strike revokes earlier API wallets for this account + builder code on connect; mirror that.
      await client.query(
        "UPDATE api_wallets SET revoked_at = now() WHERE user_id = $1 AND network = $2 AND revoked_at IS NULL",
        [user.id, network],
      );
      const walletId = randomUUID();
      const sealed = d.vault.seal(privateKey, `api_wallet:${walletId}`);
      const expires =
        result.api_wallet_expired_at && !result.api_wallet_expired_at.startsWith("9999")
          ? result.api_wallet_expired_at
          : null;
      await client.query(
        `INSERT INTO api_wallets (id, user_id, network, public_key, sealed_private_key, kek_id, fee_share_bps, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          walletId,
          user.id,
          network,
          p.public_key,
          sealed,
          sealed.kekId,
          result.fee_share_bps,
          expires,
        ],
      );
      await client.query("COMMIT");

      const session = await createSession(d.pool, user.id, d.api.sessionTtlMs);
      await recordLogin(d.pool, d.api.argusSalt, user.id, req.ip, req.headers["user-agent"]).catch(
        () => {},
      );
      reply.setCookie("pit_session", session.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: d.api.secureCookies,
        path: "/",
        expires: session.expiresAt,
      });
      return { user };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies.pit_session;
    if (token) await deleteSession(d.pool, token);
    reply.clearCookie("pit_session", { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", { preHandler: d.requireUser }, async (req) => ({ user: req.user }));
}
