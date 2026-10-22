import { describe, expect, it } from "vitest";
import { type StrategySpec, strategySpecSchema } from "../strategy/spec.js";
import { instantiateTemplate } from "../strategy/templates.js";
import { NeedsFundingHistoryError, runBacktest } from "./backtest.js";
import { type EngineEvent, type SimTrade, StrategyEngine } from "./engine.js";
import {
  atr,
  type Bar,
  computeIndicators,
  ema,
  highest,
  lowest,
  roc,
  rsi,
  sma,
} from "./indicators.js";
import {
  builderFee,
  commission,
  type FeeModel,
  liquidationPrice,
  type MarketModel,
  roundHalfEven,
} from "./model.js";

const HOUR = 3_600_000;
const T0 = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000; // midnight UTC, so day-based limits are predictable
const market: MarketModel = {
  symbol: "BTC-USD",
  tiers: [
    { maxNotional: 300_000, maxLeverage: 150, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
    {
      maxNotional: 800_000,
      maxLeverage: 100,
      maintenanceMarginRate: 0.005,
      maintenanceAmount: 300,
    },
  ],
  liquidationFeeRate: 0.0125,
  quotePrec: 8,
  minNotional: 100,
};
const noFees: FeeModel = { takerRate: 0, builderBps: 0, slippageBps: 0 };
const fees: FeeModel = { takerRate: 0.0005, builderBps: 10, slippageBps: 5 };

/** Candles from [open, high, low, close] tuples, one hour apart. */
const bars = (rows: Array<[number, number, number, number]>): Bar[] =>
  rows.map(([o, h, l, c], i) => ({ t: T0 + i * HOUR, o, h, l, c, v: 1 }));
const flat = (p: number, n: number): Array<[number, number, number, number]> =>
  Array.from({ length: n }, () => [p, p, p, p]);

/** close > 100 enters long; no other exits unless the test sets them. */
function spec(
  over: Partial<{
    exit: Partial<StrategySpec["exit"]>;
    sizing: Partial<StrategySpec["sizing"]>;
    risk: Partial<StrategySpec["risk"]>;
    direction: StrategySpec["direction"];
    short: boolean;
  }> = {},
): StrategySpec {
  const base: StrategySpec = {
    version: 1,
    name: "t",
    summary: "t",
    market: "BTC-USD",
    timeframe: "1h",
    direction: over.direction ?? "long",
    indicators: [],
    entry: {
      long: {
        match: "all",
        rules: [
          {
            left: { kind: "price", indicator: null, value: null, price: "close" },
            op: ">",
            right: { kind: "number", indicator: null, value: 100, price: null },
          },
        ],
      },
      short: over.short
        ? {
            match: "all",
            rules: [
              {
                left: { kind: "price", indicator: null, value: null, price: "close" },
                op: "<",
                right: { kind: "number", indicator: null, value: 100, price: null },
              },
            ],
          }
        : null,
    },
    exit: {
      stopLossPct: 5,
      takeProfitPct: null,
      trailingStopPct: null,
      maxHoldBars: null,
      exitLong: null,
      exitShort: null,
      ...over.exit,
    },
    sizing: { mode: "fixed_margin_usd", value: 100, leverage: 5, ...over.sizing },
    risk: { maxLossUsd: 10_000, maxTradesPerDay: null, cooldownBars: 0, ...over.risk },
  };
  return base;
}

function run(s: StrategySpec, b: Bar[], f: FeeModel = noFees, startEquity = 10_000) {
  return runBacktest(s, b, { market, fees: f, startEquity, priceType: "mark" });
}

describe("indicators", () => {
  it("sma and ema", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2); // seeded with the SMA
    expect(e[3]).toBeCloseTo(3); // 4*0.5 + 2*0.5
    expect(e[4]).toBeCloseTo(4);
  });

  it("rsi: all gains is 100, flat is 50, and matches a hand-worked case", () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)[3]).toBe(100);
    expect(rsi([5, 5, 5, 5, 5], 3)[3]).toBe(50);
    // changes +1,-1,+2 -> avg gain 1, avg loss 1/3 -> RS 3 -> RSI 75
    expect(rsi([10, 11, 10, 12], 3)[3]).toBeCloseTo(75);
    // next close 11 (-1): gain (1*2+0)/3=.6667, loss (1/3*2+1)/3=.5556 -> RS 1.2 -> 54.545
    expect(rsi([10, 11, 10, 12, 11], 3)[4]).toBeCloseTo(54.5454, 3);
  });

  it("atr uses true range and Wilder smoothing", () => {
    const b = bars([
      [10, 12, 9, 11],
      [11, 13, 10, 12],
      [12, 12, 11, 11.5],
      [11.5, 14, 11, 13],
    ]);
    const a = atr(b, 2);
    expect(a[0]).toBeNull();
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo((3 + 1) / 2); // TR1=3 (13-10), TR2=1 (12-11) -> 2
    expect(a[3]).toBeCloseTo((2 * 1 + 3) / 2); // TR3=3 (14-11) -> 2.5
  });

  it("highest/lowest look at the previous candles only", () => {
    const b = bars([
      [1, 5, 1, 2],
      [2, 7, 2, 3],
      [3, 6, 0, 4],
      [4, 9, 3, 8],
    ]);
    expect(highest(b, 2)).toEqual([null, null, 7, 7]);
    expect(lowest(b, 2)).toEqual([null, null, 1, 0]);
  });

  it("roc is percent change over the period", () => {
    const r = roc([100, 110, 121], 1);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(10, 9);
    expect(r[2]).toBeCloseTo(10, 9);
    expect(roc([100, 105, 90], 2)[2]).toBeCloseTo(-10);
  });

  it("computeIndicators reports the warm-up length", () => {
    const s = instantiateTemplate("dip_buyer");
    const set = computeIndicators(s.indicators, bars(flat(100, 250)));
    expect(set.warmup).toBe(200);
    expect(set.byId.get("ema200")?.[199]).toBe(100);
  });
});

