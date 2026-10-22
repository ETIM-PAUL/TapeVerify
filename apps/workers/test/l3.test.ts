import { L3Book, sameBook } from "@tapeverify/shared";
import type { L3Snapshot, StrikeClient } from "@tapeverify/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CoverageError, l3Coverage, rebuildBookAt } from "../src/l3/rebuild.js";
import { L3Recorder } from "../src/l3/recorder.js";
import { L3Store } from "../src/l3/store.js";
import { silentLogger } from "../src/log.js";
import { baseSnapshot, clean, FakeStream, generate, testPool, until } from "./helpers.js";

const SYMBOL = "TEST-L3";
let pool: pg.Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => {
  await clean(pool, SYMBOL);
  await pool.end();
});
beforeEach(() => clean(pool, SYMBOL));

function setup(snapshots: L3Snapshot[], checkpointMs = 0) {
  const stream = new FakeStream();
  const queue = [...snapshots];
  const recorder = new L3Recorder({
    symbol: SYMBOL,
    wsUrl: "ws://unused",
    client: {} as StrikeClient,
    store: new L3Store(pool),
    log: silentLogger,
    checkpointMs,
    flushMs: 1_000_000, // tests flush explicitly
    fetchSnapshot: async () => queue.shift() ?? (snapshots.at(-1) as L3Snapshot),
    stream: stream as never,
  });
  const open = async () => {
    stream.emit("connected");
    stream.emit("subscribed");
  };
  return { stream, recorder, open };
}

