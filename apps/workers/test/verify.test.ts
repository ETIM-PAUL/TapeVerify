import {
  findingsFor,
  recomputeReputation,
  runDetection,
  transitionFinding,
} from "@tapeverify/verify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runVerify } from "../src/verify/job.js";
import { testPool } from "./helpers.js";

const DAY = 86_400_000;
const MIN = 60_000;
let pool: pg.Pool;
const users: string[] = [];

beforeAll(() => {
  pool = testPool();
});
// Other suites sync every user that has a Strike account, so don't leave ours lying around between tests.
async function cleanup() {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users.splice(0)]);
  await pool.query("DELETE FROM trades WHERE account_id LIKE 'verify-%'");
}
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function user(tag: string) {
  const account = `verify-${tag}-${crypto.randomUUID()}`;
  const r = await pool.query(
    "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
    [`verify-${crypto.randomUUID()}`, account],
  );
  users.push(r.rows[0].id);
  return { id: r.rows[0].id as string, account };
}

/** A caller with a real-looking record: `n` profitable round trips spread over several days. */
async function seedTrades(account: string, n: number, now: number) {
  for (let i = 0; i < n; i++) {
    const closed = now - (n - i) * 8 * 3_600_000;
    await pool.query(
      `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
       VALUES ($1,'BTC-USD','long',$2,$3,1,100,101,100,1,0.1,0,0.9)`,
      [account, closed - 600_000, closed],
    );
  }
}

/** A closed call whose followers all entered shortly before the caller sold out: the front-running shape. */
async function stageCall(callerId: string, followerIds: string[], exitAt: number, gapMs: number) {
  const entryTs = exitAt - 60 * MIN;
  const c = await pool.query(
    `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status,
                        entry_price, entry_size, entry_ts_ms, exit_price, exit_size, exit_ts_ms, exit_reason, realized_pnl)
     VALUES ($1,$2,'BTC-USD','long',3,1,$3,50,'closed',100,1,$4,101,1,$5,'manual',1) RETURNING id`,
    [crypto.randomUUID().slice(0, 8), callerId, entryTs + 1000, entryTs, exitAt],
  );
  for (const f of followerIds) {
    await pool.query(
      `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price,
                            drift_bps_at_request, status, entry_price, entry_size, entry_ts_ms, exit_price, exit_size, exit_ts_ms, exit_reason)
       VALUES ($1,$2,'BTC-USD','long',3,100,1,$3,100,100,0,'closed',100,1,$3,101,1,$4,'manual')`,
      [c.rows[0].id, f, exitAt - gapMs, exitAt + 1000],
    );
  }
}

const scoreOf = async (id: string) =>
  Number(
    (await pool.query("SELECT score FROM trader_reputation WHERE user_id = $1", [id])).rows[0]
      ?.score,
  );