describe("Strike model", () => {
  it("matches the reference isolated liquidation examples", () => {
    expect(
      liquidationPrice(
        {
          ...market,
          tiers: [
            {
              maxNotional: 1e9,
              maxLeverage: 50,
              maintenanceMarginRate: 0.004,
              maintenanceAmount: 0,
            },
          ],
        },
        "long",
        43_000,
        0.5,
        1075,
      ),
    ).toBeCloseTo(41_014.0562, 3);
    expect(
      liquidationPrice(
        {
          ...market,
          tiers: [
            {
              maxNotional: 1e9,
              maxLeverage: 50,
              maintenanceMarginRate: 0.004,
              maintenanceAmount: 0,
            },
          ],
        },
        "short",
        43_000,
        0.5,
        1075,
      ),
    ).toBeCloseTo(45_150 / 1.004, 3);
  });
  it("rounds half to even and floors builder fees", () => {
    expect(roundHalfEven(2.5, 0)).toBe(2);
    expect(roundHalfEven(3.5, 0)).toBe(4);
    expect(roundHalfEven(0.125, 2)).toBe(0.12);
    expect(commission(500, 0.0005, 8)).toBe(0.25);
    expect(builderFee(500, 10)).toBe(0.5);
    expect(builderFee(123.456, 10)).toBe(0.12);
    expect(builderFee(500, 0)).toBe(0);
  });
});

