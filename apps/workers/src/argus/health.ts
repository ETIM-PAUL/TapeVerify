import { assessSlp, parseSlp, type SlpVault } from "@pit/argus";
import type { StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { errMsg, type Logger } from "../log.js";

const DAY = 86_400_000;

/**
 * Samples Strike's protocol vault (SLP), the fund that backstops liquidations, and rates it against its own
 * state a day ago. Locker contract balances and total liabilities are not published by Strike, so they are
 * reported as unavailable rather than guessed.
 */
export async function sampleHealth(pool: pg.Pool, client: StrikeClient, now = Date.now()) {
  let slp: SlpVault | null = null;
  try {
    const r = await client.publicGet<{ vaults: Array<Record<string, unknown>> }>(
      "/v2/vaults?type=protocol&limit=10",
    );
    slp = parseSlp(
      r.vaults.find((v) => v.type === "protocol" && String(v.name).toUpperCase().includes("SLP")) ??
        r.vaults.find((v) => v.type === "protocol"),
    );
  } catch {
    slp = null;
  }
  const past = (
    await pool.query(
      "SELECT slp FROM health_samples WHERE ts_ms <= $1 AND slp IS NOT NULL ORDER BY ts_ms DESC LIMIT 1",
      [now - DAY],
    )
  ).rows[0]?.slp as SlpVault | undefined;
  const reading = assessSlp(slp, past ?? null);
  await pool.query(
    "INSERT INTO health_samples (ts_ms, slp, status, reasons) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [now, slp ? JSON.stringify(slp) : null, reading.status, JSON.stringify(reading.reasons)],
  );
  await pool.query("DELETE FROM health_samples WHERE ts_ms < $1", [now - 30 * DAY]);
  return { slp, ...reading };
}

export async function healthTick(pool: pg.Pool, client: StrikeClient, log: Logger) {
  try {
    const h = await sampleHealth(pool, client);
    if (h.status === "alert" || h.status === "watch")
      log.warn("strike health", { status: h.status, reasons: h.reasons });
  } catch (e) {
    log.error("health sample failed", { err: errMsg(e) });
  }
}
