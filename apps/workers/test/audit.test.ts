import { gzipSync } from "node:zlib";
import { parseAuditSelector } from "@tapeverify/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkFillAgainstBook, checkOrders } from "../src/audit/checks.js";
import {
  ExportUnavailable,
  exportRows,
  type HistFill,
  type HistOrder,
} from "../src/audit/fetch.js";
import { processAudits, runAudit } from "../src/audit/run.js";
import { testPool } from "./helpers.js";

const fill = (o: Partial<HistFill> = {}): HistFill => ({
  id: "1",
  trade_id: "100",
  order_id: "9001",
  account_id: "acc",
  symbol: "AUD-USD",
  side: "buy",
  role: "taker",
  price: "101.5",
  size: "0.4",
  timestamp: 1_000_000,
  ...o,
});
const order = (o: Partial<HistOrder> = {}): HistOrder => ({
  id: "9001",
  account_id: "acc",
  symbol: "AUD-USD",
  side: "buy",
  status: "filled",
  type: "market",
  size: "0.4",
  filled: "0.4",
  price: "0",
  create_timestamp: 999_000,
  event_timestamp: 1_000_000,
  ...o,
});
const win = { fromMs: 900_000, toMs: 2_000_000 };

describe("order checks", () => {
  it("passes an order whose fills, status and timing agree", () => {
    const r = checkOrders([order()], [fill()], win);
    expect(r).toMatchObject({ checked: 1, consistent: 1, skipped: 0 });
    expect(r.findings).toEqual([]);
  });

  it("flags fills that don't add up, a worse-than-limit price, a stray timestamp and a wrong status", () => {
    const r = checkOrders(
      [order({ type: "limit", price: "101", filled: "0.5", status: "filled", size: "0.4" })],
      [fill({ price: "101.5", timestamp: 5_000_000 })],
      { fromMs: 900_000, toMs: 9_000_000 },
    );
    const kinds = r.findings.map((x) => x.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["order_fills", "order_status", "limit_price", "order_timing"]),
    );
    expect(r.consistent).toBe(0);
  });

  it("flags a rejected order that has fills", () => {
    const r = checkOrders([order({ status: "rejected", filled: "0" })], [fill()], win);
    expect(r.findings.some((x) => x.kind === "order_status")).toBe(true);
  });

  it("skips orders that are not wholly inside the window", () => {
    const r = checkOrders([order({ create_timestamp: 1 })], [fill()], win);
    expect(r).toMatchObject({ checked: 0, skipped: 1 });
  });
});

describe("a fill against the book's record of the trade", () => {
  const u = { orderId: "a1", side: "sell" as const, price: "101.5", size: "0.4" };
  const head = { ahead: 0, price: "101.5", bestPrice: "101.5" };

  it("is clean when price, size and side agree and the order was first in line", () => {
    expect(checkFillAgainstBook(fill(), u, head)).toEqual([]);
    expect(checkFillAgainstBook(fill({ role: "maker", side: "sell" }), u, head)).toEqual([]);
  });

  it("flags a mismatch in price, size or side", () => {
    expect(checkFillAgainstBook(fill({ price: "101.6" }), u, head)[0]?.kind).toBe("book_mismatch");
    expect(checkFillAgainstBook(fill({ size: "0.5" }), u, head)[0]?.kind).toBe("book_mismatch");
    expect(checkFillAgainstBook(fill({ side: "sell" }), u, head)[0]?.kind).toBe("book_mismatch");
  });

  it("flags a queue jump and a worse-priced order hit first", () => {
    const jump = checkFillAgainstBook(fill(), u, { ahead: 2, price: "101.5", bestPrice: "101.5" });
    expect(jump[0]).toMatchObject({ kind: "priority" });
    expect(jump[0]?.detail).toContain("2 older orders");
    const price = checkFillAgainstBook(fill(), u, { ahead: 0, price: "102", bestPrice: "101.5" });
    expect(price[0]).toMatchObject({ kind: "priority" });
  });
});

