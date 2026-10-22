import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accrueEarnings } from "../src/market/earnings.js";
import { testPool } from "./helpers.js";

let pool: pg.Pool;
const ids: { users: string[] } = { users: [] };

beforeAll(() => {
  pool = testPool();
});
afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [ids.users]);
  await pool.end();
});

async function user() {
  const r = await pool.query(
    "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
    [`earn-${crypto.randomUUID()}`, `acct-${crypto.randomUUID()}`],
  );
  ids.users.push(r.rows[0].id);
  return r.rows[0].id as string;
}

/** creator + listing + a clone with a live run attributed to it (or not). */
async function world(opts: { attributed?: boolean; sameUser?: boolean; shareBps?: number } = {}) {
  const creator = await user();
  const clone = opts.sameUser ? creator : await user();
  const listing = (
    await pool.query(
      "INSERT INTO listings (creator_id, title, spec, spec_hash, creator_share_bps) VALUES ($1,'t','{}','h',$2) RETURNING id",
      [creator, opts.shareBps ?? 5000],
    )
  ).rows[0].id as string;
  const run = (
    await pool.query(
      "INSERT INTO live_runs (user_id, name, market, spec, budget, network, account_id, started_ms, state, listing_id) VALUES ($1,'c','BTC-USD','{}','{}','testnet','a',1,'{}',$2) RETURNING id",
      [clone, opts.attributed === false ? null : listing],
    )
  ).rows[0].id as string;
  let seq = 0;
  const trade = async (
    o: Partial<{
      status: string;
      entryPrice: string;
      entrySize: string;
      exitPrice: string;
      bps: number | null;
    }> = {},
  ) => {
    seq++;
    const r = await pool.query(
      `INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id,
                                entry_price, entry_size, exit_price, exit_size, builder_bps)
       VALUES ($1,$2,$3,'a','BTC-USD','long',$4,3,100,1,1,1,gen_random_uuid(),$5,$6,$7,$8,$7,$9) RETURNING id`,
      [
        run,
        seq,
        clone,
        o.status ?? "closed",
        `c-${run}-${seq}`,
        o.entryPrice ?? "100",
        o.entrySize ?? "3",
        o.exitPrice ?? "102",
        o.bps === undefined ? 10 : o.bps,
      ],
    );
    return r.rows[0].id as string;
  };
  return { creator, clone, listing, run, trade };
}
const earnings = async (listing: string) =>
  (await pool.query("SELECT * FROM creator_earnings WHERE listing_id = $1 ORDER BY id", [listing]))
    .rows;

describe("accrueEarnings", () => {
  it("accrues the creator's share of the builder fee on a clone's closed trade, from the fills", async () => {
    const w = await world();
    await w.trade({ entryPrice: "100.5", entrySize: "3", exitPrice: "103.3" }); // 301.5 in, 309.9 out
    expect(await accrueEarnings(pool)).toBeGreaterThanOrEqual(1);
    const [e] = await earnings(w.listing);
    expect(e).toMatchObject({
      creator_id: w.creator,
      clone_user_id: w.clone,
      builder_bps: 10,
      creator_share_bps: 5000,
      status: "accrued",
    });
    expect(Number(e.entry_notional)).toBe(301.5);
    expect(Number(e.exit_notional)).toBe(309.9);
    // floor(301.5 x 10bps) = 0.30, floor(309.9 x 10bps) = 0.30 => fee 0.60; creator gets half
    expect(Number(e.builder_fee)).toBe(0.6);
    expect(Number(e.creator_amount)).toBe(0.3);
  });

  it("accrues each trade exactly once, however often the job runs", async () => {
    const w = await world();
    await w.trade();
    await w.trade();
    await accrueEarnings(pool);
    await accrueEarnings(pool);
    await accrueEarnings(pool);
    const rows = await earnings(w.listing);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.live_trade_id)).size).toBe(2);
    const t3 = await w.trade();
    await accrueEarnings(pool);
    expect((await earnings(w.listing)).map((r) => String(r.live_trade_id))).toContain(t3);
    expect(await earnings(w.listing)).toHaveLength(3);
  });

  it("skips trades that aren't closed, self-clones, unattributed runs, and trades with no recorded fee rate", async () => {
    const open = await world();
    await open.trade({ status: "open" });
    await open.trade({ status: "failed" });
    await open.trade({ status: "pending" });
    const own = await world({ sameUser: true });
    await own.trade();
    const loose = await world({ attributed: false });
    await loose.trade();
    const noRate = await world();
    await noRate.trade({ bps: null });
    await accrueEarnings(pool);
    for (const w of [open, own, loose, noRate]) expect(await earnings(w.listing)).toHaveLength(0);
  });

  it("uses each listing's own share and each trade's own fee rate", async () => {
    const a = await world({ shareBps: 2000 });
    const b = await world({ shareBps: 10_000 });
    await a.trade({ entryPrice: "1000", entrySize: "1", exitPrice: "1000", bps: 20 }); // 1000 x 20bps = 2.00 each way => 4.00
    await b.trade({ entryPrice: "1000", entrySize: "1", exitPrice: "1000", bps: 10 }); // 1.00 each way => 2.00
    await accrueEarnings(pool);
    const [ea] = await earnings(a.listing);
    const [eb] = await earnings(b.listing);
    expect([Number(ea.builder_fee), Number(ea.creator_amount)]).toEqual([4, 0.8]);
    expect([Number(eb.builder_fee), Number(eb.creator_amount)]).toEqual([2, 2]);
  });

  it("never rounds a creator's share up", async () => {
    const w = await world({ shareBps: 3333 });
    await w.trade({ entryPrice: "100", entrySize: "3", exitPrice: "100" }); // 300 each way => 0.30 + 0.30 = 0.60
    await accrueEarnings(pool);
    const [e] = await earnings(w.listing);
    expect(Number(e.creator_amount)).toBe(0.1999); // 0.60 x 33.33% = 0.19998 -> floored to 4 decimals
  });
});
