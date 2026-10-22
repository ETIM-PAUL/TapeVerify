import { CLEAR_BELOW, levelFor, usedFraction } from "@pit/argus";
import { getAccountPositions, getMarkPrice, type StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { errMsg, type Logger } from "../log.js";

const ORDER = { warn: 1, danger: 2, critical: 3 } as const;

/**
 * Watches copied positions that are open. Alerts are scale-free (how much of the runway from entry to
 * liquidation the mark has used), so they fit any leverage. One alert per follow: it escalates in place
 * and resolves when the position is closed or has clearly recovered.
 */
export async function checkLiquidations(
  pool: pg.Pool,
  client: StrikeClient,
  log?: Logger,
  now = Date.now(),
) {
  const { rows } = await pool.query(
    `SELECT f.id, f.user_id, f.symbol, f.side, u.strike_account_id
       FROM follows f JOIN users u ON u.id = f.user_id
      WHERE f.status = 'open' AND u.strike_account_id IS NOT NULL`,
  );
  const marks = new Map<string, number>();
  const mark = async (symbol: string) => {
    const hit = marks.get(symbol);
    if (hit !== undefined) return hit;
    const m = Number((await getMarkPrice(client, symbol)).p);
    marks.set(symbol, m);
    return m;
  };
  const stillOpen = new Set<string>();
  let raised = 0;
  for (const f of rows) {
    stillOpen.add(f.id);
    try {
      const pos = (await getAccountPositions(client, f.strike_account_id, f.symbol))[0];
      if (!pos) continue;
      const side = Number(pos.size) > 0 ? "long" : "short";
      const markPrice = await mark(f.symbol);
      const entry = Number(pos.entry_price);
      const liq = Number(pos.liquidation_price);
      const used = usedFraction({ side, entryPrice: entry, markPrice, liqPrice: liq });
      if (used === null) continue;
      const level = levelFor(used);
      const open = (
        await pool.query(
          "SELECT id, level FROM liquidation_alerts WHERE follow_id = $1 AND resolved_ms IS NULL",
          [f.id],
        )
      ).rows[0];
      if (!open) {
        if (!level) continue;
        await pool.query(
          `INSERT INTO liquidation_alerts (user_id, follow_id, symbol, level, entry_price, mark_price, liq_price, used, created_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [f.user_id, f.id, f.symbol, level, entry, markPrice, liq, used, now],
        );
        raised++;
      } else if (!level && used < CLEAR_BELOW) {
        await pool.query(
          "UPDATE liquidation_alerts SET resolved_ms = $2, resolution = 'recovered' WHERE id = $1",
          [open.id, now],
        );
      } else {
        // Keep the alert; escalate if it got worse, and keep the numbers current.
        const next =
          level && ORDER[level] > ORDER[open.level as keyof typeof ORDER] ? level : open.level;
        await pool.query(
          "UPDATE liquidation_alerts SET level = $2, mark_price = $3, liq_price = $4, used = $5 WHERE id = $1",
          [open.id, next, markPrice, liq, used],
        );
      }
    } catch (e) {
      log?.warn("liquidation check failed", { follow: f.id, err: errMsg(e) });
    }
  }
  // Positions that were copied and are now closed need no further warnings.
  await pool.query(
    `UPDATE liquidation_alerts a SET resolved_ms = $1, resolution = 'closed'
      WHERE a.resolved_ms IS NULL AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.id = a.follow_id AND f.status = 'open')`,
    [now],
  );
  if (raised) log?.warn("liquidation alerts raised", { raised });
  return raised;
}
