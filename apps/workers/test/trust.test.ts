import {
  anchorPending,
  generateSigningKey,
  recordBundle,
  sealBatch,
  takeSnapshots,
  verifyRecord,
} from "@pit/argus";
import type { StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { scoreFills } from "../src/argus/fairfill.js";
import { sampleHealth } from "../src/argus/health.js";
import { checkLiquidations } from "../src/argus/liquidation.js";
import { testPool } from "./helpers.js";

const MIN = 60_000;
const HOUR = 3_600_000;
let pool: pg.Pool;
const users: string[] = [];
const symbols = ["ZZL3-USD", "ZZDP-USD", "ZZMK-USD", "ZZCD-USD", "ZZNO-USD"];

beforeAll(() => {
  pool = testPool();
});
async function cleanup() {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users.splice(0)]);
  await pool.query("DELETE FROM trades WHERE account_id LIKE 'trustw-%'");
  await pool.query("DELETE FROM fills WHERE account_id LIKE 'trustw-%'");
  await pool.query("DELETE FROM fill_scores WHERE account_id LIKE 'trustw-%'");
  await pool.query("DELETE FROM l3_segments WHERE symbol = ANY($1)", [symbols]);
  await pool.query("DELETE FROM depth_snapshots WHERE symbol = ANY($1)", [symbols]);
  await pool.query("DELETE FROM mark_prices WHERE symbol = ANY($1)", [symbols]);
  await pool.query("DELETE FROM candles WHERE symbol = ANY($1)", [symbols]);
  await pool.query(
    "DELETE FROM record_batches b WHERE NOT EXISTS (SELECT 1 FROM record_snapshots s WHERE s.batch_id = b.id) AND b.anchor IS NULL",
  );
}
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function user(tag = "u") {
  const account = `trustw-${tag}-${crypto.randomUUID()}`;
  const r = await pool.query(
    "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
    [`trust-${crypto.randomUUID()}`, account],
  );
  users.push(r.rows[0].id);
  return { id: r.rows[0].id as string, account };
}

async function fill(
  account: string,
  o: {
    id: string;
    tradeId: number;
    symbol: string;
    side?: "buy" | "sell";
    role?: string;
    price: string;
    size: string;
    ts: number;
  },
) {
  await pool.query(
    `INSERT INTO fills (account_id, id, trade_id, order_id, symbol, side, role, price, size, realized_pnl, fee, ts_ms, raw)
     VALUES ($1,$2,$3,'o1',$4,$5,$6,$7,$8,0,0,$9,'{}')`,
    [account, o.id, o.tradeId, o.symbol, o.side ?? "buy", o.role ?? "taker", o.price, o.size, o.ts],
  );
}

const scoreRow = async (account: string, id: string) =>
  (
    await pool.query("SELECT * FROM fill_scores WHERE account_id = $1 AND fill_id = $2", [
      account,
      id,
    ])
  ).rows[0];