describe("entries and exits", () => {
  it("fills a signal at the next open, applies slippage and exact fees, and sizes the position", () => {
    const b = bars([...flat(99, 3), [99, 101, 99, 101], [102, 103, 101, 102], ...flat(102, 3)]);
    const r = run(spec({ exit: { stopLossPct: 5 } }), b, fees);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0] as SimTrade;
    expect(t.entryTs).toBe(T0 + 4 * HOUR); // signal on bar 3's close -> bar 4's open
    expect(t.entryPrice).toBeCloseTo(102 * 1.0005, 8); // long pays up
    expect(t.notional).toBe(500);
    expect(t.size).toBeCloseTo(500 / (102 * 1.0005), 10);
    expect(t.reason).toBe("end_of_data");
    // entry: commission 500*0.0005=0.25 + builder floor(0.5)=0.5; exit on 500-ish notional similar
    expect(t.fees).toBeGreaterThan(1.4);
    expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees, 8);
  });

  it("take-profit fills at the target with no slippage; stop fills with slippage; both in one candle counts as a stop", () => {
    const tp = run(
      spec({ exit: { stopLossPct: 5, takeProfitPct: 10 } }),
      bars([...flat(99, 2), [99, 101, 99, 101], [101, 115, 100, 112], ...flat(112, 2)]),
      { takerRate: 0, builderBps: 0, slippageBps: 5 },
    );
    expect(tp.trades[0]).toMatchObject({ reason: "take_profit" });
    const entry = 101 * 1.0005;
    expect(tp.trades[0]?.exitPrice).toBeCloseTo(entry * 1.1, 8);

    const sl = run(
      spec({ exit: { stopLossPct: 5 } }),
      bars([...flat(99, 2), [99, 101, 99, 101], [101, 101, 90, 92], ...flat(92, 2)]),
      { takerRate: 0, builderBps: 0, slippageBps: 5 },
    );
    expect(sl.trades[0]?.reason).toBe("stop_loss");
    expect(sl.trades[0]?.exitPrice).toBeCloseTo(entry * 0.95 * (1 - 0.0005), 8);

    const both = run(
      spec({ exit: { stopLossPct: 5, takeProfitPct: 5 } }),
      bars([...flat(99, 2), [99, 101, 99, 101], [101, 120, 90, 100], ...flat(100, 2)]),
    );
    expect(both.trades[0]?.reason).toBe("stop_loss");
  });

  it("a candle that opens beyond the stop fills at the open (gap risk)", () => {
    const r = run(
      spec({ exit: { stopLossPct: 5 } }),
      bars([
        ...flat(99, 2),
        [99, 101, 99, 101],
        [101, 101, 101, 101],
        [93, 94, 92, 93],
        ...flat(93, 2),
      ]),
    );
    // the 5% stop is 95.95; the candle opened at 93, still above the liquidation price (~81)
    expect(r.trades[0]).toMatchObject({ reason: "stop_loss", exitPrice: 93 });
  });

  it("trailing stop follows the best price and exits below it", () => {
    const r = run(
      spec({ exit: { stopLossPct: 10, trailingStopPct: 5 } }),
      bars([
        ...flat(99, 2),
        [99, 101, 99, 101],
        [101, 110, 101, 109],
        [109, 120, 108, 119],
        [119, 119, 110, 112],
        ...flat(112, 2),
      ]),
    );
    expect(r.trades[0]?.reason).toBe("trailing_stop");
    expect(r.trades[0]?.exitPrice).toBeCloseTo(120 * 0.95, 8); // best 120 from the candle before; trigger 114
  });

  it("shorts mirror longs", () => {
    const s = spec({
      direction: "short",
      short: true,
      exit: { stopLossPct: 5, takeProfitPct: 10 },
    });
    s.entry.long = null;
    const r = run(
      s,
      bars([...flat(101, 2), [101, 101, 99, 99], [99, 100, 80, 85], ...flat(85, 2)]),
    );
    expect(r.trades[0]).toMatchObject({ side: "short", reason: "take_profit" });
    expect(r.trades[0]?.exitPrice).toBeCloseTo(99 * 0.9, 8);
    expect(r.trades[0]?.netPnl).toBeGreaterThan(0);
  });

  it("closes on a rule and on max hold, at the next open", () => {
    const s = spec({ exit: { stopLossPct: 5, maxHoldBars: 3 } });
    const hold = run(s, bars([...flat(99, 2), [99, 101, 99, 101], ...flat(101, 6)]));
    expect(hold.trades[0]).toMatchObject({ reason: "max_hold", barsHeld: 3 });
    expect(hold.trades[0]?.exitTs).toBe(T0 + 6 * HOUR);

    const rule = spec({ exit: { stopLossPct: 5 } });
    rule.exit.exitLong = {
      match: "all",
      rules: [
        {
          left: { kind: "price", indicator: null, value: null, price: "close" },
          op: "<",
          right: { kind: "number", indicator: null, value: 100, price: null },
        },
      ],
    };
    const r = run(
      rule,
      bars([
        ...flat(99, 2),
        [99, 101, 99, 101],
        [101, 101, 99, 99],
        [98, 98, 97, 97],
        ...flat(97, 2),
      ]),
    );
    expect(r.trades[0]).toMatchObject({ reason: "rule", exitPrice: 98 });
  });
});

