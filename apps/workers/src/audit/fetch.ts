import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { AuditSelector } from "@tapeverify/shared";

type Fetch = typeof fetch;

export interface HistFill {
  id: string;
  trade_id: string;
  order_id: string;
  account_id: string;
  symbol: string;
  side: "buy" | "sell";
  role: "maker" | "taker";
  price: string;
  size: string;
  timestamp: number;
}

export interface HistOrder {
  id: string;
  account_id: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  type: string;
  size: string;
  filled: string;
  price: string;
  create_timestamp: number;
  event_timestamp: number;
}

/** A problem worth telling the person who asked: a wrong id, an unknown address. */
export class AuditError extends Error {}

/** Strike's bulk export can't be used right now (busy, switched off, too slow): the paged history takes over. */
export class ExportUnavailable extends Error {}

export interface Resolved {
  /** The query string that selects the account on every history and export call. */
  qs: string;
  accountId: string | null;
}

const num = (v: unknown) => String(v);

/** Normalises a history or export row: ids arrive as numbers in some places and strings in others. */
export function toFill(r: Record<string, unknown>): HistFill {
  return {
    id: num(r.id),
    trade_id: num(r.trade_id),
    order_id: num(r.order_id),
    account_id: String(r.account_id ?? ""),
    symbol: String(r.symbol),
    side: r.side as "buy" | "sell",
    role: r.role as "maker" | "taker",
    price: String(r.price),
    size: String(r.size),
    timestamp: Number(r.timestamp),
  };
}

export function toOrder(r: Record<string, unknown>): HistOrder {
  return {
    id: num(r.id),
    account_id: String(r.account_id ?? ""),
    symbol: String(r.symbol),
    side: r.side as "buy" | "sell",
    status: String(r.status),
    type: String(r.type),
    size: String(r.size),
    filled: String(r.filled),
    price: String(r.price),
    create_timestamp: Number(r.create_timestamp),
    event_timestamp: Number(r.event_timestamp),
  };
}

const base = (b: string) => b.replace(/\/$/, "");

/**
 * Works out which account a pasted id or address means. A UUID is tried as an account id, then as a vault id.
 * Both history and export calls take the same selector, so the query string is what the rest of the audit needs.
 */
export async function resolveSelector(
  baseUrl: string,
  s: AuditSelector,
  f: Fetch = fetch,
): Promise<Resolved> {
  const probe = async (qs: string) => {
    const r = await f(`${base(baseUrl)}/v2/history/fill?${qs}&limit=1`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Strike answered ${r.status} while looking up the account`);
    const body = (await r.json()) as { fills?: Array<Record<string, unknown>> | null };
    return body.fills?.[0]?.account_id ? String(body.fills[0].account_id) : "";
  };
  if (s.kind === "blockchain_address") {
    const p = new URLSearchParams({ blockchain_address: s.value });
    if (s.blockchain) p.set("blockchain", s.blockchain);
    const found = await probe(p.toString());
    if (found === null) throw new AuditError("Strike has no account for that wallet address.");
    return { qs: p.toString(), accountId: found || null };
  }
  for (const key of ["account_id", "vault_id"] as const) {
    const p = new URLSearchParams({ [key]: s.value });
    const found = await probe(p.toString());
    if (found !== null)
      return { qs: p.toString(), accountId: key === "account_id" ? s.value : found || null };
  }
  throw new AuditError("Strike has no account or vault with that id.");
}

export interface ExportOptions {
  /** How long to wait for Strike to finish building the file. */
  timeoutMs: number;
  pollMs: number;
  /** Rows to keep; the rest are dropped as they stream past, so a huge account never sits in memory. */
  keep: (row: Record<string, unknown>) => boolean;
  /** Stop reading after this many kept rows. */
  maxKept: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExportResult {
  rows: Array<Record<string, unknown>>;
  scanned: number;
  truncated: boolean;
}

/** Strike's bulk export: start a job, wait for it, then stream the gzipped JSON Lines file. */
export async function exportRows(
  baseUrl: string,
  kind: "orders" | "fills",
  qs: string,
  o: ExportOptions,
  f: Fetch = fetch,
): Promise<ExportResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const root = base(baseUrl);
  const start = await f(`${root}/v2/${kind}/export?${qs}`, { method: "POST" });
  if (start.status !== 202) {
    throw new ExportUnavailable(`export refused (${start.status})`);
  }
  const { job_id: job } = (await start.json()) as { job_id?: string };
  if (!job) throw new ExportUnavailable("export gave no job id");

  const deadline = Date.now() + o.timeoutMs;
  let url: string | null = null;
  while (Date.now() < deadline) {
    const r = await f(`${root}/v2/${kind}/export/${job}?${qs}`);
    if (!r.ok) throw new ExportUnavailable(`export status failed (${r.status})`);
    const s = (await r.json()) as { status: string; download_url?: string; error?: string };
    if (s.status === "complete" && s.download_url) {
      url = s.download_url;
      break;
    }
    if (s.status === "failed") throw new ExportUnavailable(s.error ?? "export failed");
    await sleep(o.pollMs);
  }
  if (!url) throw new ExportUnavailable("export did not finish in time");

  const file = await f(url);
  if (!file.ok || !file.body) throw new ExportUnavailable(`download failed (${file.status})`);
  const lines = createInterface({
    input: Readable.fromWeb(file.body as never).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const rows: Array<Record<string, unknown>> = [];
  let scanned = 0;
  let truncated = false;
  for await (const line of lines) {
    if (!line.trim()) continue;
    scanned++;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (!o.keep(row)) continue;
    rows.push(row);
    if (rows.length >= o.maxKept) {
      truncated = true;
      lines.close();
      break;
    }
  }
  return { rows, scanned, truncated };
}

export interface PageOptions {
  symbol: string;
  fromMs: number;
  toMs: number;
  /** Pages of 1,000 to read at most. */
  maxPages: number;
}

/** The paged history endpoints, newest first, for one market and a time window. */
export async function pageHistory(
  baseUrl: string,
  kind: "fill" | "order",
  qs: string,
  o: PageOptions,
  f: Fetch = fetch,
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }> {
  const root = base(baseUrl);
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < o.maxPages; page++) {
    const p = new URLSearchParams(qs);
    p.set("symbol", o.symbol);
    p.set("startTime", String(o.fromMs));
    p.set("endTime", String(o.toMs));
    p.set("limit", "1000");
    if (cursor) p.set(kind === "fill" ? "fromId" : "fromOrderID", cursor);
    const r = await f(`${root}/v2/history/${kind}?${p}`);
    if (!r.ok) throw new Error(`Strike answered ${r.status} reading ${kind} history`);
    const body = (await r.json()) as Record<string, Array<Record<string, unknown>> | null>;
    const batch = (kind === "fill" ? body.fills : body.orders) ?? [];
    rows.push(...batch);
    if (batch.length < 1000) return { rows, truncated: false };
    cursor = String(Math.min(...batch.map((x) => Number(x.id))));
  }
  return { rows, truncated: true };
}
