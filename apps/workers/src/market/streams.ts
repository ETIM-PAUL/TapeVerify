import { PriceStream } from "@pit/strike-sdk";
import type pg from "pg";
import type { WorkerConfig } from "../config.js";
import { errMsg, type Logger } from "../log.js";
import { insertRows } from "../sql.js";

interface MarkEvent {
  s: string;
  p: string;
  i: string;
  r?: string;
  E: number;
}
interface TradeEvent {
  s: string;
  t: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

/**
 * Public price stream recorder: mark prices (all markets), trades and 1m klines.
 * Trades have no history endpoint beyond the latest 1000, so streaming is the only way to keep them.
 */
export class PriceRecorder {
  private stream: PriceStream;
  private marks: unknown[][] = [];
  private trades: unknown[][] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMark = new Map<string, number>();
  stats = { marks: 0, trades: 0 };

  constructor(
    wsUrl: string,
    private readonly pool: pg.Pool,
    private readonly symbols: string[],
    private readonly cfg: WorkerConfig,
    private readonly log: Logger,
  ) {
    this.stream = new PriceStream(wsUrl);
  }

  start(): void {
    this.stream.on("markPriceUpdate", (d) => this.onMark(d as MarkEvent));
    this.stream.on("trade", (d) => this.onTrade(d as TradeEvent));
    this.stream.on("connected", () => this.log.info("price stream connected"));
    this.stream.on("disconnected", (code) => this.log.warn("price stream disconnected", { code }));
    this.stream.subscribe("!markprice@arr");
    for (const s of this.symbols) this.stream.subscribe("trade", s);
    this.stream.connect();
    this.timer = setInterval(() => void this.flush(), 2000);
  }

  private onMark(m: MarkEvent) {
    // The feed ticks every 3s per market; keep each tick once.
    if (this.lastMark.get(m.s) === m.E) return;
    this.lastMark.set(m.s, m.E);
    this.marks.push([m.s, m.E, m.p, m.i, m.r ?? null]);
  }

  private onTrade(t: TradeEvent) {
    this.trades.push([t.s, t.t, t.p, t.q, t.T, t.m]);
  }

  async flush(): Promise<void> {
    const marks = this.marks;
    const trades = this.trades;
    this.marks = [];
    this.trades = [];
    try {
      if (marks.length)
        this.stats.marks += await insertRows(
          this.pool,
          "mark_prices",
          ["symbol", "ts_ms", "mark_price", "index_price", "funding_rate"],
          marks,
          "ON CONFLICT DO NOTHING",
        );
      if (trades.length)
        this.stats.trades += await insertRows(
          this.pool,
          "market_trades",
          ["symbol", "trade_id", "price", "qty", "time_ms", "is_buyer_maker"],
          trades,
          "ON CONFLICT DO NOTHING",
        );
    } catch (e) {
      this.log.error("price flush failed", { err: errMsg(e) });
      this.marks.unshift(...marks); // retry next tick
      this.trades.unshift(...trades);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stream.disconnect();
    await this.flush();
  }
}
