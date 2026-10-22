import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(pool: pg.Pool, userId: string, ttlMs: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    hash(token),
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function userForSession(pool: pg.Pool, token: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.chain, u.address, u.handle
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  );
  return (rows[0] as SessionUser | undefined) ?? null;
}

export interface SessionUser {
  id: string;
  chain: "cardano" | "ethereum" | "solana";
  address: string;
  handle: string | null;
}

export async function deleteSession(pool: pg.Pool, token: string) {
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hash(token)]);
}
