import { BookResetError, L3Book, type L3BookSnapshot } from "@pit/shared";
import {
  getL3Snapshot,
  type L3Snapshot,
  L3Stream,
  type L3Update,
  type StrikeClient,
} from "@pit/strike-sdk";
import { errMsg, type Logger } from "../log.js";
import type { L3Store } from "./store.js";

export interface L3RecorderOptions {
  symbol: string;
  wsUrl: string;
  client: StrikeClient;
  store: L3Store;
  log: Logger;
  checkpointMs: number;
  flushMs: number;
  /** Injected for tests. */
  fetchSnapshot?: (symbol: string) => Promise<L3Snapshot>;
  stream?: Pick<L3Stream, "on" | "connect" | "disconnect">;
}

type State = "idle" | "bootstrapping" | "live";

const toBookSnapshot = (s: L3Snapshot): L3BookSnapshot => ({
  symbol: s.symbol,
  last_sequence: s.last_sequence,
  timestamp: s.timestamp,
  bids: s.bids,
  asks: s.asks,
});

/**
 * Records one market's L3 feed as gap-free segments.
 *
 * Bootstrap follows Strike's protocol: buffer updates, fetch the REST snapshot, drop buffered updates
 * at or below its sequence, apply the rest contiguously. A sequence gap, a `clear`, an unparseable
 * update or any disconnect ends the segment and starts a fresh one; we never guess through a gap.
 */
export class L3Recorder {
  private state: State = "idle";
  private book: L3Book | null = null;
  private buffer: L3Update[] = [];
  private batch: L3Update[] = [];
  private segmentId: Promise<number> | null = null;
  private lastCheckpoint = 0;
  private lastTouch = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private epoch = 0; // invalidates in-flight bootstraps
  private stopped = false;
  private readonly stream: Pick<L3Stream, "on" | "connect" | "disconnect">;
  private readonly fetchSnapshot: (symbol: string) => Promise<L3Snapshot>;
  stats = { segments: 0, updates: 0, resets: 0, lastSequence: 0 };

  constructor(private readonly o: L3RecorderOptions) {
    this.stream = o.stream ?? new L3Stream(o.wsUrl, o.symbol);
    this.fetchSnapshot = o.fetchSnapshot ?? ((s) => getL3Snapshot(o.client, s));
  }

  async start(): Promise<void> {
    const orphans = await this.o.store.closeOrphans(this.o.symbol);
    if (orphans) this.o.log.warn("closed orphaned segments from a previous run", { orphans });

    this.stream.on("update", (u) => this.onUpdate(u as L3Update));
    this.stream.on("subscribed", () => void this.bootstrap());
    this.stream.on("connected", () => {
      this.state = "bootstrapping";
      this.buffer = [];
    });
    this.stream.on("disconnected", (code) => void this.endSegment(`disconnect:${code}`));
    this.stream.on("error", (err) => this.o.log.warn("l3 stream error", { err: String(err) }));
    this.flushTimer = setInterval(() => void this.flush(), this.o.flushMs);
    this.stream.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stream.disconnect();
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.endSegment("shutdown");
  }

  private onUpdate(u: L3Update): void {
    if (this.state === "bootstrapping") {
      this.buffer.push(u);
    } else if (this.state === "live") {
      this.applyLive(u);
    }
  }

