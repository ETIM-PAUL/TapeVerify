import type { IndicatorDef } from "../strategy/spec.js";

/** A closed candle. `t` is the open time in ms. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Series = Array<number | null>;

/**
 * Indicator definitions (the same ones the validator and the plain-language renderer describe).
 * Every value at index i uses only candles up to and including i, except highest/lowest, which look at
 * the PREVIOUS `period` candles so that "close crosses above the 20-candle high" can actually happen.
 */

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i] as number;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const at = (g: number, l: number) =>
    g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  out[period] = at(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = at(gain, loss);
  }
  return out;
}

/** Wilder's ATR on true range. */
export function atr(bars: Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr = (i: number) => {
    const b = bars[i] as Bar;
    const pc = (bars[i - 1] as Bar).c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  };
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < bars.length; i++) {
    a = (a * (period - 1) + tr(i)) / period;
    out[i] = a;
  }
  return out;
}

/** Highest high of the previous `period` candles (excludes the current one). */
export function highest(bars: Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let m = Number.NEGATIVE_INFINITY;
    for (let j = i - period; j < i; j++) m = Math.max(m, (bars[j] as Bar).h);
    out[i] = m;
  }
  return out;
}

/** Lowest low of the previous `period` candles (excludes the current one). */
export function lowest(bars: Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let m = Number.POSITIVE_INFINITY;
    for (let j = i - period; j < i; j++) m = Math.min(m, (bars[j] as Bar).l);
    out[i] = m;
  }
  return out;
}

/** Percent change of the close over `period` candles. */
export function roc(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const base = values[i - period] as number;
    out[i] = base === 0 ? null : ((values[i] as number) / base - 1) * 100;
  }
  return out;
}

export interface IndicatorSet {
  byId: Map<string, Series>;
  /** Candles needed before every indicator has a value. */
  warmup: number;
}

/**
 * Computes every indicator a spec declares over the given candles. `funding` (aligned with `bars`) feeds
 * funding_rate indicators; where it's missing the indicator has no value and any rule using it is false.
 */
export function computeIndicators(
  defs: IndicatorDef[],
  bars: Bar[],
  funding?: Series,
): IndicatorSet {
  const closes = bars.map((b) => b.c);
  const byId = new Map<string, Series>();
  let warmup = 0;
  for (const d of defs) {
    const p = d.period ?? 0;
    let s: Series;
    switch (d.type) {
      case "sma":
        s = sma(closes, p);
        warmup = Math.max(warmup, p);
        break;
      case "ema":
        s = ema(closes, p);
        warmup = Math.max(warmup, p);
        break;
      case "rsi":
        s = rsi(closes, p);
        warmup = Math.max(warmup, p + 1);
        break;
      case "atr":
        s = atr(bars, p);
        warmup = Math.max(warmup, p + 1);
        break;
      case "highest":
        s = highest(bars, p);
        warmup = Math.max(warmup, p + 1);
        break;
      case "lowest":
        s = lowest(bars, p);
        warmup = Math.max(warmup, p + 1);
        break;
      case "roc":
        s = roc(closes, p);
        warmup = Math.max(warmup, p + 1);
        break;
      case "funding_rate":
        s = funding ?? new Array(bars.length).fill(null);
        break;
    }
    byId.set(d.id, s);
  }
  return { byId, warmup };
}
