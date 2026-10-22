import { recomputeReputation, runDetection } from "@pit/argus";
import type pg from "pg";
import { errMsg, type Logger } from "../log.js";

/** One Argus pass: run the detectors over what's indexed, then refresh every affected reputation. */
export async function runArgus(pool: pg.Pool, log?: Logger, now = Date.now()) {
  const d = await runDetection(pool, now);
  const users = await recomputeReputation(pool, undefined, now);
  if (d.raised) log?.warn("argus raised findings", { ...d });
  else log?.info("argus pass", { ...d, users });
  return { ...d, users };
}

export class ArgusJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly intervalMs = 5 * 60_000,
  ) {}

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await runArgus(this.pool, this.log);
      } catch (e) {
        this.log.error("argus job failed", { err: errMsg(e) });
      } finally {
        this.busy = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Runs `fn` on an interval, never overlapping itself, logging instead of throwing. */
export class Every {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(
    private readonly name: string,
    private readonly log: Logger,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<unknown>,
  ) {}

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.fn();
      } catch (e) {
        this.log.error(`${this.name} failed`, { err: errMsg(e) });
      } finally {
        this.busy = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