  private async bootstrap(attempt = 0): Promise<void> {
    const epoch = ++this.epoch;
    this.state = "bootstrapping";
    try {
      const snap = await this.fetchSnapshot(this.o.symbol);
      if (epoch !== this.epoch || this.stopped) return; // superseded by a newer bootstrap or disconnect

      const book = L3Book.fromSnapshot(toBookSnapshot(snap));
      const pending = this.buffer
        .filter((u) => u.sequence > snap.last_sequence)
        .sort((a, b) => a.sequence - b.sequence);
      this.buffer = [];
      if (pending[0] && pending[0].sequence !== snap.last_sequence + 1) {
        // The snapshot is older than the first update we saw: we'd miss updates. Take a fresh one.
        throw new BookResetError(
          "gap",
          `snapshot ${snap.last_sequence} vs first buffered ${pending[0].sequence}`,
        );
      }
      for (const u of pending) book.apply(u);

      this.book = book;
      this.batch = pending;
      this.segmentId = this.o.store.startSegment(this.o.symbol, toBookSnapshot(snap));
      this.lastCheckpoint = Date.now();
      this.lastTouch = Date.now();
      this.state = "live";
      this.stats.segments++;
      this.stats.updates += pending.length;
      this.stats.lastSequence = book.sequence;
      this.o.log.info("l3 segment started", {
        symbol: this.o.symbol,
        sequence: snap.last_sequence,
        buffered: pending.length,
      });
      await this.segmentId;
    } catch (e) {
      if (epoch !== this.epoch || this.stopped) return;
      this.o.log.warn("l3 bootstrap failed", { err: errMsg(e), attempt });
      this.state = "bootstrapping";
      this.buffer = [];
      if (attempt >= 5) {
        this.stream.disconnect(); // start over with a fresh connection
        this.reconnectLater();
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000)));
      if (epoch === this.epoch) await this.bootstrap(attempt + 1);
    }
  }

  private reconnectLater() {
    if (this.stopped) return;
    setTimeout(() => !this.stopped && this.stream.connect(), 5000);
  }

  private applyLive(u: L3Update): void {
    const book = this.book;
    if (!book) return;
    if (u.sequence <= book.sequence) return; // duplicate
    try {
      book.apply(u);
    } catch (e) {
      if (!(e instanceof BookResetError)) throw e;
      this.stats.resets++;
      this.o.log.warn("l3 book reset", { reason: e.reason, detail: e.message });
      void this.endSegment(`reset:${e.reason}`).then(() => {
        if (!this.stopped) void this.bootstrap();
      });
      this.state = "bootstrapping";
      // Keep the offending update: if the new snapshot is older than it, we must not lose it.
      this.buffer = e.reason === "clear" ? [] : [u];
      return;
    }
    this.batch.push(u);
    this.stats.updates++;
    this.stats.lastSequence = u.sequence;
  }

  /** Writes buffered updates, plus a checkpoint if one is due. Serialized so writes stay ordered. */
  flush(): Promise<void> {
    this.flushing = this.flushing
      .then(() => this.doFlush())
      .catch((e) => {
        this.o.log.error("l3 flush failed", { err: errMsg(e) });
      });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (!this.segmentId || !this.book) return;
    const updates = this.batch;
    this.batch = [];
    // Snapshot taken synchronously with the batch so the checkpoint matches the last written update.
    const checkpoint =
      Date.now() - this.lastCheckpoint >= this.o.checkpointMs ? this.book.toSnapshot() : null;
    if (checkpoint) this.lastCheckpoint = Date.now();
    const id = await this.segmentId;
    if (updates.length) await this.o.store.insertUpdates(id, updates);
    if (checkpoint) await this.o.store.addCheckpoint(id, checkpoint);
    if (Date.now() - this.lastTouch >= 5000) {
      this.lastTouch = Date.now();
      await this.o.store.touchSegment(id, this.lastTouch);
    }
  }

  private async endSegment(reason: string): Promise<void> {
    if (!this.segmentId || !this.book) {
      this.state = "idle";
      return;
    }
    const idPromise = this.segmentId;
    const book = this.book;
    this.segmentId = null;
    this.book = null;
    this.state = "idle";
    this.buffer = [];
    this.epoch++;
    // Persist what we have, then close the segment at the last applied update.
    const updates = this.batch;
    this.batch = [];
    try {
      const id = await idPromise;
      await this.flushing;
      if (updates.length) await this.o.store.insertUpdates(id, updates);
      // Shutdown and disconnects end an unbroken observation, so coverage runs to now even if the book
      // was quiet. After a reset we only trust the book up to its last applied update.
      const observed = reason === "shutdown" || reason.startsWith("disconnect");
      await this.o.store.endSegment(
        id,
        observed ? Date.now() : book.timestamp,
        book.sequence,
        reason,
      );
      this.o.log.info("l3 segment ended", {
        symbol: this.o.symbol,
        reason,
        sequence: book.sequence,
      });
    } catch (e) {
      this.o.log.error("failed to end l3 segment", { err: errMsg(e) });
    }
  }
}
