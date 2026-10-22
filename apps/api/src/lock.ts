import { isLocked } from "@tapeverify/shared";
import type pg from "pg";

export interface LockRow {
  user_id: string;
  premium: boolean;
  status: string;
  public_at_ms: string | null;
}

export const lockedNow = (r: LockRow, now = Date.now()) =>
  isLocked(
    {
      premium: r.premium,
      status: r.status,
      publicAtMs: r.public_at_ms === null ? null : Number(r.public_at_ms),
    },
    now,
  );

/** The creators this person has an active subscription to. */
export async function activeSubscriptions(
  pool: pg.Pool,
  userId: string | null | undefined,
  now = Date.now(),
): Promise<Set<string>> {
  if (!userId) return new Set();
  const { rows } = await pool.query(
    "SELECT creator_id FROM subscriptions WHERE subscriber_id = $1 AND ends_ms > $2",
    [userId, now],
  );
  return new Set(rows.map((r) => r.creator_id as string));
}

/** A locked call is visible to its creator and to people with an active subscription to them. */
export async function canSeeCall(
  pool: pg.Pool,
  viewerId: string | null | undefined,
  r: LockRow,
  now = Date.now(),
): Promise<boolean> {
  if (!lockedNow(r, now)) return true;
  if (!viewerId) return false;
  if (viewerId === r.user_id) return true;
  return (await activeSubscriptions(pool, viewerId, now)).has(r.user_id);
}

export async function planFor(pool: pg.Pool, creatorId: string) {
  const r = (
    await pool.query(
      "SELECT price_usdc, period_days, active FROM subscription_plans WHERE creator_id = $1",
      [creatorId],
    )
  ).rows[0];
  return r && r.active
    ? { priceUsdc: String(r.price_usdc), periodDays: Number(r.period_days) }
    : null;
}