describe("L3 recording and exact rebuild", () => {
  it("rebuilds the exact book at every update, across checkpoints", async () => {
    const snap = baseSnapshot(SYMBOL, 1000, 1_700_000_000_000);
    const gen = generate(snap, 300, 42);
    const { stream, recorder, open } = setup([snap], 0); // checkpoint on every flush
    await recorder.start();
    await open();
    await until(() => recorder.stats.segments === 1);

    // Feed in bursts with flushes between so checkpoints land mid-stream.
    for (let i = 0; i < gen.updates.length; i += 40) {
      for (const u of gen.updates.slice(i, i + 40)) stream.emit("update", u);
      await recorder.flush();
    }
    await recorder.stop();

    const { rows } = await pool.query(
      "SELECT count(*) AS n FROM l3_snapshots s JOIN l3_segments g ON g.id = s.segment_id WHERE g.symbol = $1",
      [SYMBOL],
    );
    expect(Number(rows[0].n)).toBeGreaterThan(3); // bootstrap + checkpoints

    for (let i = 0; i < gen.updates.length; i++) {
      const at = (gen.updates[i] as { timestamp: number }).timestamp;
      const r = await rebuildBookAt(pool, SYMBOL, at);
      expect(sameBook(r.book.toSnapshot(), gen.states[i] as never), `at update ${i}`).toBe(true);
      expect(r.book.sequence).toBe((gen.updates[i] as { sequence: number }).sequence);
    }
    // Between updates the book is the previous state.
    const mid = (gen.updates[10] as { timestamp: number }).timestamp + 3;
    expect(
      sameBook((await rebuildBookAt(pool, SYMBOL, mid)).book.toSnapshot(), gen.states[10] as never),
    ).toBe(true);
  });

  it("drops buffered updates at or below the snapshot sequence and applies the rest", async () => {
    const snap = baseSnapshot(SYMBOL, 1000, 1_700_000_000_000);
    const gen = generate(snap, 20, 7);
    const { stream, recorder } = setup([
      {
        ...snap,
        last_sequence: 1010,
        timestamp: (gen.updates[9] as { timestamp: number }).timestamp,
        ...rebuildFrom(snap, gen, 10),
      },
    ]);
    await recorder.start();
    stream.emit("connected");
    for (const u of gen.updates) stream.emit("update", u); // all 20 arrive before the snapshot returns
    stream.emit("subscribed");
    await until(() => recorder.stats.segments === 1);
    await recorder.flush();
    expect(recorder.stats.lastSequence).toBe(1020);
    const r = await rebuildBookAt(
      pool,
      SYMBOL,
      (gen.updates[19] as { timestamp: number }).timestamp,
    );
    expect(sameBook(r.book.toSnapshot(), gen.states[19] as never)).toBe(true);
    await recorder.stop();
  });

  it("ends the segment on a sequence gap and starts a new one from a fresh snapshot", async () => {
    const snap = baseSnapshot(SYMBOL, 1000, 1_700_000_000_000);
    const gen = generate(snap, 30, 9);
    const after = {
      ...snap,
      last_sequence: 1030,
      timestamp: (gen.updates[29] as { timestamp: number }).timestamp + 500,
      ...rebuildFrom(snap, gen, 30),
    };
    const { stream, recorder, open } = setup([snap, after]);
    await recorder.start();
    await open();
    await until(() => recorder.stats.segments === 1);
    for (const u of gen.updates.slice(0, 10)) stream.emit("update", u);
    stream.emit("update", gen.updates[12]); // skips 1011 and 1012 -> gap
    await until(() => recorder.stats.resets === 1);
    // Updates arriving while re-bootstrapping are buffered; the next snapshot supersedes them.
    await until(() => recorder.stats.segments === 2);
    await recorder.flush();
    await recorder.stop();

    const { rows } = await pool.query(
      "SELECT start_sequence, end_sequence, end_reason FROM l3_segments WHERE symbol = $1 ORDER BY id",
      [SYMBOL],
    );
    expect(rows.map((r) => r.end_reason)).toEqual(["reset:gap", "shutdown"]);
    expect(Number(rows[0].end_sequence)).toBe(1010);
    expect(Number(rows[1].start_sequence)).toBe(1030);
    // A time inside the gap can't be rebuilt: it must be refused, not guessed.
    const inGap = (gen.updates[9] as { timestamp: number }).timestamp + 100;
    await expect(rebuildBookAt(pool, SYMBOL, inGap)).rejects.toBeInstanceOf(CoverageError);
    // Both sides of the gap still rebuild exactly.
    expect(
      sameBook(
        (
          await rebuildBookAt(pool, SYMBOL, (gen.updates[9] as { timestamp: number }).timestamp)
        ).book.toSnapshot(),
        gen.states[9] as never,
      ),
    ).toBe(true);
    expect(
      sameBook(
        (await rebuildBookAt(pool, SYMBOL, after.timestamp)).book.toSnapshot(),
        gen.states[29] as never,
      ),
    ).toBe(true);
  });

  it("re-bootstraps on clear and on disconnect, recording why", async () => {
    const snap = baseSnapshot(SYMBOL, 500, 1_700_000_000_000);
    const gen = generate(snap, 5, 3);
    const { stream, recorder, open } = setup([
      snap,
      { ...snap, last_sequence: 600, timestamp: snap.timestamp + 1000 },
      { ...snap, last_sequence: 700, timestamp: snap.timestamp + 2000 },
    ]);
    await recorder.start();
    await open();
    await until(() => recorder.stats.segments === 1);
    for (const u of gen.updates) stream.emit("update", u);
    stream.emit("update", {
      type: "l3_update",
      symbol: SYMBOL,
      action: "clear",
      sequence: 506,
      timestamp: snap.timestamp + 100,
    });
    await until(() => recorder.stats.segments === 2);
    stream.emit("disconnected", 1012);
    await new Promise((r) => setTimeout(r, 30));
    await open();
    await until(() => recorder.stats.segments === 3);
    await recorder.stop();
    const { rows } = await pool.query(
      "SELECT end_reason FROM l3_segments WHERE symbol = $1 ORDER BY id",
      [SYMBOL],
    );
    expect(rows.map((r) => r.end_reason)).toEqual(["reset:clear", "disconnect:1012", "shutdown"]);
  });

  it("closes segments orphaned by a crash at their last persisted update", async () => {
    const snap = baseSnapshot(SYMBOL, 10, 1_700_000_000_000);
    const store = new L3Store(pool);
    const id = await store.startSegment(SYMBOL, snap as never);
    const gen = generate(snap, 3, 1);
    await store.insertUpdates(id, gen.updates);
    const { recorder } = setup([snap]);
    await recorder.start();
    const { rows } = await pool.query(
      "SELECT end_ts, end_sequence, end_reason FROM l3_segments WHERE id = $1",
      [id],
    );
    expect(rows[0].end_reason).toBe("crash");
    expect(Number(rows[0].end_sequence)).toBe(13);
    expect(Number(rows[0].end_ts)).toBe((gen.updates[2] as { timestamp: number }).timestamp);
    await recorder.stop();
  });

  it("covers a quiet book up to shutdown even though it emitted no updates", async () => {
    const snap = baseSnapshot(SYMBOL, 50, Date.now() - 2000);
    const { recorder, open } = setup([snap]);
    await recorder.start();
    await open();
    await until(() => recorder.stats.segments === 1);
    await new Promise((r) => setTimeout(r, 60));
    await recorder.stop();
    const { rows } = await pool.query(
      "SELECT start_ts, end_ts FROM l3_segments WHERE symbol = $1",
      [SYMBOL],
    );
    expect(Number(rows[0].end_ts)).toBeGreaterThan(Number(rows[0].start_ts) + 1500);
    const at = Number(rows[0].end_ts) - 10;
    const r = await rebuildBookAt(pool, SYMBOL, at);
    expect(r.replayed).toBe(0);
    expect(r.book.orderCount).toBe(5);
  });

  it("closes an orphaned quiet segment at its last_seen time", async () => {
    const store = new L3Store(pool);
    const id = await store.startSegment(SYMBOL, baseSnapshot(SYMBOL, 5, 1000) as never);
    await store.touchSegment(id, 9000);
    expect(await store.closeOrphans(SYMBOL)).toBe(1);
    const { rows } = await pool.query("SELECT end_ts, end_reason FROM l3_segments WHERE id = $1", [
      id,
    ]);
    expect([Number(rows[0].end_ts), rows[0].end_reason]).toEqual([9000, "crash"]);
  });

  it("reports coverage and gaps", async () => {
    const store = new L3Store(pool);
    const s1 = await store.startSegment(SYMBOL, baseSnapshot(SYMBOL, 1, 1000) as never);
    await store.endSegment(s1, 5000, 9, "disconnect:1006");
    const s2 = await store.startSegment(SYMBOL, baseSnapshot(SYMBOL, 20, 8000) as never);
    await store.endSegment(s2, 10_000, 30, "shutdown");
    const c = await l3Coverage(pool, SYMBOL, 0, 12_000);
    expect(c.segments).toHaveLength(2);
    expect(c.gaps).toEqual([
      { from: 0, to: 1000 },
      { from: 5000, to: 8000 },
      { from: 10_000, to: 12_000 },
    ]);
    expect(c.coveredMs).toBe(4000 + 2000);
    await expect(rebuildBookAt(pool, SYMBOL, 6000)).rejects.toThrow(/not recorded/);
    await expect(rebuildBookAt(pool, "NOPE-USD", 6000)).rejects.toThrow(/No L3 data/);
  });
});

/** Snapshot body (bids/asks) equal to the reference book after `n` updates. */
function rebuildFrom(_snap: L3Snapshot, gen: ReturnType<typeof generate>, n: number) {
  const s = gen.states[n - 1] as { bids: L3Snapshot["bids"]; asks: L3Snapshot["asks"] };
  return { bids: s.bids, asks: s.asks };
}

describe("sanity", () => {
  it("the generator only produces updates the book accepts", () => {
    const snap = baseSnapshot(SYMBOL, 1, 1);
    const g = generate(snap, 500, 123);
    const b = L3Book.fromSnapshot(snap);
    for (const u of g.updates) b.apply(u);
    expect(sameBook(b.toSnapshot(), g.states.at(-1) as never)).toBe(true);
  });
});