describe("fair-fill scoring from recorded market data", () => {
  it("judges a sweep against the book before the order started, fill by fill", async () => {
    const symbol = "ZZL3-USD";
    const now = Date.now();
    const t0 = now - 20 * MIN;
    const u = await user("l3");
    const seg = await pool.query(
      "INSERT INTO l3_segments (symbol, start_ts, start_sequence) VALUES ($1,$2,100) RETURNING id",
      [symbol, t0],
    );
    const segId = seg.rows[0].id;
    await pool.query(
      "INSERT INTO l3_snapshots (segment_id, last_sequence, ts_ms, book) VALUES ($1,100,$2,$3)",
      [
        segId,
        t0,
        JSON.stringify({
          symbol,
          last_sequence: 100,
          timestamp: t0,
          bids: [{ price: "99.8", orders: [{ order_id: "b1", size: "5" }] }],
          asks: [
            { price: "100.0", orders: [{ order_id: "a1", size: "1" }] },
            { price: "100.2", orders: [{ order_id: "a2", size: "2" }] },
          ],
        }),
      ],
    );
    const upd = (
      seq: number,
      action: string,
      order: string,
      price: string,
      delta: string,
      rem: string,
      tradeId: number,
      taker: string,
    ) =>
      pool.query(
        `INSERT INTO l3_updates (segment_id, sequence, ts_ms, action, order_id, taker_order_id, side, price, delta_size, remaining_size, trade_id)
         VALUES ($1,$2,$3,$4,$5,$6,'sell',$7,$8,$9,$10)`,
        [segId, seq, t0 + seq * 10, action, order, taker, price, delta, rem, tradeId],
      );
    // Taker t1 buys 2.5: takes all of a1 (1 @ 100.0) then 1.5 of a2 (@ 100.2). Taker t2 later buys 0.5 of what is left of a2.
    await upd(101, "full_fill", "a1", "100.0", "1", "0", 9001, "t1");
    await upd(102, "partial_fill", "a2", "100.2", "1.5", "0.5", 9002, "t1");
    await upd(103, "full_fill", "a2", "100.2", "0.5", "0", 9003, "t2");

    const ts = t0 + 2_000;
    await fill(u.account, { id: "f1", tradeId: 9001, symbol, price: "100.0", size: "1", ts });
    await fill(u.account, { id: "f2", tradeId: 9002, symbol, price: "100.2", size: "1.5", ts });
    await fill(u.account, { id: "f3", tradeId: 9003, symbol, price: "100.5", size: "0.5", ts });
    // A resting order that got filled needs no grading.
    await fill(u.account, {
      id: "f4",
      tradeId: 9004,
      symbol,
      role: "maker",
      side: "sell",
      price: "101",
      size: "1",
      ts,
    });

    expect(await scoreFills(pool, undefined, now)).toBeGreaterThanOrEqual(4);

    const f1 = await scoreRow(u.account, "f1");
    expect(f1).toMatchObject({ basis: "l3", score: 100 });
    expect(Number(f1.ref_price)).toBe(100);

    // Second fill of the sweep: it paid 100.2, which is exactly what its slice of the book cost,
    // but against the touch before the sweep that is 20 bps.
    const f2 = await scoreRow(u.account, "f2");
    expect(f2.basis).toBe("l3");
    expect(f2.score).toBe(100);
    expect(Number(f2.ref_price)).toBe(100);
    expect(Number(f2.expected_price)).toBeCloseTo(100.2, 9);
    expect(Number(f2.slippage_bps)).toBeCloseTo(20, 6);

    // A different order that paid 100.5 for a slice the book priced at 100.2: unfair.
    const f3 = await scoreRow(u.account, "f3");
    expect(f3.basis).toBe("l3");
    expect(f3.score).toBeLessThan(60);
    expect(Number(f3.slippage_bps)).toBeGreaterThan(29);

    expect(await scoreRow(u.account, "f4")).toMatchObject({ basis: "maker", score: 100 });
    // Scoring twice never rescored anything.
    expect(await scoreFills(pool, undefined, now)).toBe(0);
  });

  it("falls back to a depth sample, then the mark price, then the minute's VWAP, and says which", async () => {
    const now = Date.now();
    const ts = now - 5 * MIN;
    const u = await user("fb");

    await pool.query(
      "INSERT INTO depth_snapshots (symbol, ts_ms, bids, asks) VALUES ('ZZDP-USD',$1,$2,$3)",
      [ts - 3_000, JSON.stringify([["99", "10"]]), JSON.stringify([["100", "10"]])],
    );
    await fill(u.account, {
      id: "d1",
      tradeId: 1,
      symbol: "ZZDP-USD",
      price: "100.25",
      size: "1",
      ts,
    });

    await pool.query(
      "INSERT INTO mark_prices (symbol, ts_ms, mark_price, index_price) VALUES ('ZZMK-USD',$1,100,100)",
      [ts - 20_000],
    );
    await fill(u.account, {
      id: "m1",
      tradeId: 2,
      symbol: "ZZMK-USD",
      price: "100.5",
      size: "1",
      ts,
    });

    const open = Math.floor(ts / MIN) * MIN;
    await pool.query(
      `INSERT INTO candles (symbol, interval, price_type, open_time, close_time, open, high, low, close, volume, quote_volume, trades)
       VALUES ('ZZCD-USD','1m','last',$1,$2,100,101,99,100,10,1000,5)`,
      [open, open + MIN - 1],
    );
    await fill(u.account, {
      id: "c1",
      tradeId: 3,
      symbol: "ZZCD-USD",
      side: "sell",
      price: "99.5",
      size: "1",
      ts,
    });

    await scoreFills(pool, undefined, now);
    const d = await scoreRow(u.account, "d1");
    expect(d).toMatchObject({ basis: "depth", score: 50 }); // 25 bps against the 50 bps allowance
    const m = await scoreRow(u.account, "m1");
    expect(m).toMatchObject({ basis: "mark", score: 50 }); // 50 bps against the 100 bps allowance
    const c = await scoreRow(u.account, "c1");
    expect(c.basis).toBe("candle");
    expect(Number(c.ref_price)).toBe(100); // 1000 / 10
    expect(Number(c.slippage_bps)).toBeCloseTo(50, 6);
  });

  it("records 'none' for an old fill with no market data, and retries a young one", async () => {
    const now = Date.now();
    const u = await user("no");
    await fill(u.account, {
      id: "old",
      tradeId: 1,
      symbol: "ZZNO-USD",
      price: "10",
      size: "1",
      ts: now - 2 * HOUR,
    });
    await fill(u.account, {
      id: "young",
      tradeId: 2,
      symbol: "ZZNO-USD",
      price: "10",
      size: "1",
      ts: now - 2 * MIN,
    });
    await scoreFills(pool, undefined, now);
    expect(await scoreRow(u.account, "old")).toMatchObject({ basis: "none", score: null });
    expect(await scoreRow(u.account, "young")).toBeUndefined();
  });
});