describe("liquidation", () => {
  it("liquidates a gap through the liquidation price, losing about the margin plus the liquidation fee", () => {
    const s = spec({ sizing: { value: 100, leverage: 50 }, exit: { stopLossPct: 1.5 } });
    const b = bars([
      ...flat(99, 2),
      [99, 101, 99, 101],
      [101, 101, 101, 101],
      [90, 91, 89, 90],
      ...flat(90, 2),
    ]);
    const r = run(s, b, { takerRate: 0, builderBps: 0, slippageBps: 0 });
    const t = r.trades[0] as SimTrade;
    expect(t.liquidated).toBe(true);
    expect(t.reason).toBe("liquidation");
    expect(r.stats.liquidations).toBe(1);
    expect(r.liquidations).toHaveLength(1);
    expect(t.netPnl).toBeLessThan(-80); // most of the $100 margin
    expect(t.netPnl).toBeGreaterThanOrEqual(-100.01); // never more than the margin
  });

  it("the stop fires before liquidation when the guard holds", () => {
    const r = run(
      spec({ sizing: { value: 100, leverage: 20 }, exit: { stopLossPct: 3 } }),
      bars([...flat(99, 2), [99, 101, 99, 101], [101, 101, 96, 97], ...flat(97, 2)]),
    );
    expect(r.trades[0]?.reason).toBe("stop_loss");
  });
});

describe("risk controls", () => {
  const pump = (n: number) =>
    Array.from({ length: n }, (_, i): [number, number, number, number] =>
      i % 2 === 0 ? [99, 101, 99, 101] : [101, 101, 90, 92],
    ); // enter, get stopped, repeat
  it("cooldown blocks re-entry for the configured candles", () => {
    const quick = run(
      spec({ exit: { stopLossPct: 5 }, risk: { cooldownBars: 0 } }),
      bars(pump(12)),
    );
    const slow = run(spec({ exit: { stopLossPct: 5 }, risk: { cooldownBars: 3 } }), bars(pump(12)));
    expect(slow.trades.length).toBeLessThan(quick.trades.length);
  });

  it("limits trades per day", () => {
    const r = run(spec({ exit: { stopLossPct: 5 }, risk: { maxTradesPerDay: 2 } }), bars(pump(20)));
    expect(r.trades.length).toBe(2);
  });

  it("halts after the loss limit and flattens", () => {
    const r = run(spec({ exit: { stopLossPct: 5 }, risk: { maxLossUsd: 8 } }), bars(pump(30)));
    expect(r.halted).toBe("max_loss");
    expect(r.stats.netPnl).toBeLessThan(-8);
    expect(r.trades.length).toBeLessThan(8);
    expect(r.warnings.some((w) => w.includes("loss limit"))).toBe(true);
  });

  it("skips entries it can't afford or that are too small, and counts them", () => {
    const b = bars([...flat(99, 2), [99, 101, 99, 101], ...flat(101, 4)]);
    const small = run(spec({ sizing: { mode: "fixed_margin_usd", value: 20, leverage: 2 } }), b);
    expect(small.trades).toHaveLength(0);
    expect(small.skipped.below_min_notional).toBeGreaterThan(0); // retried on each candle the signal holds
    const broke = run(
      spec({ sizing: { mode: "fixed_margin_usd", value: 5000, leverage: 2 } }),
      b,
      noFees,
      1000,
    );
    expect(broke.trades).toHaveLength(0);
    expect(broke.skipped.insufficient_equity).toBeGreaterThan(0);
    expect(
      run(spec({ sizing: { mode: "fixed_margin_usd", value: 100, leverage: 5 } }), b).trades,
    ).toHaveLength(1);
  });

  it("sizes a percent-of-equity strategy from current equity", () => {
    const r = run(
      spec({ sizing: { mode: "pct_of_equity", value: 10, leverage: 2 } }),
      bars([...flat(99, 2), [99, 101, 99, 101], ...flat(101, 3)]),
      noFees,
      5000,
    );
    expect(r.trades[0]?.margin).toBe(500);
    expect(r.trades[0]?.notional).toBe(1000);
  });

  it("stands aside when long and short signals fire together", () => {
    const s = spec({ direction: "both" });
    s.entry.short = structuredClone(s.entry.long);
    expect(run(s, bars([...flat(99, 2), [99, 101, 99, 101], ...flat(101, 3)])).trades).toHaveLength(
      0,
    );
  });
});

