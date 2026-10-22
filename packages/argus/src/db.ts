import { computeStats, loadTradersData } from "@pit/shared";
import type pg from "pg";
import { type CallFacts, detectFrontRunning } from "./frontrun.js";
import { cleanRecord, type FindingRecord, type FindingStatus, reputation } from "./reputation.js";
import { detectSelfTrading, type FillFacts } from "./selftrade.js";
import { detectSybilFollowers, type FollowerFacts } from "./sybil.js";
import type { FindingDraft } from "./types.js";

const DAY = 86_400_000;

export interface DetectionWindow {
  calls: number;
  fills: number;
  logins: number;
}
export const DEFAULT_WINDOW: DetectionWindow = {
  calls: 180 * DAY,
  fills: 90 * DAY,
  logins: 90 * DAY,
};

/** Closed calls with the follows made on them, from Strike-derived fields only. */
export async function loadCallFacts(
  pool: pg.Pool,
  now: number,
  win = DEFAULT_WINDOW,
): Promise<CallFacts[]> {
  const { rows } = await pool.query(
    `SELECT id, user_id, side, entry_ts_ms, entry_price, exit_ts_ms, exit_price, exit_reason FROM calls
      WHERE status = 'closed' AND entry_price IS NOT NULL AND exit_price IS NOT NULL AND exit_ts_ms > $1`,
    [now - win.calls],
  );
  if (rows.length === 0) return [];
  const f = await pool.query(
    `SELECT id, call_id, user_id, entry_ts_ms, entry_price FROM follows
      WHERE call_id = ANY($1) AND status IN ('open', 'closed') AND entry_price IS NOT NULL`,
    [rows.map((r) => r.id)],
  );
  const by = new Map<string, CallFacts["follows"]>();
  for (const r of f.rows) {
    by.set(r.call_id, [
      ...(by.get(r.call_id) ?? []),
      {
        followId: r.id,
        followerId: r.user_id,
        entryTs: Number(r.entry_ts_ms),
        entryPrice: Number(r.entry_price),
      },
    ]);
  }
  return rows.map((c) => ({
    callId: c.id,
    callerId: c.user_id,
    side: c.side,
    entryTs: Number(c.entry_ts_ms),
    entryPrice: Number(c.entry_price),
    exitTs: Number(c.exit_ts_ms),
    exitPrice: Number(c.exit_price),
    exitReason: c.exit_reason,
    follows: by.get(c.id) ?? [],
  }));
}

export async function loadFillFacts(pool: pg.Pool, now: number, win = DEFAULT_WINDOW) {
  const { rows } = await pool.query(
    `SELECT f.account_id, f.trade_id, f.symbol, f.side, f.role, f.price, f.size, f.ts_ms, u.id AS user_id
       FROM fills f JOIN users u ON u.strike_account_id = f.account_id WHERE f.ts_ms > $1`,
    [now - win.fills],
  );
  const fills: FillFacts[] = rows.map((r) => ({
    userId: r.user_id,
    accountId: r.account_id,
    tradeId: Number(r.trade_id),
    symbol: r.symbol,
    side: r.side,
    role: r.role,
    price: Number(r.price),
    size: Number(r.size),
    ts: Number(r.ts_ms),
  }));
  const accountVolume = new Map<string, number>();
  for (const f of fills)
    accountVolume.set(f.accountId, (accountVolume.get(f.accountId) ?? 0) + f.price * f.size);
  const symbols = [...new Set(fills.map((f) => f.symbol))];
  const marketVolume = new Map<string, number>();
  if (symbols.length) {
    const m = await pool.query(
      `SELECT symbol, sum(quote_volume) AS v FROM candles WHERE symbol = ANY($1) AND interval = '1d' AND price_type = 'last' AND open_time > $2 GROUP BY symbol`,
      [symbols, now - win.fills - DAY],
    );
    for (const r of m.rows) marketVolume.set(r.symbol, Number(r.v));
  }
  return { fills, accountVolume, marketVolume };
}

