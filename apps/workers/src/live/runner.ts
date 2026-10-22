import {
  type Bar,
  computeIndicators,
  dayOf,
  decideOnClose,
  effectiveLossCap,
  type LiveBudget,
  type LiveEnvLimits,
  loadBars,
  type MarketRulesLite,
  planLiveEntry,
  ReconnectRequiredError,
  type StrategySpec,
  type StrikeGateway,
  strategySpecSchema,
  TIMEFRAME_BAR_MS,
} from "@tapeverify/shared";
import {
  cancelOrder,
  closePositionOrder,
  getAccount,
  getAccountOrders,
  getFeeTiers,
  getMarkPrice,
  getSubAccounts,
  placeStrategyOrder,
  placeTrailingStop,
  StrikeApiError,
  type StrikeClient,
  setLeverage,
} from "@tapeverify/strike-sdk";
import type pg from "pg";
import { type TrackedCall, trackCall } from "../calls/tracker.js";
import { errMsg, type Logger } from "../log.js";
import { audit } from "./audit.js";
import { defaultSleep, isDefiniteRejection, isRateLimited, withRetry } from "./retry.js";

export interface LiveOptions {
  intervalMs: number;
  network: "testnet" | "mainnet";
  builderBps: number;
  limits: LiveEnvLimits;
  /** Slippage allowance used when checking a trade's worst case against the loss cap. */
  slippageBps: number;
  /** Consecutive order failures after which a run stops itself. */
  maxFailures: number;
  /** Candles older than this when the runner sees them are not acted on. */
  maxSignalAgeMs: number;
  /** Row of `system_flags` holding the operator's emergency stop. Tests use their own so they never touch the real one. */
  emergencyFlagKey?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface RunState {
  day: number | null;
  tradesToday: number;
  barsSinceExit: number | null;
  signalSeq: number;
  failures: number;
  lastHandledSeq: number;
}

interface Run {
  id: string;
  user_id: string;
  name: string;
  market: string;
  spec: unknown;
  budget: LiveBudget;
  network: string;
  sub_account_id: string | null;
  account_id: string;
  status: "active" | "stopping";
  stop_reason: string | null;
  started_ms: string;
  last_bar_ms: string | null;
  state: RunState;
}

interface Trade {
  id: string;
  seq: number;
  symbol: string;
  side: "long" | "short";
  status: "planned" | "pending" | "open" | "closed" | "failed";
  size: string;
  margin_usd: string;
  sl_price: string;
  strategy_id: string;
  primary_client_order_id: string;
  tp_client_order_id: string | null;
  sl_client_order_id: string | null;
  trail_client_order_id: string | null;
  close_client_order_id: string | null;
  close_requested_at: string | null;
  close_reason_hint: string | null;
  trail_pct: string | null;
  sent_at: string | null;
  entry_trade_id: string | null;
  entry_size: string | null;
  entry_ts_ms: string | null;
  entry_price: string | null;
  entry_fee: string | null;
  exit_fee: string | null;
  realized_pnl: string | null;
  exit_reason: string | null;
  fail_reason: string | null;
  bars_held: number;
  created_ms: string;
}

const HALT_REASONS = new Set([
  "max_loss",
  "budget_exhausted",
  "emergency_stop",
  "protection_lost",
  "wallet_revoked",
  "loss_cap",
]);

/**
 * Runs strategies on real accounts. It decides with the same function as the backtester and paper mode,
 * but never trusts its own bookkeeping about the exchange: positions, fills and losses always come back
 * from Strike's own records.
 *
 * Safety properties (each covered by tests):
 *  - every cap (margin, balance, loss budget) is checked before an order is sent, including the worst case
 *    of the stop-loss fill; stops live on Strike as bracket orders, so they protect the position even if
 *    this process dies;
 *  - the intent is written to the database before the order is sent, and an entry is sent at most once:
 *    after a crash or an unclear failure the runner looks at Strike's history, it never re-sends blindly;
 *  - exits are reduce-only, so they are retried freely until the position is flat;
 *  - a loss cap, a global emergency stop, a per-run stop, a revoked wallet, lost protective orders or
 *    repeated order failures all flatten the position and stop the run;
 *  - everything it decides or does is appended to the audit log.
 */
export class LiveRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private taker: { at: number; v: number } | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly gateway: StrikeGateway,
    private readonly log: Logger,
    private readonly opts: LiveOptions,
  ) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  // ── Scheduling ──

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.tick();
      } catch (e) {
        this.log.error("live tick failed", { err: errMsg(e) });
      } finally {
        this.busy = false;
      }
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT id FROM live_runs WHERE status IN ('active', 'stopping') AND network = $1",
      [this.opts.network],
    );
    let n = 0;
    for (const r of rows) {
      try {
        if (await this.processRun(r.id as string, now)) n++;
      } catch (e) {
        this.log.error("live run failed", { id: r.id, err: errMsg(e) });
      }
    }
    return n;
  }

  /** One run, one runner at a time: a Postgres advisory lock, held on its own connection. */
  async processRun(id: string, now: number): Promise<boolean> {
    const lockConn = await this.pool.connect();
    try {
      const got = await lockConn.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
        [`live:${id}`],
      );
      if (!got.rows[0].ok) return false;
      try {
        await this.step(id, now);
        return true;
      } finally {
        await lockConn.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`live:${id}`]);
      }
    } finally {
      lockConn.release();
    }
  }

  // ── Helpers ──

  private async run(id: string): Promise<Run | null> {
    const { rows } = await this.pool.query(
      "SELECT id, user_id, name, market, spec, budget, network, sub_account_id, account_id, status, stop_reason, started_ms, last_bar_ms, state FROM live_runs WHERE id = $1 AND status IN ('active', 'stopping')",
      [id],
    );
    return (rows[0] as Run | undefined) ?? null;
  }

  private async save(run: Run) {
    await this.pool.query(
      "UPDATE live_runs SET state = $2, last_bar_ms = $3, updated_at = now() WHERE id = $1",
      [run.id, JSON.stringify(run.state), run.last_bar_ms],
    );
  }

  private async setStopping(run: Run, reason: string, now: number) {
    if (run.status === "stopping") return;
    run.status = "stopping";
    run.stop_reason = reason;
    await this.pool.query(
      "UPDATE live_runs SET status = 'stopping', stop_reason = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
      [run.id, reason],
    );
    await audit(this.pool, run.id, "halt", { reason }, now);
  }

  private async takerRate(anon: StrikeClient): Promise<number> {
    if (!this.taker || Date.now() - this.taker.at > 10 * 60_000) {
      let v = 0.0005;
      try {
        const t = (await getFeeTiers(anon)).feeTiers;
        v = (t.find((x) => x.Tier === 0) ?? t[0])?.TakerRate ?? v;
      } catch {
        /* Strike's tier-0 rate */
      }
      this.taker = { at: Date.now(), v };
    }
    return this.taker.v;
  }

  private trades(runId: string, statuses: string[]): Promise<Trade[]> {
    return this.pool
      .query(
        `SELECT t.*, (extract(epoch FROM t.created_at) * 1000)::bigint AS created_ms FROM live_trades t
          WHERE t.run_id = $1 AND t.status = ANY($2) ORDER BY t.seq`,
        [runId, statuses],
      )
      .then((r) => r.rows as Trade[]);
  }

  private tracked(t: Trade, run: Run): TrackedCall {
    return {
      id: t.id,
      user_id: run.user_id,
      symbol: t.symbol,
      side: t.side,
      status: t.status as "pending" | "open",
      strategy_id: t.strategy_id,
      primary_client_order_id: t.primary_client_order_id,
      tp_client_order_id: t.tp_client_order_id,
      sl_client_order_id: t.sl_client_order_id,
      trail_client_order_id: t.trail_client_order_id,
      entry_trade_id: t.entry_trade_id,
      entry_size: t.entry_size,
      entry_ts_ms: t.entry_ts_ms,
      created_ms: t.sent_at ?? t.created_ms,
      strike_account_id: run.account_id,
    };
  }

  /** Net result of closed trades so far: realized PnL minus both commissions (positive = profit). */
  private async realizedNet(runId: string): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COALESCE(sum(COALESCE(realized_pnl, 0) - COALESCE(entry_fee, 0) - COALESCE(exit_fee, 0)), 0) AS net FROM live_trades WHERE run_id = $1 AND status = 'closed'",
      [runId],
    );
    return Number(rows[0].net);
  }

  private async availableUsd(run: Run, c: StrikeClient): Promise<number> {
    if (run.sub_account_id) {
      const subs = (await getSubAccounts(c)).sub_accounts;
      const mine = subs.find((s) => s.account_id === run.sub_account_id);
      return Number(mine?.available_balance ?? 0);
    }
    return Number((await getAccount(c)).available_balance);
  }

  // ── One pass over a run ──

  private async step(id: string, now: number) {
    let run = await this.run(id);
    if (!run || run.network !== this.opts.network) return;

    const flag = await this.pool.query("SELECT value FROM system_flags WHERE key = $1", [
      this.opts.emergencyFlagKey ?? "emergency_stop",
    ]);
    if (flag.rows[0]?.value === true) await this.setStopping(run, "emergency_stop", now);

    try {
      await this.gateway.run(run.user_id, (c) => this.stepWithClient(run as Run, c, now));
    } catch (e) {
      if (e instanceof ReconnectRequiredError) {
        // We can't sign for this user any more. Their stop-loss orders still stand on Strike.
        run = (await this.run(id)) ?? run;
        await this.pool.query(
          "UPDATE live_runs SET status = 'halted', stop_reason = 'wallet_revoked', stopped_at = now(), updated_at = now() WHERE id = $1",
          [id],
        );
        await audit(
          this.pool,
          id,
          "halt",
          {
            reason: "wallet_revoked",
            note: "API wallet expired or revoked; protective orders remain on Strike",
          },
          now,
        );
        return;
      }
      await audit(this.pool, id, "error", { message: errMsg(e) }, now).catch(() => {});
      throw e;
    }
  }

  private async stepWithClient(run: Run, c: StrikeClient, now: number) {
    const anon = await this.gateway.anon();
    const spec = strategySpecSchema.safeParse(run.spec);
    if (!spec.success) {
      await this.setStopping(run, "error:invalid_spec", now);
      return;
    }

    await this.reconcile(run, anon, c, now);
    const loss = Math.max(0, -(await this.realizedNet(run.id)));
    const cap = effectiveLossCap(spec.data, run.budget);
    if (run.status === "active" && loss >= cap) await this.setStopping(run, "max_loss", now);

    const open = (await this.trades(run.id, ["open"]))[0];
    if (open) await this.manageOpen(run, open, spec.data, anon, c, loss, cap, now);

    if (run.status === "stopping") {
      await this.drive(run, c, anon, now);
      return;
    }
    await this.evaluate(run, spec.data, anon, c, loss, now);
  }

  /** Track every unfinished trade from Strike's records, then account for the ones that just finished. */
  private async reconcile(run: Run, anon: StrikeClient, c: StrikeClient, now: number) {
    for (const t of await this.trades(run.id, ["planned"])) {
      // Never sent (we write 'pending' before sending): the moment has passed, so drop it.
      await this.pool.query(
        "UPDATE live_trades SET status = 'failed', fail_reason = 'abandoned_before_send', updated_at = now() WHERE id = $1 AND status = 'planned'",
        [t.id],
      );
    }
    for (const t of await this.trades(run.id, ["pending", "open"])) {
      await trackCall(anon, this.pool, this.tracked(t, run), now, "live_trades");
      await this.syncLegs(run, t, anon);
    }

    const done = (await this.trades(run.id, ["closed", "failed"])).filter(
      (t) => t.seq > run.state.lastHandledSeq,
    );
    for (const t of done) {
      run.state.lastHandledSeq = t.seq;
      if (t.status === "closed") {
        // A close we asked for keeps our reason; the tracker only knows the order was ours.
        const reason =
          t.exit_reason === "manual" && t.close_reason_hint ? t.close_reason_hint : t.exit_reason;
        if (reason !== t.exit_reason)
          await this.pool.query("UPDATE live_trades SET exit_reason = $2 WHERE id = $1", [
            t.id,
            reason,
          ]);
        run.state.barsSinceExit = 0;
        run.state.failures = 0;
        const net =
          Number(t.realized_pnl ?? 0) - Number(t.entry_fee ?? 0) - Number(t.exit_fee ?? 0);
        await audit(this.pool, run.id, "trade_closed", { seq: t.seq, reason, net }, now);
        await this.cancelLegs(run, t, c);
      } else {
        run.state.failures++;
        await audit(this.pool, run.id, "trade_failed", { seq: t.seq, reason: t.fail_reason }, now);
        if (run.state.failures >= this.opts.maxFailures && run.status === "active")
          await this.setStopping(run, "error:too_many_order_failures", now);
      }
    }
    if (done.length) await this.save(run);
  }

  /** Fill in the ids of the stop and target legs from Strike's order history (needed for exit reasons and for checks). */
  private async syncLegs(run: Run, t: Trade, anon: StrikeClient) {
    if (t.tp_client_order_id && t.sl_client_order_id) return;
    const orders = await getAccountOrders(anon, run.account_id, { symbol: t.symbol, limit: 100 });
    const legs = orders.filter((o) => o.strategy_id === t.strategy_id && o.is_primary === false);
    const sl = legs.find((o) => o.type === "stop" || o.type === "stop_limit");
    const tp = legs.find((o) => o.type === "take_profit" || o.type === "take_profit_limit");
    if ((sl && !t.sl_client_order_id) || (tp && !t.tp_client_order_id)) {
      await this.pool.query(
        "UPDATE live_trades SET sl_client_order_id = COALESCE(sl_client_order_id, $2), tp_client_order_id = COALESCE(tp_client_order_id, $3) WHERE id = $1",
        [t.id, sl?.client_order_id ?? null, tp?.client_order_id ?? null],
      );
      t.sl_client_order_id ??= sl?.client_order_id ?? null;
      t.tp_client_order_id ??= tp?.client_order_id ?? null;
    }
  }

  private async cancelLegs(run: Run, t: Trade, c: StrikeClient) {
    for (const cid of [t.tp_client_order_id, t.sl_client_order_id, t.trail_client_order_id]) {
      if (cid)
        await cancelOrder(c, {
          symbol: t.symbol,
          client_order_id: cid,
          ...(run.sub_account_id ? {} : {}),
        }).catch(() => undefined);
    }
  }

  // ── An open position ──

  private async manageOpen(
    run: Run,
    t: Trade,
    spec: StrategySpec,
    anon: StrikeClient,
    c: StrikeClient,
    realizedLoss: number,
    cap: number,
    now: number,
  ) {
    const dir = t.side === "long" ? 1 : -1;
    const entry = Number(t.entry_price);
    const size = Number(t.entry_size ?? t.size);

    // 1. The loss cap holds even while a trade is still open: realized + unrealized loss.
    let unrealizedLoss = 0;
    try {
      const mark = Number((await getMarkPrice(anon, t.symbol)).p);
      if (Number.isFinite(mark) && entry > 0)
        unrealizedLoss = Math.max(0, -(mark - entry) * size * dir);
    } catch {
      /* no price this tick: the stop on Strike still stands */
    }
    if (realizedLoss + unrealizedLoss >= cap && !t.close_requested_at) {
      await this.setStopping(run, "loss_cap", now);
      await audit(
        this.pool,
        run.id,
        "exit_requested",
        { seq: t.seq, reason: "loss_cap", realizedLoss, unrealizedLoss, cap },
        now,
      );
      await this.requestExit(run, t, "loss_cap", c, now);
      return;
    }

    // 2. The protective stop must still be working; if it vanished, get out.
    const orders = await getAccountOrders(anon, run.account_id, { symbol: t.symbol, limit: 100 });
    const sl = orders.find((o) => o.client_order_id === t.sl_client_order_id);
    // Canceled, rejected or expired while the position is still open means the stop is gone. (A 'filled'
    // stop is fine: the position is closing and tracking will catch up.)
    const gone = (s: string | undefined) => s === "canceled" || s === "rejected" || s === "expired";
    if (!t.close_requested_at && t.sl_client_order_id && sl && gone(sl.status)) {
      await audit(
        this.pool,
        run.id,
        "protection_missing",
        { seq: t.seq, stopStatus: sl.status },
        now,
      );
      await this.setStopping(run, "protection_lost", now);
      await this.requestExit(run, t, "protection_lost", c, now);
      return;
    }

    // 3. Trailing stop goes in once the entry has filled.
    if (t.trail_pct && !t.trail_client_order_id && !t.close_requested_at) {
      const cid = `tapelive-trail-${t.id}`;
      try {
        await placeTrailingStop(
          c,
          {
            symbol: t.symbol,
            side: t.side === "long" ? "sell" : "buy",
            size: t.entry_size ?? t.size,
            callbackRate: String(t.trail_pct),
            client_order_id: cid,
            ...(run.sub_account_id ? { sub_account_id: run.sub_account_id } : {}),
          },
          this.opts.builderBps,
        );
        await this.pool.query("UPDATE live_trades SET trail_client_order_id = $2 WHERE id = $1", [
          t.id,
          cid,
        ]);
        t.trail_client_order_id = cid;
        await audit(
          this.pool,
          run.id,
          "protection_placed",
          { seq: t.seq, kind: "trailing_stop", callbackRate: t.trail_pct },
          now,
        );
      } catch (e) {
        await audit(
          this.pool,
          run.id,
          "error",
          { where: "trailing_stop", message: errMsg(e) },
          now,
        ); // the fixed stop still protects
      }
    }

    // 4. A close we asked for that hasn't flattened the position: ask again (reduce-only, so safe).
    if (t.close_requested_at && now - Number(t.close_requested_at) > 20_000) {
      await this.requestExit(run, t, t.close_reason_hint ?? "retry", c, now, true);
    }
  }

  /** Market-closes a position (reduce-only) and cancels its other orders. Safe to repeat. */
  private async requestExit(
    run: Run,
    t: Trade,
    reason: string,
    c: StrikeClient,
    now: number,
    retry = false,
  ) {
    const n = retry ? `-r${Math.floor(now / 1000)}` : "";
    const cid = `tapelive-close-${t.id}${n}`;
    const side = t.side === "long" ? "sell" : "buy";
    try {
      await withRetry(
        () =>
          closePositionOrder(
            c,
            {
              symbol: t.symbol,
              side,
              size: t.entry_size ?? t.size,
              client_order_id: cid,
              ...(run.sub_account_id ? { sub_account_id: run.sub_account_id } : {}),
            },
            this.opts.builderBps,
          ),
        { attempts: 5, shouldRetry: (e) => !isDefiniteRejection(e), sleep: this.sleep },
      );
    } catch (e) {
      await audit(
        this.pool,
        run.id,
        "exit_order_failed",
        { seq: t.seq, reason, message: errMsg(e) },
        now,
      );
      if (isDefiniteRejection(e)) run.state.failures++;
      await this.save(run);
      return;
    }
    await this.pool.query(
      "UPDATE live_trades SET close_requested_at = COALESCE(close_requested_at, $2), close_reason_hint = COALESCE(close_reason_hint, $3), close_client_order_id = $4 WHERE id = $1",
      [t.id, now, reason, cid],
    );
    t.close_requested_at ??= String(now);
    if (!retry)
      await audit(
        this.pool,
        run.id,
        "exit_requested",
        { seq: t.seq, reason, clientOrderId: cid },
        now,
      );
    await this.cancelLegs(run, t, c);
  }

  // ── Winding a run down ──

  private async drive(run: Run, c: StrikeClient, anon: StrikeClient, now: number) {
    const open = (await this.trades(run.id, ["open"]))[0];
    const pending = (await this.trades(run.id, ["pending"]))[0];
    if (open && !open.close_requested_at)
      await this.requestExit(run, open, run.stop_reason ?? "stop", c, now);
    if (pending) {
      // An entry still in flight: try to withdraw it, then let tracking settle what happened.
      await cancelOrder(c, {
        symbol: pending.symbol,
        client_order_id: pending.primary_client_order_id,
      }).catch(() => undefined);
    }
    const still = await this.trades(run.id, ["planned", "pending", "open"]);
    if (still.length > 0) {
      await this.save(run);
      return;
    }
    const reason = run.stop_reason ?? "user_stop";
    const status = reason.startsWith("error")
      ? "error"
      : HALT_REASONS.has(reason)
        ? "halted"
        : "stopped";
    await this.pool.query(
      "UPDATE live_runs SET status = $2, stop_reason = $3, stopped_at = now(), state = $4, updated_at = now() WHERE id = $1",
      [run.id, status, reason, JSON.stringify(run.state)],
    );
    await audit(this.pool, run.id, "stop", { status, reason }, now);
    run.status = "stopping";
  }

  // ── Reading the market and acting ──

  private async evaluate(
    run: Run,
    spec: StrategySpec,
    anon: StrikeClient,
    c: StrikeClient,
    realizedLoss: number,
    now: number,
  ) {
    const tfMs = TIMEFRAME_BAR_MS[spec.timeframe];
    const currentBarT = Math.floor(now / tfMs) * tfMs;
    const maxPeriod = Math.max(0, ...spec.indicators.map((i) => i.period ?? 0));
    const started = Number(run.started_ms);
    const last = run.last_bar_ms === null ? null : Number(run.last_bar_ms);
    const bars = await loadBars(this.pool, {
      symbol: spec.market,
      interval: spec.timeframe,
      priceType: "mark",
      from: currentBarT - (maxPeriod + 305) * tfMs,
      to: currentBarT,
    });
    const todo = bars
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.t >= started && (last === null || b.t > last));
    if (todo.length === 0) return;

    let funding: Array<number | null> = bars.map(() => null);
    try {
      const mark = await getMarkPrice(anon, spec.market);
      if (bars[bars.length - 1]?.t === currentBarT - tfMs && Number.isFinite(Number(mark.r)))
        funding[funding.length - 1] = Number(mark.r);
    } catch {
      funding = bars.map(() => null);
    }
    const ind = computeIndicators(spec.indicators, bars, funding);

    for (const { b, i } of todo) {
      const isLatest = i === bars.length - 1;
      await this.onBar(run, spec, bars, ind, i, b, isLatest, anon, c, realizedLoss, now);
      run.last_bar_ms = String(b.t);
      if (run.status !== "active") break;
    }
    await this.save(run);
  }

  private async onBar(
    run: Run,
    spec: StrategySpec,
    bars: Bar[],
    ind: ReturnType<typeof computeIndicators>,
    i: number,
    b: Bar,
    isLatest: boolean,
    anon: StrikeClient,
    c: StrikeClient,
    realizedLoss: number,
    now: number,
  ) {
    const s = run.state;
    const tfMs = TIMEFRAME_BAR_MS[spec.timeframe];
    if (s.barsSinceExit !== null) s.barsSinceExit++;
    const active = (await this.trades(run.id, ["planned", "pending", "open"]))[0];
    if (active?.status === "open" || active?.status === "pending") {
      const sentBar = Math.floor(Number(active.sent_at ?? now) / tfMs) * tfMs;
      if (b.t >= sentBar) {
        active.bars_held++;
        await this.pool.query("UPDATE live_trades SET bars_held = $2 WHERE id = $1", [
          active.id,
          active.bars_held,
        ]);
      }
    }

    const decision = decideOnClose(
      spec,
      {
        halted: false,
        position:
          active?.status === "open" ? { side: active.side, barsHeld: active.bars_held } : null,
        pending: active !== undefined && active.status !== "open",
        barsSinceExit: s.barsSinceExit,
        tradesToday: s.day === dayOf(b) ? s.tradesToday : 0,
      },
      bars,
      ind,
      i,
    );
    const values: Record<string, number | null> = {};
    for (const [id, series] of ind.byId) values[id] = series[i] ?? null;
    if (isLatest)
      await audit(
        this.pool,
        run.id,
        "evaluated",
        { bar: b.t, close: b.c, decision, indicators: values },
        now,
      );
    if (decision.kind === "none") return;

    // Only the newest candle is acted on, and only if we saw it promptly: a signal from before an outage is stale.
    const age = now - (b.t + tfMs);
    if (!isLatest || age > Math.min(tfMs / 2, this.opts.maxSignalAgeMs)) {
      await audit(this.pool, run.id, "stale_signal", { bar: b.t, decision, ageMs: age }, now);
      return;
    }
    await audit(this.pool, run.id, "signal", { bar: b.t, decision }, now);

    if (decision.kind === "exit" && active?.status === "open" && !active.close_requested_at) {
      await this.requestExit(run, active, decision.reason, c, now);
      return;
    }
    if (decision.kind === "enter")
      await this.enter(run, spec, decision.side, b, anon, c, realizedLoss, now);
  }

  // ── Entering ──

  private async enter(
    run: Run,
    spec: StrategySpec,
    side: "long" | "short",
    b: Bar,
    anon: StrikeClient,
    c: StrikeClient,
    realizedLoss: number,
    now: number,
  ) {
    const rules = (await this.gateway.marketRules(2000))[spec.market];
    if (!rules) {
      await audit(
        this.pool,
        run.id,
        "entry_refused",
        { code: "no_market", reason: `Unknown market ${spec.market}` },
        now,
      );
      return;
    }
    let mark: number;
    let available: number;
    try {
      mark = Number((await getMarkPrice(anon, spec.market)).p);
      available = await this.availableUsd(run, c);
    } catch (e) {
      await audit(this.pool, run.id, "entry_refused", { code: "no_data", reason: errMsg(e) }, now);
      return;
    }
    const plan = planLiveEntry({
      spec,
      budget: run.budget,
      side,
      mark,
      availableUsd: available,
      realizedLossUsd: realizedLoss,
      rules: rules as unknown as MarketRulesLite,
      takerRate: await this.takerRate(anon),
      builderBps: this.opts.builderBps,
      slippageBps: this.opts.slippageBps,
    });
    if (!plan.ok) {
      await audit(
        this.pool,
        run.id,
        "entry_refused",
        { code: plan.code, reason: plan.reason, bar: b.t },
        now,
      );
      // The loss budget can't fit another trade: finish the run rather than idle forever.
      if (plan.code === "would_exceed_loss_cap")
        await this.setStopping(run, "budget_exhausted", now);
      return;
    }

    const s = run.state;
    s.signalSeq++;
    const seq = s.signalSeq;
    const day = dayOf(b);
    if (s.day !== day) {
      s.day = day;
      s.tradesToday = 0;
    }
    s.tradesToday++;
    const strategyId = crypto.randomUUID();
    const cid = `tapelive-${run.id}-${seq}`;

    // 1. Record the intent before anything leaves this process.
    const ins = await this.pool.query(
      `INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, tp_price, trail_pct,
                                worst_case_loss, strategy_id, primary_client_order_id, builder_bps)
       VALUES ($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        run.id,
        seq,
        run.user_id,
        run.account_id,
        spec.market,
        side,
        plan.leverage,
        plan.marginUsd,
        plan.size,
        plan.slPrice,
        plan.tpPrice,
        plan.trailingPct,
        plan.worstCaseLoss,
        strategyId,
        cid,
        this.opts.builderBps,
      ],
    );
    const tradeId = ins.rows[0].id as string;
    await this.save(run);
    await audit(this.pool, run.id, "order_planned", { seq, plan }, now);

    // 2. From here the order may exist on Strike: mark it sent first, so it is never sent twice.
    await this.pool.query(
      "UPDATE live_trades SET status = 'pending', sent_at = $2, updated_at = now() WHERE id = $1",
      [tradeId, now],
    );

    const fail = async (reason: string) => {
      await this.pool.query(
        "UPDATE live_trades SET status = 'failed', fail_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending'",
        [tradeId, reason],
      );
      await audit(this.pool, run.id, "order_failed", { seq, reason }, now);
      // The next reconcile pass counts this failure and decides whether the run has had enough.
    };

    try {
      await withRetry(
        () => setLeverage(c, spec.market, plan.leverage, run.sub_account_id ?? undefined),
        { attempts: 3, shouldRetry: isRateLimited, sleep: this.sleep },
      );
    } catch (e) {
      await fail(`leverage_failed: ${errMsg(e)}`);
      return;
    }

    try {
      const placed = await withRetry(
        () =>
          placeStrategyOrder(
            c,
            {
              strategy_id: strategyId,
              client_order_id: cid,
              symbol: spec.market,
              side: side === "long" ? "buy" : "sell",
              type: "market",
              size: plan.size,
              ...(run.sub_account_id ? { sub_account_id: run.sub_account_id } : {}),
              ...(plan.tpPrice
                ? {
                    tp_order: {
                      type: "take_profit",
                      size: plan.size,
                      stop_price: plan.tpPrice,
                      working_type: "mark_price",
                    },
                  }
                : {}),
              sl_order: {
                type: "stop",
                size: plan.size,
                stop_price: plan.slPrice,
                working_type: "mark_price",
              },
            } as Parameters<typeof placeStrategyOrder>[1],
            this.opts.builderBps,
          ),
        // Only a rate limit is certain not to have been processed; anything else may have landed.
        { attempts: 3, shouldRetry: isRateLimited, sleep: this.sleep },
      );
      await this.pool.query(
        "UPDATE live_trades SET tp_client_order_id = $2, sl_client_order_id = $3 WHERE id = $1",
        [
          tradeId,
          (placed as { tp_client_order_id?: string }).tp_client_order_id ?? null,
          (placed as { sl_client_order_id?: string }).sl_client_order_id ?? null,
        ],
      );
      await audit(
        this.pool,
        run.id,
        "order_sent",
        { seq, clientOrderId: cid, size: plan.size, sl: plan.slPrice, tp: plan.tpPrice },
        now,
      );
    } catch (e) {
      if (e instanceof StrikeApiError && isDefiniteRejection(e)) {
        await fail(e.message);
        return;
      }
      // Unclear outcome (network error, timeout, 5xx): the order may or may not exist. Never resend: leave
      // it 'pending' and let Strike's history decide. If it never shows up, tracking fails it after 90 seconds.
      await audit(
        this.pool,
        run.id,
        "order_unknown",
        { seq, message: errMsg(e), note: "not resent; waiting for Strike's history" },
        now,
      );
    }
  }
}