describe("backtest reporting", () => {
  it("computes stats, drawdown, curve and an honest set of warnings", () => {
    const b = bars([...flat(99, 2), [99, 101, 99, 101], [101, 112, 100, 99], ...flat(95, 5)]);
    const r = run(spec({ exit: { stopLossPct: 5, takeProfitPct: 10 } }), b, fees);
    expect(r.stats.trades).toBe(1);
    expect(r.stats.winRate).toBe(1);
    expect(r.stats.netPnl).toBeCloseTo(r.endEquity - r.startEquity, 8);
    expect(r.stats.returnPct).toBeCloseTo((r.stats.netPnl / 10_000) * 100, 8);
    expect(r.equityCurve.length).toBeGreaterThan(5);
    expect(r.stats.buyAndHoldPct).toBeCloseTo((95 / 99 - 1) * 100, 6);
    expect(r.coverage).toMatchObject({ bars: 9, missingBars: 0, warmupBars: 0 });
    const text = r.warnings.join("\n");
    expect(text).toContain("not a prediction");
    expect(text).toContain("5 bps of slippage");
    expect(text).toContain("Funding payments aren't included");
    expect(text).toContain("Only 1 trade");
  });

  it("refuses funding-rate strategies and reports missing candles and short history", () => {
    expect(() => run(instantiateTemplate("funding_rate"), bars(flat(100, 10)))).toThrow(
      NeedsFundingHistoryError,
    );
    const b = bars(flat(100, 6));
    b.splice(2, 2); // drop two candles
    const r = runBacktest(spec(), b, {
      market,
      fees: noFees,
      startEquity: 1000,
      priceType: "mark",
      requested: { from: T0, to: T0 + 100 * HOUR },
    });
    expect(r.coverage.missingBars).toBe(2);
    expect(r.warnings.join(" ")).toContain("History is shorter than requested");
    expect(r.warnings.join(" ")).toContain("2 candles are missing");
  });

  it("warms up indicators before `from` and only trades from there", () => {
    const s = instantiateTemplate("breakout", { marginUsd: 100, leverage: 3 });
    const b = bars(flat(100, 60));
    const r = runBacktest(s, b, {
      market,
      fees: noFees,
      startEquity: 10_000,
      priceType: "mark",
      from: b[30]?.t,
    });
    expect(r.coverage.warmupBars).toBe(30);
    expect(r.coverage.bars).toBe(30);
  });

  it("is deterministic and the result is plain JSON", () => {
    const b = bars([...flat(99, 2), [99, 101, 99, 101], [101, 112, 100, 111], ...flat(111, 5)]);
    const a = run(spec({ exit: { takeProfitPct: 10, stopLossPct: 5 } }), b, fees);
    const c = run(spec({ exit: { takeProfitPct: 10, stopLossPct: 5 } }), b, fees);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it("downsamples long curves but keeps the endpoints", () => {
    const b = bars(flat(100, 2000));
    const r = runBacktest(spec(), b, {
      market,
      fees: noFees,
      startEquity: 1000,
      priceType: "mark",
      maxCurvePoints: 100,
    });
    expect(r.equityCurve.length).toBe(100);
    expect(r.equityCurve[0]?.t).toBe(T0);
    expect(r.equityCurve[99]?.t).toBe(T0 + 1999 * HOUR);
  });
});

describe("incremental use (paper mode)", () => {
  const b = bars([
    ...flat(99, 3),
    [99, 101, 99, 101],
    [101, 112, 100, 111],
    [111, 111, 95, 96],
    ...flat(96, 4),
    [96, 101, 95, 101],
    [101, 103, 90, 91],
    ...flat(91, 3),
  ]);
  const s = spec({ exit: { stopLossPct: 5, takeProfitPct: 8 } });

  function replay(stopAt?: number) {
    const ind = computeIndicators(s.indicators, b);
    let eng = new StrategyEngine({ spec: s, market, fees }, undefined, 10_000);
    const trades: SimTrade[] = [];
    const take = (ev: EngineEvent[]) =>
      ev.forEach((e) => e.type === "trade" && trades.push(e.trade));
    for (let i = 0; i < b.length; i++) {
      if (i === stopAt)
        eng = new StrategyEngine({ spec: s, market, fees }, JSON.parse(JSON.stringify(eng.state))); // restart from saved state
      take(eng.step(b, ind, i));
    }
    return { trades, state: eng.state };
  }

  it("resumes from a JSON-saved state with identical results", () => {
    const whole = replay();
    for (const at of [3, 4, 5, 9, 11]) expect(replay(at)).toEqual(whole);
    expect(whole.trades.length).toBeGreaterThan(0);
  });

  it("fills a live signal mid-candle at the live price and ignores that candle's earlier range", () => {
    const ind = computeIndicators(s.indicators, b.slice(0, 4));
    const eng = new StrategyEngine({ spec: s, market, fees: noFees }, undefined, 10_000);
    for (let i = 0; i < 4; i++) {
      eng.onClose(b.slice(0, 4), ind, i);
      if (i < 3) eng.state.pending = null;
    }
    expect(eng.state.pending).toEqual({ kind: "enter", side: "long" });
    const live = eng.fillPending(104, T0 + 4 * HOUR + 600_000, { midBarT: T0 + 4 * HOUR });
    expect(live[0]?.type).toBe("entry");
    expect(eng.state.position?.entryPrice).toBe(104);
    // the closed candle's range (low 100) predates the fill: it must not stop us out
    expect(
      eng.protective({ o: 101, h: 112, l: 90, c: 111 } as never, T0 + 5 * HOUR, {
        barT: T0 + 4 * HOUR,
      }),
    ).toEqual([]);
    expect(eng.state.position).not.toBeNull();
    // but a later live tick through the stop does
    const hit = eng.protective({ o: 98, h: 98, l: 98 }, T0 + 6 * HOUR, { tick: true });
    expect(hit[0]).toMatchObject({ type: "trade", trade: { reason: "stop_loss" } });
  });

  it("marks an open position to market", () => {
    const open = bars([...flat(99, 3), [99, 101, 99, 101], [101, 102, 100, 101]]);
    const keep = spec({ exit: { stopLossPct: 20 } });
    const ind = computeIndicators(keep.indicators, open);
    const eng = new StrategyEngine({ spec: keep, market, fees: noFees }, undefined, 10_000);
    for (let i = 0; i < 5; i++) eng.step(open, ind, i);
    expect(eng.state.position).not.toBeNull();
    const pos = eng.state.position!;
    expect(eng.markToMarket(pos.entryPrice * 1.1)).toBeCloseTo(10_000 + pos.notional * 0.1, 6);
  });
});

describe("live ticks", () => {
  it("a target crossed by a tick fills at the target; a stop crossed by a tick fills at the tick", () => {
    const open = bars([...flat(99, 3), [99, 101, 99, 101], [101, 102, 100, 101]]);
    const s = spec({ exit: { stopLossPct: 5, takeProfitPct: 10 } });
    const mk = () => {
      const ind = computeIndicators(s.indicators, open);
      const e = new StrategyEngine({ spec: s, market, fees: noFees }, undefined, 10_000);
      for (let i = 0; i < 5; i++) e.step(open, ind, i);
      return e;
    };
    const tp = mk();
    const hit = tp.protective({ o: 130, h: 130, l: 130 }, T0 + 9 * HOUR, { tick: true });
    expect(hit[0]).toMatchObject({ trade: { reason: "take_profit" } });
    expect(tp.state.cumNetPnl).toBeCloseTo(500 * 0.1, 6); // 10% of the $500 notional, not 30%
    const sl = mk();
    const stop = sl.protective({ o: 90, h: 90, l: 90 }, T0 + 9 * HOUR, { tick: true });
    expect(stop[0]).toMatchObject({ trade: { reason: "stop_loss", exitPrice: 90 } });
  });
});

describe("spec compatibility", () => {
  it("every template other than funding backtests without error", () => {
    const b = bars(
      Array.from({ length: 400 }, (_, i): [number, number, number, number] => {
        const p = 100 + 10 * Math.sin(i / 8) + i * 0.05;
        return [p, p + 1, p - 1, p + 0.3];
      }),
    );
    for (const id of ["dip_buyer", "trend_follower", "breakout"] as const) {
      const s = instantiateTemplate(id);
      expect(strategySpecSchema.safeParse(s).success).toBe(true);
      const r = runBacktest(s, b, { market, fees, startEquity: 10_000, priceType: "mark" });
      expect(Number.isFinite(r.endEquity)).toBe(true);
    }
  });
});
