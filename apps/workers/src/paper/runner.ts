import {
  computeIndicators,
  type EngineState,
  type FeeModel,
  loadBars,
  marketModelFromRules,
  StrategyEngine,
  type StrategySpec,
  strategySpecSchema,
  TIMEFRAME_BAR_MS,
} from "@tapeverify/shared";
import {
  getFeeTiers,
  getMarketRules,
  getMarkPrice,
  type MarketRules,
  type StrikeClient,
} from "@tapeverify/strike-sdk";
import type pg from "pg";
import { errMsg, type Logger } from "../log.js";

interface Session {
  id: string;
  spec: unknown;
  params: { slippageBps: number };
  status: "running" | "stopping";
  started_ms: string;
  state: EngineState;
  last_bar_ms: string | null;
}

export interface PaperOptions {
  intervalMs: number;
  builderBps: number;
  /** Candles kept before the first tradable one, to warm indicators up. */
  extraWarmup: number;
}

/**
 * Runs paper sessions: the same engine as the backtester, on closed candles from the indexer plus live
 * mark prices. Nothing here can place a real order: it has no wallet keys and no Strike trading access.
 *
 * Per tick and session: replay any newly closed candles (fill, protect, evaluate), fill a fresh signal at
 * the live price, then check the stop, target and liquidation levels against the live price.
 */