// ── Signed records ──

async function tradeFor(account: string, closed: number, net = "1") {
  await pool.query(
    `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
     VALUES ($1,'BTC-USD','long',$2,$3,1,100,101,100,1,0,0,$4)`,
    [account, closed - 60_000, closed, net],
  );
}

/** A Solana RPC that remembers each transaction it is sent, decodes the memo, and serves it back. */
function fakeChain() {
  const txs = new Map<string, string>();
  let n = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getLatestBlockhash")
      return ok({ value: { blockhash: "11111111111111111111111111111111" } });
    if (method === "sendTransaction") {
      const raw = Buffer.from(params[0], "base64");
      const message = raw.subarray(65);
      const memoLen = message[104] as number;
      const sig = `fakesig${++n}`;
      txs.set(sig, message.subarray(105, 105 + memoLen).toString("utf8"));
      return ok(sig);
    }
    if (method === "getSignatureStatuses")
      return ok({ value: [{ confirmationStatus: "confirmed", err: null, slot: 123 }] });
    if (method === "getTransaction") {
      const memo = txs.get(params[0]);
      if (memo === undefined) return ok(null);
      return ok({
        slot: 123,
        blockTime: 1_800_000_000,
        meta: { err: null },
        transaction: { message: { instructions: [{ program: "spl-memo", parsed: memo }] } },
      });
    }
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, txs };
}

