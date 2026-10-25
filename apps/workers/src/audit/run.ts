import {
  type AuditFinding,
  type AuditReport,
  type AuditSelector,
  auditKey,
  L3Book,
  type L3BookSnapshot,
  type L3UpdateMessage,
} from "@tapeverify/shared";
import type pg from "pg";
import { l3Coverage } from "../l3/rebuild.js";
import { errMsg, type Logger } from "../log.js";
import { type BookUpdate, checkFillAgainstBook, checkOrders } from "./checks.js";
import {
  AuditError,
  ExportUnavailable,
  exportRows,
  type HistFill,
  type HistOrder,
  pageHistory,
  resolveSelector,
  toFill,
  toOrder,
} from "./fetch.js";

const DAY = 86_400_000;
const WINDOW_MS = 7 * DAY;
/** Most fills read, and most checked against the book, in one audit. */
const MAX_FILLS = 100_000;
const MAX_CHECKED = 20_000;
const MAX_ORDERS = 200_000;
const MAX_FINDINGS_LISTED = 50;
const BATCH = 5000;

export interface AuditDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  exportTimeoutMs?: number;
  exportPollMs?: number;
  log?: Logger;
}

interface Target {
  fill: HistFill;
  segmentId: number;
  sequence: number;
  update: BookUpdate;
}

const REASON = {
  outside: "outside the period the order book was recorded",
  noBook: "trade not found in the recorded order book",
  noSnapshot: "no recorded book snapshot before the trade",
  replay: "recorded order book could not be replayed to that point",
  unseen: "resting order not in the replayed book",
};

/** Looks each fill's trade up in the recorded book: the resting order the book says was hit. */
async function findTargets(
  pool: pg.Pool,
  symbol: string,
  fills: HistFill[],
): Promise<{ targets: Target[]; missing: HistFill[] }> {
  const byTrade = new Map<string, HistFill[]>();
  for (const f of fills) {
    const l = byTrade.get(f.trade_id);
    if (l) l.push(f);
    else byTrade.set(f.trade_id, [f]);
  }
  const ids = [...byTrade.keys()];
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < ids.length; i += 5000) {
    const r = await pool.query(
      `SELECT u.segment_id, u.sequence, u.ts_ms, u.order_id, u.side, u.price, u.delta_size, u.trade_id
         FROM l3_updates u JOIN l3_segments s ON s.id = u.segment_id
        WHERE s.symbol = $1 AND u.trade_id = ANY($2::bigint[]) AND u.action IN ('partial_fill', 'full_fill')`,
      [symbol, ids.slice(i, i + 5000)],
    );
    rows.push(...r.rows);
  }
  const targets: Target[] = [];
  const found = new Set<string>();
  for (const r of rows) {
    const candidates = byTrade.get(String(r.trade_id)) ?? [];
    for (const fill of candidates) {
      if (Math.abs(Number(r.ts_ms) - fill.timestamp) > 10_000) continue;
      found.add(fill.id);
      targets.push({
        fill,
        segmentId: Number(r.segment_id),
        sequence: Number(r.sequence),
        update: {
          orderId: r.order_id as string,
          side: r.side as "buy" | "sell",
          price: r.price as string,
          size: String(Math.abs(Number(r.delta_size))),
        },
      });
    }
  }
  return { targets, missing: fills.filter((f) => !found.has(f.id)) };
}

type Standing = { ahead: number; price: string; bestPrice: string } | null;

/**
 * Replays one recorded segment once, forward, and notes where each target order stood in its queue just before
 * the trade hit it. Returns null for a target if the replay couldn't reach it.
 */