describe("the bulk export", () => {
  const gz = (rows: object[]) => gzipSync(rows.map((r) => JSON.stringify(r)).join("\n"));
  const routes =
    (over: { start?: number; status?: string[]; file?: Buffer } = {}) =>
    async (url: string, init?: { method?: string }) => {
      if (url.includes("/export?") && init?.method === "POST")
        return new Response(JSON.stringify({ job_id: "j1" }), { status: over.start ?? 202 });
      if (url.includes("/export/j1")) {
        const status = over.status?.shift() ?? "complete";
        return new Response(
          JSON.stringify({ status, download_url: "https://files.test/x.gz", error: "boom" }),
        );
      }
      if (url === "https://files.test/x.gz") return new Response(over.file ?? gz([]));
      return new Response("nope", { status: 404 });
    };
  const opts = {
    timeoutMs: 5000,
    pollMs: 1,
    sleep: async () => {},
    keep: () => true,
    maxKept: 100,
  };

  it("waits for the job, then reads the gzipped lines, keeping only what is asked for", async () => {
    const f = routes({
      status: ["queued", "processing"],
      file: gz([
        { id: 1, symbol: "A" },
        { id: 2, symbol: "B" },
        { id: 3, symbol: "A" },
      ]),
    }) as unknown as typeof fetch;
    const r = await exportRows(
      "https://s.test",
      "fills",
      "account_id=x",
      {
        ...opts,
        keep: (row) => row.symbol === "A",
      },
      f,
    );
    expect(r.rows.map((x) => x.id)).toEqual([1, 3]);
    expect(r.scanned).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("stops at the limit and says so", async () => {
    const f = routes({ file: gz([{ id: 1 }, { id: 2 }, { id: 3 }]) }) as unknown as typeof fetch;
    const r = await exportRows("https://s.test", "fills", "q", { ...opts, maxKept: 2 }, f);
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("reports an export that is refused, fails or never finishes", async () => {
    const run = (f: unknown, o = opts) =>
      exportRows("https://s.test", "fills", "q", o, f as typeof fetch);
    await expect(run(routes({ start: 503 }))).rejects.toBeInstanceOf(ExportUnavailable);
    await expect(run(routes({ status: ["failed"] }))).rejects.toThrow("boom");
    const slow = routes({ status: Array(1000).fill("processing") });
    await expect(
      run(slow, { ...opts, timeoutMs: 20, sleep: () => new Promise((r) => setTimeout(r, 5)) }),
    ).rejects.toThrow("did not finish");
  });
});

describe("what a pasted id or address is", () => {
  it("recognises account ids, Ethereum, Solana and Cardano addresses", () => {
    expect(parseAuditSelector("01A16485-B6EE-7745-ba83-88fa7d0d9b00")).toEqual({
      kind: "id",
      value: "01a16485-b6ee-7745-ba83-88fa7d0d9b00",
    });
    expect(parseAuditSelector(`0x${"AB".repeat(20)}`)?.blockchain).toBe("ethereum");
    expect(parseAuditSelector("HHr3uCjdUeHFkx7Zin8QRTJKuPpDiER9G1YLbsT1RCPB")?.blockchain).toBe(
      "solana",
    );
    expect(parseAuditSelector(`addr_test1${"q".repeat(60)}`)?.blockchain).toBe("cardano");
    expect(parseAuditSelector("hello world")).toBeNull();
  });
});

// ── An audit end to end, against a recorded book in the test database ──

const SYM = "AUD-USD";
const NOW = 2_000_000_000_000;
const T0 = NOW - 3_600_000;

describe("an audit of a recorded market", () => {
  let pool: pg.Pool;
  let segmentId: number;

  beforeAll(async () => {
    pool = testPool();
    await pool.query("DELETE FROM l3_segments WHERE symbol = $1", [SYM]);
    const seg = await pool.query(
      "INSERT INTO l3_segments (symbol, start_ts, start_sequence) VALUES ($1, $2, 10) RETURNING id",
      [SYM, T0],
    );
    segmentId = Number(seg.rows[0].id);
    // Asks: 101.5 holds a1 then a2, and 102 holds a3.
    const book = {
      symbol: SYM,
      last_sequence: 10,
      timestamp: T0,
      bids: [],
      asks: [
        {
          price: "101.5",
          orders: [
            { order_id: "a1", size: "1" },
            { order_id: "a2", size: "1" },
          ],
        },
        { price: "102", orders: [{ order_id: "a3", size: "1" }] },
      ],
    };
    await pool.query(
      "INSERT INTO l3_snapshots (segment_id, last_sequence, ts_ms, book) VALUES ($1, 10, $2, $3)",
      [segmentId, T0, JSON.stringify(book)],
    );
    const fills = [
      // a1 is first in line at the best price: fair.
      [11, "partial_fill", "a1", "101.5", "-0.4", "0.6", 5001, T0 + 1000],
      // a2 is hit while a1 still has size ahead of it: a queue jump.
      [12, "full_fill", "a2", "101.5", "-1", "0", 5002, T0 + 2000],
      // a3 is hit at 102 while a1 still rests at 101.5: price priority broken.
      [13, "full_fill", "a3", "102", "-1", "0", 5003, T0 + 3000],
    ] as const;
    for (const [seq, action, id, price, delta, remaining, trade, ts] of fills)
      await pool.query(
        `INSERT INTO l3_updates (segment_id, sequence, ts_ms, action, order_id, taker_order_id, side, price, delta_size, remaining_size, trade_id)
         VALUES ($1,$2,$3,$4,$5,'t1','sell',$6,$7,$8,$9)`,
        [segmentId, seq, ts, action, id, price, delta, remaining, trade],
      );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM l3_segments WHERE symbol = $1", [SYM]);
    await pool.query("DELETE FROM audit_jobs WHERE selector_key LIKE 'id:%'");
    await pool.end();
  });

  const ACCOUNT = "01a16485-b6ee-7745-ba83-88fa7d0d9b00";
  const rows = {
    fills: [
      {
        id: 1,
        trade_id: 5001,
        order_id: 9001,
        account_id: ACCOUNT,
        symbol: SYM,
        side: "buy",
        role: "taker",
        price: "101.5",
        size: "0.4",
        timestamp: T0 + 1000,
      },
      {
        id: 2,
        trade_id: 5002,
        order_id: 9002,
        account_id: ACCOUNT,
        symbol: SYM,
        side: "buy",
        role: "taker",
        price: "101.5",
        size: "1",
        timestamp: T0 + 2000,
      },
      {
        id: 3,
        trade_id: 5003,
        order_id: 9003,
        account_id: ACCOUNT,
        symbol: SYM,
        side: "buy",
        role: "taker",
        price: "102",
        size: "1",
        timestamp: T0 + 3000,
      },
      // another market, which was never recorded
      {
        id: 4,
        trade_id: 77,
        order_id: 9004,
        account_id: ACCOUNT,
        symbol: "ZZZ-USD",
        side: "buy",
        role: "taker",
        price: "5",
        size: "1",
        timestamp: T0 + 4000,
      },
    ],
    orders: [
      {
        id: 9001,
        account_id: ACCOUNT,
        symbol: SYM,
        side: "buy",
        status: "filled",
        type: "market",
        size: "0.4",
        filled: "0.4",
        price: "0",
        create_timestamp: T0 + 900,
        event_timestamp: T0 + 1000,
      },
      // says it filled 2 but its fill is 1
      {
        id: 9002,
        account_id: ACCOUNT,
        symbol: SYM,
        side: "buy",
        status: "canceled",
        type: "market",
        size: "2",
        filled: "2",
        price: "0",
        create_timestamp: T0 + 1900,
        event_timestamp: T0 + 2000,
      },
      {
        id: 9003,
        account_id: ACCOUNT,
        symbol: SYM,
        side: "buy",
        status: "filled",
        type: "market",
        size: "1",
        filled: "1",
        price: "0",
        create_timestamp: T0 + 2900,
        event_timestamp: T0 + 3000,
      },
    ],
  };

  /** A Strike that answers history, export and download calls from `rows`. */
  const strike = (o: { exportStatus?: number } = {}) =>
    (async (url: string, init?: { method?: string }) => {
      const u = new URL(url);
      const kind = u.pathname.includes("order") ? "orders" : "fills";
      if (u.pathname === "/v2/history/fill" && u.searchParams.get("limit") === "1")
        return new Response(JSON.stringify({ fills: [rows.fills[0]] }));
      if (u.pathname.endsWith("/export") && init?.method === "POST")
        return new Response(JSON.stringify({ job_id: kind }), { status: o.exportStatus ?? 202 });
      if (u.pathname.includes("/export/"))
        return new Response(
          JSON.stringify({ status: "complete", download_url: `https://files.test/${kind}.gz` }),
        );
      if (u.hostname === "files.test") {
        const k = u.pathname.includes("orders") ? "orders" : "fills";
        return new Response(gzipSync(rows[k].map((r) => JSON.stringify(r)).join("\n")));
      }
      if (u.pathname === "/v2/history/fill" || u.pathname === "/v2/history/order") {
        const k = u.pathname.endsWith("fill") ? "fills" : "orders";
        const sym = u.searchParams.get("symbol");
        return new Response(JSON.stringify({ [k]: rows[k].filter((r) => r.symbol === sym) }));
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

  const deps = (f: typeof fetch) => ({
    baseUrl: "https://strike.test",
    fetchImpl: f,
    now: () => NOW,
    exportPollMs: 1,
  });
  const selector = { kind: "id" as const, value: ACCOUNT };

  it("checks the account's fills against the book: one fair fill, a queue jump and a price-priority break", async () => {
    const r = await runAudit(pool, selector, deps(strike()));
    expect(r.source).toBe("export");
    expect(r.subject.accountId).toBe(ACCOUNT);
    expect(r.fills).toMatchObject({ checked: 3, clean: 1, truncated: false });
    expect(r.fills.unverifiable).toEqual([
      { reason: "no order-book recording for ZZZ-USD", count: 1 },
    ]);
    const priority = r.findings.filter((x) => x.kind === "priority");
    expect(priority.map((x) => x.fillId).sort()).toEqual(["2", "3"]);
    expect(priority.find((x) => x.fillId === "2")?.detail).toContain("1 older order");
    expect(priority.find((x) => x.fillId === "3")?.detail).toContain("better-priced");
    // order 9002 claims a fill its fills don't back up
    expect(r.findings.some((x) => x.kind === "order_fills" && x.orderId === "9002")).toBe(true);
    expect(r.orders).toMatchObject({ checked: 3, consistent: 2 });
    expect(r.verdict).toBe("findings");
    expect(r.coverage[0]).toMatchObject({ symbol: SYM, fills: 3, gaps: 0 });
  });

  it("falls back to the paged history when the export can't be used, and says so", async () => {
    const r = await runAudit(pool, selector, deps(strike({ exportStatus: 503 })));
    expect(r.source).toBe("history");
    expect(r.sourceNote).toContain("export");
    expect(r.fills).toMatchObject({ checked: 3, clean: 1 });
    expect(r.findings.filter((x) => x.kind === "priority")).toHaveLength(2);
  });

  it("refuses an id Strike doesn't know", async () => {
    const f = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(runAudit(pool, selector, deps(f))).rejects.toThrow("no account or vault");
  });

  it("runs a queued job and stores its report; a bad id fails with a message", async () => {
    await pool.query("DELETE FROM audit_jobs");
    const ok = await pool.query(
      "INSERT INTO audit_jobs (selector, selector_key, created_ms) VALUES ($1, $2, $3) RETURNING id",
      [JSON.stringify(selector), `id:${ACCOUNT}`, NOW],
    );
    expect(await processAudits(pool, deps(strike()), NOW)).toBe(1);
    const done = (
      await pool.query("SELECT status, report FROM audit_jobs WHERE id = $1", [ok.rows[0].id])
    ).rows[0];
    expect(done.status).toBe("done");
    expect(done.report.verdict).toBe("findings");

    const bad = await pool.query(
      "INSERT INTO audit_jobs (selector, selector_key, created_ms) VALUES ($1, 'id:x', $2) RETURNING id",
      [JSON.stringify({ kind: "id", value: "11111111-1111-1111-1111-111111111111" }), NOW + 1],
    );
    const f = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await processAudits(pool, deps(f), NOW);
    const failed = (
      await pool.query("SELECT status, error FROM audit_jobs WHERE id = $1", [bad.rows[0].id])
    ).rows[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("no account or vault");
    expect(await processAudits(pool, deps(f), NOW)).toBe(0);
  });
});