describe("signed, chained, anchored records", () => {
  it("snapshots a trader, seals a batch, anchors it, and every check passes against the chain", async () => {
    const key = generateSigningKey();
    const payer = generateSigningKey();
    const chain = fakeChain();
    const now = Date.now();
    const u = await user("rec");
    for (let i = 0; i < 5; i++) await tradeFor(u.account, now - (5 - i) * HOUR);

    expect(await takeSnapshots(pool, key, now, undefined, [u.id])).toBe(1);
    const batch = await sealBatch(pool, key, now);
    expect(batch?.count).toBeGreaterThanOrEqual(1);
    const anchored = await anchorPending(
      pool,
      {
        rpcUrl: "http://rpc",
        cluster: "devnet",
        payerSeed: payer.seed,
        fetchImpl: chain.fetchImpl,
      },
      now,
    );
    expect(anchored).toBeGreaterThanOrEqual(1);

    const snap = (await pool.query("SELECT id FROM record_snapshots WHERE user_id = $1", [u.id]))
      .rows[0];
    const v = await verifyRecord(pool, snap.id, key.publicKey, "http://rpc", chain.fetchImpl);
    expect(v?.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v?.ok).toBe(true);
    expect(v?.checks.map((c) => c.name)).toContain(
      "anchor transaction on-chain carries the batch hash",
    );
    expect(v?.bundle.payload.stats).toMatchObject({ trades: 5 });
    // What was written on-chain is the batch hash, and nothing about any trader.
    const memo = [...chain.txs.values()].find((m) => m.startsWith(`pit1:${v?.bundle.batch?.id}:`));
    expect(memo).toBe(`pit1:${v?.bundle.batch?.id}:${v?.bundle.batch?.batchHash}`);
    expect(memo).not.toContain(u.account);
  });

  it("chains the next snapshot to the last, and only snapshots again when due", async () => {
    const key = generateSigningKey();
    const now = Date.now();
    const u = await user("chain");
    await tradeFor(u.account, now - 5 * HOUR);
    expect(await takeSnapshots(pool, key, now - 3 * HOUR, undefined, [u.id])).toBe(1);
    expect(await takeSnapshots(pool, key, now - 3 * HOUR + 10 * MIN, undefined, [u.id])).toBe(0); // too soon
    expect(await takeSnapshots(pool, key, now - HOUR, undefined, [u.id])).toBe(0); // due, but nothing changed
    await tradeFor(u.account, now - 30 * MIN, "-2");
    expect(await takeSnapshots(pool, key, now, undefined, [u.id])).toBe(1);

    const rows = (
      await pool.query(
        "SELECT seq, record_hash, prev_hash FROM record_snapshots WHERE user_id = $1 ORDER BY seq",
        [u.id],
      )
    ).rows;
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0].prev_hash).toBeNull();
    expect(rows[1].prev_hash).toBe(rows[0].record_hash);
  });

  it("notices a quietly edited history, even if the record was re-hashed", async () => {
    const key = generateSigningKey();
    const now = Date.now();
    const u = await user("tamper");
    for (let i = 0; i < 3; i++) await tradeFor(u.account, now - (3 - i) * HOUR);
    await takeSnapshots(pool, key, now, undefined, [u.id]);
    await sealBatch(pool, key, now);
    const id = (await pool.query("SELECT id FROM record_snapshots WHERE user_id = $1", [u.id]))
      .rows[0].id;
    expect((await verifyRecord(pool, id, key.publicKey, null))?.ok).toBe(false); // not anchored yet: reported, not hidden
    const clean = (await verifyRecord(pool, id, key.publicKey, null))?.checks
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(clean).toEqual(["batch anchored on-chain"]);

    // Pit (or anyone with database access) bumps a number.
    await pool.query(
      "UPDATE record_snapshots SET payload = jsonb_set(payload, '{stats,netPnl}', '\"999999\"') WHERE id = $1",
      [id],
    );
    const bad = (await verifyRecord(pool, id, key.publicKey, null))?.checks
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(bad).toContain("record hash matches its contents");

    // ...and recomputes the hash too: the signature and the batch's Merkle root no longer agree.
    const b = await recordBundle(pool, id);
    const { recordHash: rh } = await import("@pit/argus");
    const fixed = rh(b!.payload);
    await pool.query("UPDATE record_snapshots SET record_hash = $2 WHERE id = $1", [id, fixed]);
    const bad2 = (await verifyRecord(pool, id, key.publicKey, null))?.checks
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(bad2).toEqual(
      expect.arrayContaining(["record signature is valid", "record is in the batch's Merkle tree"]),
    );
  });

  it("keeps everyone else's proofs valid when one account in the batch is deleted", async () => {
    const key = generateSigningKey();
    const now = Date.now();
    const a = await user("pa");
    const b = await user("pb");
    const c = await user("pc");
    for (const x of [a, b, c]) await tradeFor(x.account, now - HOUR);
    await takeSnapshots(pool, key, now, undefined, [a.id, b.id, c.id]);
    await sealBatch(pool, key, now);
    await pool.query("DELETE FROM users WHERE id = $1", [b.id]);
    users.splice(users.indexOf(b.id), 1);
    for (const x of [a, c]) {
      const id = (await pool.query("SELECT id FROM record_snapshots WHERE user_id = $1", [x.id]))
        .rows[0].id;
      const failed = (await verifyRecord(pool, id, key.publicKey, null))?.checks
        .filter((k) => !k.ok)
        .map((k) => k.name);
      expect(failed).toEqual(["batch anchored on-chain"]);
    }
  });

  it("keeps a batch un-anchored and tries again when the chain call fails", async () => {
    const key = generateSigningKey();
    const now = Date.now();
    const u = await user("fail");
    await tradeFor(u.account, now - HOUR);
    await takeSnapshots(pool, key, now, undefined, [u.id]);
    await sealBatch(pool, key, now);
    const down = (async () =>
      new Response(
        JSON.stringify({ error: { message: "node is behind" } }),
      )) as unknown as typeof fetch;
    await anchorPending(
      pool,
      {
        rpcUrl: "http://rpc",
        cluster: "devnet",
        payerSeed: generateSigningKey().seed,
        fetchImpl: down,
      },
      now,
    );
    const row = (
      await pool.query(
        "SELECT b.anchor, b.anchor_error FROM record_snapshots s JOIN record_batches b ON b.id = s.batch_id WHERE s.user_id = $1",
        [u.id],
      )
    ).rows[0];
    expect(row.anchor).toBeNull();
    expect(row.anchor_error).toMatch(/node is behind/);
  });
});