async function standings(
  pool: pg.Pool,
  segmentId: number,
  targets: Target[],
): Promise<Map<number, Standing | "error">> {
  const out = new Map<number, Standing | "error">();
  const want = new Set(targets.map((t) => t.sequence));
  const minSeq = Math.min(...want);
  const maxSeq = Math.max(...want);
  const snap = await pool.query(
    "SELECT last_sequence, book FROM l3_snapshots WHERE segment_id = $1 AND last_sequence < $2 ORDER BY last_sequence DESC LIMIT 1",
    [segmentId, minSeq],
  );
  if (!snap.rows[0]) {
    for (const s of want) out.set(s, "error");
    return out;
  }
  const book = L3Book.fromSnapshot(snap.rows[0].book as L3BookSnapshot);
  let cursor = Number(snap.rows[0].last_sequence);
  try {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT sequence, ts_ms, action, order_id, side, price, remaining_size FROM l3_updates
          WHERE segment_id = $1 AND sequence > $2 AND sequence <= $3 ORDER BY sequence LIMIT $4`,
        [segmentId, cursor, maxSeq, BATCH],
      );
      for (const r of rows) {
        const seq = Number(r.sequence);
        if (want.has(seq)) out.set(seq, book.standing(r.order_id as string));
        book.apply({
          action: r.action,
          sequence: seq,
          timestamp: Number(r.ts_ms),
          order_id: r.order_id ?? undefined,
          side: r.side ?? undefined,
          price: r.price ?? undefined,
          remaining_size: r.remaining_size ?? undefined,
        } as L3UpdateMessage);
        cursor = seq;
      }
      if (rows.length < BATCH) break;
    }
  } catch {
    // The recording is gap-free by construction; if replay still fails, say so rather than guess.
  }
  for (const s of want) if (!out.has(s)) out.set(s, "error");
  return out;
}

export interface BookCheck {
  checked: number;
  clean: number;
  findings: AuditFinding[];
  unverifiable: Map<string, number>;
}

/** Checks every fill of one recorded market against the book: same trade, and price-time priority respected. */
export async function checkAgainstBook(
  pool: pg.Pool,
  symbol: string,
  fills: HistFill[],
): Promise<BookCheck> {
  const res: BookCheck = { checked: 0, clean: 0, findings: [], unverifiable: new Map() };
  const skip = (reason: string, n = 1) =>
    res.unverifiable.set(reason, (res.unverifiable.get(reason) ?? 0) + n);
  const { targets, missing } = await findTargets(pool, symbol, fills);
  if (missing.length) skip(REASON.noBook, missing.length);
  const bySegment = new Map<number, Target[]>();
  for (const t of targets) {
    const l = bySegment.get(t.segmentId);
    if (l) l.push(t);
    else bySegment.set(t.segmentId, [t]);
  }
  for (const [segmentId, list] of bySegment) {
    const stand = await standings(pool, segmentId, list);
    for (const t of list) {
      const s = stand.get(t.sequence);
      if (s === "error" || s === undefined) {
        skip(REASON.replay);
        continue;
      }
      if (s === null) {
        skip(REASON.unseen);
        continue;
      }
      res.checked++;
      const found = checkFillAgainstBook(t.fill, t.update, s);
      if (found.length === 0) res.clean++;
      res.findings.push(...found);
    }
  }
  return res;
}

const uniqById = <T extends { id: string }>(xs: T[]) => [
  ...new Map(xs.map((x) => [x.id, x])).values(),
];

/** Runs one audit end to end and returns the report. */
export async function runAudit(
  pool: pg.Pool,
  selector: AuditSelector,
  deps: AuditDeps,
): Promise<AuditReport> {
  const now = (deps.now ?? Date.now)();
  const f = deps.fetchImpl ?? fetch;
  const notes: string[] = [];
  const resolved = await resolveSelector(deps.baseUrl, selector, f);

  const syms = (
    await pool.query("SELECT DISTINCT symbol FROM l3_segments ORDER BY symbol")
  ).rows.map((r) => r.symbol as string);
  const first = (await pool.query("SELECT min(start_ts) AS t FROM l3_segments")).rows[0]?.t;
  const toMs = now;
  const fromMs = first ? Math.max(now - WINDOW_MS, Number(first)) : now - WINDOW_MS;
  const empty = (): AuditReport => ({
    version: 1,
    generatedMs: now,
    subject: { accountId: resolved.accountId, selector },
    source: "history",
    sourceNote: null,
    window: { fromMs, toMs },
    coverage: [],
    fills: { inWindow: 0, checked: 0, clean: 0, unverifiable: [], truncated: false },
    orders: { checked: 0, consistent: 0, skipped: 0 },
    findings: [],
    findingsTotal: 0,
    verdict: "insufficient_coverage",
    notes,
  });
  if (syms.length === 0) {
    notes.push("TapeVerify has not recorded any order book yet, so nothing can be checked.");
    return empty();
  }

  const coverage = new Map<string, Awaited<ReturnType<typeof l3Coverage>>>();
  for (const s of syms) coverage.set(s, await l3Coverage(pool, s, fromMs, toMs));
  const recorded = new Set(syms);

  // ── Read the account's fills: Strike's bulk export first, the paged history if that can't be used. ──
  let source: "export" | "history" = "export";
  let sourceNote: string | null = null;
  let fillRows: Array<Record<string, unknown>> = [];
  let truncated = false;
  const otherMarkets = new Map<string, number>();
  const exportOpts = {
    timeoutMs: deps.exportTimeoutMs ?? 120_000,
    pollMs: deps.exportPollMs ?? 3_000,
  };
  try {
    const r = await exportRows(
      deps.baseUrl,
      "fills",
      resolved.qs,
      {
        ...exportOpts,
        maxKept: MAX_FILLS,
        keep: (row) => {
          const ts = Number(row.timestamp);
          if (ts < fromMs || ts > toMs) return false;
          const sym = String(row.symbol);
          if (!recorded.has(sym)) {
            otherMarkets.set(sym, (otherMarkets.get(sym) ?? 0) + 1);
            return false;
          }
          return true;
        },
      },
      f,
    );
    fillRows = r.rows;
    truncated = r.truncated;
  } catch (e) {
    if (!(e instanceof ExportUnavailable)) throw e;
    source = "history";
    sourceNote = `Strike's bulk export wasn't available (${e.message}), so the paged history was read instead, for the markets with a recorded order book.`;
    for (const symbol of syms) {
      const r = await pageHistory(
        deps.baseUrl,
        "fill",
        resolved.qs,
        {
          symbol,
          fromMs,
          toMs,
          maxPages: 100,
        },
        f,
      );
      fillRows.push(...r.rows);
      truncated ||= r.truncated;
    }
  }
  const allFills = uniqById(fillRows.map(toFill)).sort((a, b) => b.timestamp - a.timestamp);
  if (truncated)
    notes.push(
      `Only the newest ${allFills.length.toLocaleString("en-US")} fills in the window were read.`,
    );

  // ── Split what can be checked from what can't. ──
  const skipped = new Map<string, number>();
  const skip = (reason: string, n = 1) => skipped.set(reason, (skipped.get(reason) ?? 0) + n);
  for (const [sym, n] of otherMarkets) skip(`no order-book recording for ${sym}`, n);
  const inRecording = (f: HistFill) => {
    const cov = coverage.get(f.symbol);
    return cov?.segments.some((s) => f.timestamp >= s.start && f.timestamp <= (s.end ?? toMs));
  };
  const checkable = allFills.filter((f) => {
    if (inRecording(f)) return true;
    skip(REASON.outside);
    return false;
  });
  const toCheck = checkable.slice(0, MAX_CHECKED);
  if (checkable.length > toCheck.length) {
    truncated = true;
    skip("over the per-audit limit", checkable.length - toCheck.length);
    notes.push(
      `Only the newest ${MAX_CHECKED.toLocaleString("en-US")} fills were checked against the book.`,
    );
  }

  // ── Check them against the recorded order book. ──
  let checked = 0;
  let clean = 0;
  const findings: AuditFinding[] = [];
  for (const symbol of syms) {
    const mine = toCheck.filter((x) => x.symbol === symbol);
    if (mine.length === 0) continue;
    const r = await checkAgainstBook(pool, symbol, mine);
    checked += r.checked;
    clean += r.clean;
    findings.push(...r.findings);
    for (const [reason, n] of r.unverifiable) skip(reason, n);
  }

  // ── Orders: do each order's fills, limit price, timing and status agree with its own record? ──
  let orderRows: Array<Record<string, unknown>> = [];
  if (allFills.length > 0) {
    try {
      if (source === "history") throw new ExportUnavailable("fills already read from history");
      const r = await exportRows(
        deps.baseUrl,
        "orders",
        resolved.qs,
        {
          ...exportOpts,
          maxKept: MAX_ORDERS,
          keep: (row) =>
            recorded.has(String(row.symbol)) &&
            Number(row.create_timestamp) >= fromMs &&
            Number(row.event_timestamp) <= toMs,
        },
        f,
      );
      orderRows = r.rows;
    } catch (e) {
      if (!(e instanceof ExportUnavailable)) throw e;
      if (source === "export")
        notes.push(`Orders were read from the paged history (${e.message}).`);
      for (const symbol of syms) {
        const r = await pageHistory(
          deps.baseUrl,
          "order",
          resolved.qs,
          {
            symbol,
            fromMs,
            toMs,
            maxPages: 100,
          },
          f,
        );
        orderRows.push(...r.rows);
      }
    }
  }
  const oldest = allFills[allFills.length - 1]?.timestamp ?? fromMs;
  const orderFloor = truncated ? Math.max(fromMs, oldest) : fromMs;
  const orders: HistOrder[] = uniqById(orderRows.map(toOrder));
  const oc = checkOrders(orders, allFills, { fromMs: orderFloor, toMs });
  findings.push(...oc.findings);

  findings.sort((a, b) => b.at - a.at);
  const unverifiable = [...skipped].map(([reason, count]) => ({ reason, count }));
  const verdict: AuditReport["verdict"] =
    findings.length > 0
      ? "findings"
      : checked === 0 && oc.checked === 0
        ? "insufficient_coverage"
        : "clean";
  notes.push(
    "The order book shows visible orders only, so hidden liquidity, self-trade prevention and liquidation fills can look like exceptions. A finding is a reason to look closer, not proof of misconduct.",
  );
  notes.push(
    "This checks Strike's published execution record from the side of one account. It is not a replay of the matching engine, which needs the node's message log.",
  );

  const perSymbol = syms
    .map((symbol) => {
      const cov = coverage.get(symbol);
      return {
        symbol,
        recordedMs: cov?.coveredMs ?? 0,
        windowMs: cov?.requestedMs ?? 0,
        gaps: cov?.gaps.length ?? 0,
        fills: allFills.filter((x) => x.symbol === symbol).length,
      };
    })
    .filter((c) => c.fills > 0 || c.recordedMs > 0);

  return {
    version: 1,
    generatedMs: now,
    subject: { accountId: resolved.accountId, selector },
    source,
    sourceNote,
    window: { fromMs, toMs },
    coverage: perSymbol,
    fills: {
      inWindow: allFills.length + [...otherMarkets.values()].reduce((a, b) => a + b, 0),
      checked,
      clean,
      unverifiable,
      truncated,
    },
    orders: { checked: oc.checked, consistent: oc.consistent, skipped: oc.skipped },
    findings: findings.slice(0, MAX_FINDINGS_LISTED),
    findingsTotal: findings.length,
    verdict,
    notes,
  };
}

/** Takes the oldest waiting audit, runs it, and stores the report (or why it failed). */
export async function processAudits(
  pool: pg.Pool,
  deps: AuditDeps,
  now = Date.now(),
): Promise<number> {
  // An audit stuck "running" past this was lost with a restart.
  await pool.query(
    "UPDATE audit_jobs SET status = 'failed', error = 'The audit was interrupted. Try again.', finished_ms = $1 WHERE status = 'running' AND started_ms < $2",
    [now, now - 30 * 60_000],
  );
  const claimed = await pool.query(
    `UPDATE audit_jobs SET status = 'running', started_ms = $1
      WHERE id = (SELECT id FROM audit_jobs WHERE status = 'queued' ORDER BY created_ms LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, selector`,
    [now],
  );
  const job = claimed.rows[0];
  if (!job) return 0;
  const selector = job.selector as AuditSelector;
  try {
    const report = await runAudit(pool, selector, deps);
    await pool.query(
      "UPDATE audit_jobs SET status = 'done', report = $2, finished_ms = $3 WHERE id = $1",
      [job.id, JSON.stringify(report), Date.now()],
    );
    deps.log?.info("audit done", { key: auditKey(selector), verdict: report.verdict });
  } catch (e) {
    const message =
      e instanceof AuditError ? e.message : "The audit couldn't be completed. Try again shortly.";
    if (!(e instanceof AuditError)) deps.log?.warn("audit failed", { err: errMsg(e) });
    await pool.query(
      "UPDATE audit_jobs SET status = 'failed', error = $2, finished_ms = $3 WHERE id = $1",
      [job.id, message, Date.now()],
    );
  }
  return 1;
}