/** Followers of each caller with what is known about how they look and behave. */
export async function loadSybilFacts(pool: pg.Pool, now: number, win = DEFAULT_WINDOW) {
  const { rows } = await pool.query(
    `SELECT c.user_id AS caller_id, f.user_id AS follower_id, f.margin_usd, f.requested_ms, c.entry_ts_ms AS call_entry
       FROM follows f JOIN calls c ON c.id = f.call_id WHERE f.status <> 'failed' AND f.created_at > to_timestamp($1 / 1000.0)`,
    [now - win.calls],
  );
  if (rows.length === 0) return [];
  const followerIds = [...new Set(rows.map((r) => r.follower_id as string))];
  const users = await pool.query(
    "SELECT id, strike_account_id, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms FROM users WHERE id = ANY($1)",
    [followerIds],
  );
  const ips = await pool.query(
    "SELECT DISTINCT user_id, ip_hash FROM login_events WHERE user_id = ANY($1) AND ts_ms > $2",
    [followerIds, now - win.logins],
  );
  const accounts = users.rows.map((u) => u.strike_account_id).filter(Boolean);
  const deps = accounts.length
    ? await pool.query(
        "SELECT account_id, ts_ms, amount FROM account_transactions WHERE account_id = ANY($1) AND type = 'deposit' AND status NOT IN ('failed', 'cancelled', 'canceled')",
        [accounts],
      )
    : { rows: [] as Array<{ account_id: string; ts_ms: string; amount: string }> };
  const callers = await pool.query(
    "SELECT f.user_id, count(DISTINCT c.user_id) AS n FROM follows f JOIN calls c ON c.id = f.call_id WHERE f.user_id = ANY($1) AND f.status <> 'failed' GROUP BY f.user_id",
    [followerIds],
  );

  const FAST_MS = 5_000;
  const facts = new Map<string, FollowerFacts>();
  for (const u of users.rows) {
    facts.set(u.id, {
      userId: u.id,
      createdTs: Number(u.created_ms),
      ipHashes: ips.rows.filter((r) => r.user_id === u.id).map((r) => r.ip_hash),
      deposits: deps.rows
        .filter((d) => d.account_id === u.strike_account_id)
        .map((d) => ({ ts: Number(d.ts_ms), amount: Number(d.amount) })),
      callersFollowed: Number(callers.rows.find((c) => c.user_id === u.id)?.n ?? 0),
      fastFollowShare: 0,
      followMargins: [],
    });
  }
  const perFollower = new Map<string, { fast: number; total: number }>();
  for (const r of rows) {
    const f = facts.get(r.follower_id);
    if (!f) continue;
    f.followMargins.push(Number(r.margin_usd));
    const pf = perFollower.get(r.follower_id) ?? { fast: 0, total: 0 };
    pf.total++;
    if (r.call_entry !== null && Number(r.requested_ms) - Number(r.call_entry) <= FAST_MS)
      pf.fast++;
    perFollower.set(r.follower_id, pf);
  }
  for (const [id, pf] of perFollower)
    (facts.get(id) as FollowerFacts).fastFollowShare = pf.total ? pf.fast / pf.total : 0;

  const byCaller = new Map<string, Set<string>>();
  for (const r of rows)
    byCaller.set(r.caller_id, (byCaller.get(r.caller_id) ?? new Set()).add(r.follower_id));
  return [...byCaller].map(([callerId, set]) => ({
    callerId,
    followers: [...set].map((id) => facts.get(id)).filter((x): x is FollowerFacts => !!x),
  }));
}

export interface DetectionResult {
  raised: number;
  updated: number;
  drafts: number;
}