// ── Strike health ──

describe("Strike health sampling", () => {
  const vault = (over: Record<string, unknown> = {}) => ({
    vault_id: "v1",
    type: "protocol",
    name: "SLP",
    status: "active",
    equity: "7000",
    wallet_balance: "7050",
    share_price: "1.02",
    total_shares: "6900",
    depositors: 14,
    all_time_pnl: "300",
    all_time_deposits: "7000",
    all_time_withdrawals: "400",
    ...over,
  });
  const client = (vaults: unknown[] | Error) =>
    ({
      publicGet: async () => {
        if (vaults instanceof Error) throw vaults;
        return { vaults };
      },
    }) as unknown as StrikeClient;

  it("stores the protocol vault with a rating, and rates a vault that can't be read as unknown", async () => {
    const now = Date.now() + 5_000_000_000; // far ahead, so these samples are the latest
    const ok = await sampleHealth(
      pool,
      client([vault({ type: "user", name: "Other" }), vault()]),
      now,
    );
    expect(ok).toMatchObject({ status: "ok" });
    expect(ok.slp).toMatchObject({ name: "SLP", equity: 7000, depositors: 14 });
    const down = await sampleHealth(pool, client(new Error("down")), now + 1);
    expect(down).toMatchObject({ status: "unknown", slp: null });
    await pool.query("DELETE FROM health_samples WHERE ts_ms >= $1", [now]);
  });
});

// ── Liquidation alerts ──