describe("Trust checks end to end (staged front-running)", () => {
  it("detects a caller who keeps selling right after followers enter, and the score drops", async () => {
    const now = Date.now();
    const caller = await user("caller");
    const followers = await Promise.all([user("f1"), user("f2"), user("f3")]);
    await seedTrades(caller.account, 12, now);

    // Before anything is staged: a neutral score and a clean record.
    await recomputeReputation(pool, [caller.id], now);
    const before = await scoreOf(caller.id);
    const rep0 = (
      await pool.query("SELECT clean FROM trader_reputation WHERE user_id = $1", [caller.id])
    ).rows[0];
    expect(rep0.clean).toBe(true);

    // Four calls, each: followers pile in, the caller sells 30 seconds later into their buying.
    for (let i = 0; i < 4; i++)
      await stageCall(
        caller.id,
        followers.map((f) => f.id),
        now - (i + 1) * 5 * 3_600_000,
        30_000,
      );

    const run = await runVerify(pool, undefined, now);
    expect(run.drafts).toBeGreaterThan(0);

    const found = (await findingsFor(pool, [caller.id])).get(caller.id) ?? [];
    expect(found.some((f) => f.kind === "front_running")).toBe(true);
    expect(found.some((f) => f.kind === "front_running_pattern")).toBe(true);
    expect(found.every((f) => f.status === "open")).toBe(true);

    const after = await scoreOf(caller.id);
    expect(after).toBeLessThan(before);
    const rep1 = (
      await pool.query("SELECT clean, penalty FROM trader_reputation WHERE user_id = $1", [
        caller.id,
      ])
    ).rows[0];
    expect(rep1.clean).toBe(false);
    expect(rep1.penalty).toBeGreaterThan(0);
    const hist = await pool.query(
      "SELECT reason, previous, score FROM reputation_history WHERE user_id = $1 ORDER BY id",
      [caller.id],
    );
    expect(hist.rows.at(-1)).toMatchObject({ previous: before, score: after });
    expect(hist.rows.at(-1).reason).toMatch(/^penalty:/);

    // The summary names the behaviour but not the followers.
    for (const f of found) for (const fo of followers) expect(f.summary).not.toContain(fo.id);

    // Running again changes nothing: the same behaviour is the same finding.
    const n = (
      await pool.query("SELECT count(*) AS n FROM verify_findings WHERE subject_id = $1", [
        caller.id,
      ])
    ).rows[0].n;
    await runDetection(pool, now);
    expect(
      (
        await pool.query("SELECT count(*) AS n FROM verify_findings WHERE subject_id = $1", [
          caller.id,
        ])
      ).rows[0].n,
    ).toBe(n);
  });

  it("restores the score when a reviewer dismisses the findings", async () => {
    const now = Date.now();
    const caller = await user("caller2");
    const followers = await Promise.all([user("g1"), user("g2")]);
    await seedTrades(caller.account, 12, now);
    for (let i = 0; i < 4; i++)
      await stageCall(
        caller.id,
        followers.map((f) => f.id),
        now - (i + 1) * 5 * 3_600_000,
        20_000,
      );
    await recomputeReputation(pool, [caller.id], now - 1);
    await runDetection(pool, now);
    await recomputeReputation(pool, [caller.id], now);
    const hit = await scoreOf(caller.id);

    const open = ((await findingsFor(pool, [caller.id])).get(caller.id) ?? []).filter(
      (f) => f.status === "open",
    );
    expect(open.length).toBeGreaterThan(0);
    for (const f of open)
      expect((await transitionFinding(pool, f.id, ["open"], "dismissed", "test")).ok).toBe(true);
    // A decided finding can't be decided twice.
    expect((await transitionFinding(pool, open[0]!.id, ["open"], "confirmed", "test")).ok).toBe(
      false,
    );
    await recomputeReputation(pool, [caller.id], now + 1);

    expect(await scoreOf(caller.id)).toBeGreaterThan(hit);
    const events = await pool.query(
      "SELECT actor, to_status FROM verify_events WHERE finding_id = $1 ORDER BY id",
      [open[0]!.id],
    );
    expect(events.rows.map((e) => e.to_status)).toEqual(["open", "dismissed"]);
  });

  it("flags nothing for an ordinary caller whose followers entered long before the exit", async () => {
    const now = Date.now();
    const caller = await user("honest");
    const followers = await Promise.all([user("h1"), user("h2"), user("h3")]);
    await seedTrades(caller.account, 12, now);
    for (let i = 0; i < 4; i++)
      await stageCall(
        caller.id,
        followers.map((f) => f.id),
        now - (i + 1) * 5 * 3_600_000,
        45 * MIN,
      );
    await runDetection(pool, now);
    await recomputeReputation(pool, [caller.id], now);
    expect((await findingsFor(pool, [caller.id])).get(caller.id) ?? []).toEqual([]);
    const rep = (
      await pool.query("SELECT clean FROM trader_reputation WHERE user_id = $1", [caller.id])
    ).rows[0];
    expect(rep.clean).toBe(true);
  });
});