/** Stores a finding, or refreshes it if the same behaviour was already found. Decided findings keep their status. */
export async function upsertFinding(
  pool: pg.Pool,
  d: FindingDraft,
): Promise<{ id: string; inserted: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO argus_findings (subject_id, kind, severity, base_key, generation, summary, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (base_key, generation) DO UPDATE SET
       evidence = EXCLUDED.evidence, summary = EXCLUDED.summary, updated_at = now(),
       severity = CASE WHEN argus_findings.status = 'open' THEN EXCLUDED.severity ELSE argus_findings.severity END
     RETURNING id, (xmax = 0) AS inserted`,
    [
      d.subjectId,
      d.kind,
      d.severity,
      d.baseKey,
      d.generation,
      d.summary,
      JSON.stringify(d.evidence),
    ],
  );
  const r = rows[0];
  if (r.inserted)
    await pool.query(
      "INSERT INTO argus_events (finding_id, actor, from_status, to_status, note) VALUES ($1, 'argus', NULL, 'open', $2)",
      [r.id, d.summary],
    );
  return { id: r.id as string, inserted: r.inserted as boolean };
}

/** Runs every detector over what's been indexed and records what it finds. */
export async function runDetection(
  pool: pg.Pool,
  now = Date.now(),
  win = DEFAULT_WINDOW,
): Promise<DetectionResult> {
  const drafts: FindingDraft[] = [
    ...detectFrontRunning(await loadCallFacts(pool, now, win)),
    ...(await (async () => {
      const { fills, accountVolume, marketVolume } = await loadFillFacts(pool, now, win);
      return detectSelfTrading(fills, { accountVolume, marketVolume });
    })()),
    ...detectSybilFollowers(await loadSybilFacts(pool, now, win)),
  ];
  let raised = 0;
  for (const d of drafts) {
    try {
      const r = await upsertFinding(pool, d);
      if (r.inserted) raised++;
    } catch (e) {
      if ((e as { code?: string }).code !== "23503") throw e; // the subject was deleted while we worked
    }
  }
  await pool.query("DELETE FROM login_events WHERE ts_ms < $1", [now - win.logins]);
  return { raised, updated: drafts.length - raised, drafts: drafts.length };
}

const toRecord = (r: Record<string, unknown>): FindingRecord => ({
  id: String(r.id),
  kind: r.kind as FindingRecord["kind"],
  severity: r.severity as FindingRecord["severity"],
  status: r.status as FindingStatus,
  summary: String(r.summary),
  baseKey: String(r.base_key),
  generation: Number(r.generation),
  detectedAt: (r.detected_at as Date).getTime(),
});

export async function findingsFor(
  pool: pg.Pool,
  userIds: string[],
): Promise<Map<string, FindingRecord[]>> {
  const out = new Map<string, FindingRecord[]>();
  if (userIds.length === 0) return out;
  const { rows } = await pool.query(
    "SELECT id, subject_id, kind, severity, status, summary, base_key, generation, detected_at FROM argus_findings WHERE subject_id = ANY($1)",
    [userIds],
  );
  for (const r of rows) out.set(r.subject_id, [...(out.get(r.subject_id) ?? []), toRecord(r)]);
  return out;
}

/**
 * Recomputes reputation and the clean-record badge for users (default: everyone with a record or a finding).
 * A change in score is logged, so a drop caused by a finding is visible and attributable.
 */
export async function recomputeReputation(
  pool: pg.Pool,
  userIds?: string[],
  now = Date.now(),
): Promise<number> {
  const ids =
    userIds ??
    (
      await pool.query(
        `SELECT id FROM users WHERE id IN (SELECT subject_id FROM argus_findings)
            OR strike_account_id IN (SELECT DISTINCT account_id FROM trades)`,
      )
    ).rows.map((r) => r.id as string);
  if (ids.length === 0) return 0;
  const users = await pool.query("SELECT id, strike_account_id FROM users WHERE id = ANY($1)", [
    ids,
  ]);
  const accounts = users.rows.map((u) => u.strike_account_id).filter(Boolean) as string[];
  const data = await loadTradersData(pool, accounts);
  const findings = await findingsFor(pool, ids);
  const prev = await pool.query(
    "SELECT user_id, score FROM trader_reputation WHERE user_id = ANY($1)",
    [ids],
  );
  const before = new Map(prev.rows.map((r) => [r.user_id as string, Number(r.score)]));

  let n = 0;
  for (const u of users.rows) {
    const d = u.strike_account_id ? data.get(u.strike_account_id) : undefined;
    const stats = computeStats(d?.trades ?? [], d?.flows ?? []);
    const recs = findings.get(u.id) ?? [];
    const rep = reputation(
      {
        trades: stats.trades,
        totalReturnPct: stats.totalReturnPct,
        maxDrawdownPct: stats.maxDrawdownPct,
        consistency: stats.consistency,
      },
      recs,
    );
    const clean = cleanRecord({
      trades: stats.trades,
      activeDays: stats.activeDays,
      findings: recs,
      now,
    });
    try {
      await pool.query(
        `INSERT INTO trader_reputation (user_id, score, performance, confidence, penalty, clean, clean_reasons, penalties, trades, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (user_id) DO UPDATE SET score = EXCLUDED.score, performance = EXCLUDED.performance, confidence = EXCLUDED.confidence, penalty = EXCLUDED.penalty,
         clean = EXCLUDED.clean, clean_reasons = EXCLUDED.clean_reasons, penalties = EXCLUDED.penalties, trades = EXCLUDED.trades, computed_at = now()`,
        [
          u.id,
          rep.score,
          rep.performance,
          rep.confidence,
          rep.penalty,
          clean.clean,
          JSON.stringify(clean.reasons),
          JSON.stringify(rep.penalties),
          stats.trades,
        ],
      );
      const was = before.get(u.id);
      if (was !== rep.score) {
        const top = rep.penalties[0];
        await pool.query(
          "INSERT INTO reputation_history (user_id, ts_ms, score, previous, reason) VALUES ($1,$2,$3,$4,$5)",
          [
            u.id,
            now,
            rep.score,
            was ?? null,
            was === undefined
              ? "first score"
              : rep.score < was
                ? `penalty: ${top?.kind ?? "recomputed"}`
                : "restored",
          ],
        );
      }
    } catch (e) {
      if ((e as { code?: string }).code === "23503") continue; // the user was deleted while we worked
      throw e;
    }
    n++;
  }
  return n;
}

/** Moves a finding to a new status and logs who did it. Returns ok=false if it wasn't in one of `from`. */
export async function transitionFinding(
  pool: pg.Pool,
  id: string,
  from: FindingStatus[],
  to: FindingStatus,
  actor: string,
  note?: string,
): Promise<{ ok: boolean; subjectId?: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT status, subject_id FROM argus_findings WHERE id = $1 FOR UPDATE",
      [id],
    );
    const row = cur.rows[0];
    if (!row || !from.includes(row.status)) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    await client.query(
      `UPDATE argus_findings SET status = $2, updated_at = now(), review_note = COALESCE($3, review_note),
              resolved_at = CASE WHEN $2 IN ('confirmed', 'dismissed', 'cleared') THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, to, note ?? null],
    );
    await client.query(
      "INSERT INTO argus_events (finding_id, actor, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5)",
      [id, actor, row.status, to, note ?? null],
    );
    await client.query("COMMIT");
    return { ok: true, subjectId: row.subject_id as string };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