describe("liquidation alerts for copied positions", () => {
  async function openFollow(over: { status?: string } = {}) {
    const caller = await user("lc");
    const follower = await user("lf");
    const call = await pool.query(
      `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'BTC-USD','long',10,1,$3,50,'open',100,1,1) RETURNING id`,
      [crypto.randomUUID().slice(0, 8), caller.id, Date.now() + HOUR],
    );
    const f = await pool.query(
      `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, status, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'BTC-USD','long',10,100,1,1,100,100,0,$3,100,1,1) RETURNING id`,
      [call.rows[0].id, follower.id, over.status ?? "open"],
    );
    return { follower, followId: f.rows[0].id as string };
  }
  const world = (mark: string, liq = "90") =>
    ({
      opts: { baseUrl: "http://strike", priceUrl: "http://strike/price" },
      publicGet: async (path: string) => {
        if (path.startsWith("/v2/positions"))
          return {
            positions: [
              {
                id: 1,
                symbol: "BTC-USD",
                size: "1",
                entry_price: "100",
                leverage: 10,
                margin_mode: "isolated",
                liquidation_price: liq,
                upnl: "0",
                create_timestamp: 1,
              },
            ],
          };
        if (path.startsWith("/v2/markPrice"))
          return { s: "BTC-USD", p: mark, i: mark, r: "0", E: 1 };
        throw new Error(path);
      },
    }) as unknown as StrikeClient;
  const alerts = async (followId: string) =>
    (
      await pool.query(
        "SELECT level, resolution, resolved_ms, used FROM liquidation_alerts WHERE follow_id = $1",
        [followId],
      )
    ).rows;

  it("warns as the mark uses up its runway, escalates in place, and clears once it recovers", async () => {
    const { followId } = await openFollow();
    const now = Date.now();
    await checkLiquidations(pool, world("98"), undefined, now); // 20% of the way
    expect(await alerts(followId)).toEqual([]);

    await checkLiquidations(pool, world("94"), undefined, now); // 60%
    expect((await alerts(followId)).map((a) => a.level)).toEqual(["warn"]);
    await checkLiquidations(pool, world("92"), undefined, now); // 80%
    await checkLiquidations(pool, world("90.6"), undefined, now); // 94%
    const a = await alerts(followId);
    expect(a).toHaveLength(1); // one alert per follow, escalated in place
    expect(a[0]?.level).toBe("critical");

    await checkLiquidations(pool, world("96"), undefined, now); // back to 40%: clearly recovered
    const r = await alerts(followId);
    expect(r[0]).toMatchObject({ resolution: "recovered" });
    // A later scare raises a fresh alert.
    await checkLiquidations(pool, world("93"), undefined, now);
    expect(
      (await alerts(followId)).filter((x) => x.resolved_ms === null).map((x) => x.level),
    ).toEqual(["warn"]);
  });

  it("doesn't flap near a threshold, and stops warning about a position that was closed", async () => {
    const { followId } = await openFollow();
    const now = Date.now();
    await checkLiquidations(pool, world("94"), undefined, now); // 60%: warn
    await checkLiquidations(pool, world("95"), undefined, now); // 50%: just under the level, not yet "recovered"
    await checkLiquidations(pool, world("94.2"), undefined, now);
    expect((await alerts(followId)).filter((a) => a.resolved_ms === null)).toHaveLength(1);
    await pool.query("UPDATE follows SET status = 'closed' WHERE id = $1", [followId]);
    await checkLiquidations(pool, world("94"), undefined, now);
    expect((await alerts(followId))[0]).toMatchObject({ resolution: "closed" });
  });

  it("works for shorts too, where liquidation is above the entry", async () => {
    const { followId } = await openFollow();
    await pool.query("UPDATE follows SET side = 'short' WHERE id = $1", [followId]);
    const short = {
      opts: { baseUrl: "http://strike", priceUrl: "http://strike/price" },
      publicGet: async (path: string) =>
        path.startsWith("/v2/positions")
          ? {
              positions: [
                {
                  id: 1,
                  symbol: "BTC-USD",
                  size: "-1",
                  entry_price: "100",
                  leverage: 10,
                  margin_mode: "isolated",
                  liquidation_price: "110",
                  upnl: "0",
                  create_timestamp: 1,
                },
              ],
            }
          : { s: "BTC-USD", p: "108.5", i: "108.5", r: "0", E: 1 },
    } as unknown as StrikeClient;
    await checkLiquidations(pool, short, undefined, Date.now());
    expect((await alerts(followId)).map((a) => a.level)).toEqual(["danger"]); // 85% of the way
  });
});