export class PaperRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private rules: { at: number; v: Record<string, MarketRules> } | null = null;
  private taker: { at: number; v: number } | null = null;

  constructor(
    private readonly client: StrikeClient,
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly opts: PaperOptions,
  ) {}

  private async marketRules() {
    if (!this.rules || Date.now() - this.rules.at > 5 * 60_000)
      this.rules = { at: Date.now(), v: await getMarketRules(this.client) };
    return this.rules.v;
  }

  private async takerRate(): Promise<number> {
    if (!this.taker || Date.now() - this.taker.at > 10 * 60_000) {
      let v = 0.0005;
      try {
        const t = (await getFeeTiers(this.client)).feeTiers;
        v = (t.find((x) => x.Tier === 0) ?? t[0])?.TakerRate ?? v;
      } catch {
        /* keep Strike's tier-0 rate */
      }
      this.taker = { at: Date.now(), v };
    }
    return this.taker.v;
  }

  async tick(now = Date.now()): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT id FROM paper_sessions WHERE status IN ('running', 'stopping')",
    );
    let done = 0;
    for (const r of rows) {
      try {
        if (await this.processSession(r.id as string, now)) done++;
      } catch (e) {
        this.log.warn("paper session failed", { id: r.id, err: errMsg(e) });
      }
    }
    return done;
  }

  /** Processes one session under a row lock so two runners can never act on it at once. */
  async processSession(id: string, now: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT id, spec, params, status, started_ms, state, last_bar_ms FROM paper_sessions WHERE id = $1 AND status IN ('running', 'stopping') FOR UPDATE SKIP LOCKED",
        [id],
      );
      const s = rows[0] as Session | undefined;
      if (!s) {
        await client.query("ROLLBACK");
        return false;
      }
      const parsed = strategySpecSchema.safeParse(s.spec);
      if (!parsed.success) {
        await client.query(
          "UPDATE paper_sessions SET status = 'stopped', stop_reason = 'invalid_spec', stopped_at = now() WHERE id = $1",
          [id],
        );
        await client.query("COMMIT");
        return true;
      }
      await this.advance(client, s, parsed.data, now);
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private async advance(db: pg.PoolClient, s: Session, spec: StrategySpec, now: number) {
    const rules = (await this.marketRules())[spec.market];
    if (!rules) throw new Error(`unknown market ${spec.market}`);
    const mark = await getMarkPrice(this.client, spec.market);
    const price = Number(mark.p);
    if (!Number.isFinite(price) || price <= 0) throw new Error("no live price");
    const fundingNow = Number(mark.r);

    const fees: FeeModel = {
      takerRate: await this.takerRate(),
      builderBps: this.opts.builderBps,
      slippageBps: s.params.slippageBps,
    };
    const engine = new StrategyEngine(
      { spec, market: marketModelFromRules(rules as never), fees },
      s.state,
    );
    const tfMs = TIMEFRAME_BAR_MS[spec.timeframe];
    const currentBarT = Math.floor(now / tfMs) * tfMs;
    const maxPeriod = Math.max(0, ...spec.indicators.map((i) => i.period ?? 0));
    const startedMs = Number(s.started_ms);
    const lastProcessed = s.last_bar_ms === null ? null : Number(s.last_bar_ms);

    const bars = await loadBars(this.pool, {
      symbol: spec.market,
      interval: spec.timeframe,
      priceType: "mark",
      from: currentBarT - (maxPeriod + this.opts.extraWarmup + 5) * tfMs,
      to: currentBarT,
    });
    const funding = bars.map(() => null) as Array<number | null>;
    if (
      funding.length &&
      bars[bars.length - 1]?.t === currentBarT - tfMs &&
      Number.isFinite(fundingNow)
    ) {
      funding[funding.length - 1] = fundingNow; // only the newest candle can use the live funding rate
    }
    const ind = computeIndicators(spec.indicators, bars, funding);

    const trades: Array<{ seq: number; trade: unknown; exitTs: number; net: number }> = [];
    const collect = (events: ReturnType<StrategyEngine["step"]>) => {
      for (const e of events)
        if (e.type === "trade")
          trades.push({
            seq: e.trade.id,
            trade: e.trade,
            exitTs: e.trade.exitTs,
            net: e.trade.netPnl,
          });
    };

    let lastBar = lastProcessed;
    if (s.status === "running") {
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (!b || b.t < startedMs || (lastProcessed !== null && b.t <= lastProcessed)) continue;
        collect(engine.step(bars, ind, i));
        lastBar = b.t;
      }
      // A signal from the newest closed candle fills now, at the live price.
      if (engine.state.pending) collect(engine.fillPending(price, now, { midBarT: currentBarT }));
      // Stops, targets and liquidation against the live price between candle closes.
      collect(engine.protective({ o: price, h: price, l: price }, now, { tick: true }));
    } else {
      collect(engine.flatten(price, now, "manual"));
    }

    const st = engine.state;
    let status: string = s.status;
    let stopReason: string | null = null;
    if (s.status === "stopping") {
      status = "stopped";
      stopReason = "stopped_by_user";
    } else if (st.halted && !st.position) {
      status = "halted";
      stopReason = st.halted;
    }

    for (const t of trades) {
      await db.query(
        "INSERT INTO paper_trades (session_id, seq, trade, exit_ts, net_pnl) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [s.id, t.seq, JSON.stringify(t.trade), t.exitTs, t.net],
      );
    }
    const minute = Math.floor(now / 60_000) * 60_000;
    await db.query(
      "INSERT INTO paper_equity (session_id, ts_ms, equity) VALUES ($1,$2,$3) ON CONFLICT (session_id, ts_ms) DO UPDATE SET equity = EXCLUDED.equity",
      [s.id, minute, engine.markToMarket(price)],
    );
    await db.query(
      `UPDATE paper_sessions SET state = $2, last_bar_ms = $3, last_price = $4, last_tick_ms = $5, status = $6, stop_reason = $7,
              stopped_at = CASE WHEN $6 IN ('stopped', 'halted') THEN now() ELSE stopped_at END, updated_at = now() WHERE id = $1`,
      [s.id, JSON.stringify(st), lastBar, price, now, status, stopReason],
    );
    if (trades.length) this.log.info("paper trades", { id: s.id, n: trades.length, status });
  }

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.tick();
      } catch (e) {
        this.log.error("paper tick failed", { err: errMsg(e) });
      } finally {
        this.busy = false;
      }
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
