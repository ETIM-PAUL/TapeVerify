import { describe, expect, it } from "vitest";
import { instantiateTemplate } from "../strategy/templates.js";
import {
  DEFAULT_LIVE_LIMITS,
  effectiveLossCap,
  liveSpecIssues,
  type PlanInput,
  planLiveEntry,
} from "./live.js";

const rules = {
  symbol: "BTC-USD",
  base_asset: "BTC",
  status: "trading",
  reduce_only: false,
  margin_tiers: [{ max_notional: "300000", max_leverage: 150 }],
  order_tick_price: "0.10",
  order_min_price: "0.10",
  order_max_price: "0",
  order_market_step_size: "0.00001",
  order_market_min_size: "0.00001",
  order_market_max_size: "120",
  order_min_notional: "100",
  mark_price: "80000",
};
const spec = () => {
  const s = instantiateTemplate("breakout", { marginUsd: 100, leverage: 3, maxLossUsd: 50 });
  s.exit = {
    stopLossPct: 2,
    takeProfitPct: 6,
    trailingStopPct: null,
    maxHoldBars: null,
    exitLong: null,
    exitShort: null,
  };
  return s;
};
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  spec: spec(),
  budget: { maxMarginUsd: 200, maxLossUsd: 40 },
  side: "long",
  mark: 80_000,
  availableUsd: 1000,
  realizedLossUsd: 0,
  rules,
  takerRate: 0.0005,
  builderBps: 10,
  slippageBps: 5,
  ...over,
});

describe("live budget caps", () => {
  it("uses the stricter of the budget and the strategy's own loss limit", () => {
    expect(effectiveLossCap(spec(), { maxMarginUsd: 100, maxLossUsd: 40 })).toBe(40);
    expect(effectiveLossCap(spec(), { maxMarginUsd: 100, maxLossUsd: 500 })).toBe(50);
  });

  it("plans an order sized from margin, with exits at the spec's distances", () => {
    const p = planLiveEntry(input());
    expect(p).toMatchObject({
      ok: true,
      side: "long",
      marginUsd: 100,
      leverage: 3,
      size: "0.00375",
      slPrice: "78400",
      tpPrice: "84800",
      trailingPct: null,
    });
    if (p.ok) {
      expect(p.notional).toBeCloseTo(300, 6);
      expect(p.worstCaseLoss).toBeCloseTo(300 * (0.02 + 0.001) + 2 * 300 * 0.0015, 6);
    }
  });

  it("mirrors a short", () => {
    expect(planLiveEntry(input({ side: "short" }))).toMatchObject({
      ok: true,
      slPrice: "81600",
      tpPrice: "75200",
    });
  });

  it("caps margin at the budget, whatever the strategy asks for", () => {
    const s = spec();
    s.sizing = { mode: "fixed_margin_usd", value: 5000, leverage: 3 };
    const p = planLiveEntry(
      input({ spec: s, availableUsd: 10_000, budget: { maxMarginUsd: 150, maxLossUsd: 40 } }),
    );
    expect(p).toMatchObject({ ok: true, marginUsd: 150 });
    const pct = spec();
    pct.sizing = { mode: "pct_of_equity", value: 50, leverage: 3 };
    expect(
      planLiveEntry(
        input({ spec: pct, availableUsd: 1000, budget: { maxMarginUsd: 120, maxLossUsd: 40 } }),
      ),
    ).toMatchObject({ ok: true, marginUsd: 120 });
    expect(
      planLiveEntry(
        input({ spec: pct, availableUsd: 160, budget: { maxMarginUsd: 500, maxLossUsd: 40 } }),
      ),
    ).toMatchObject({ ok: true, marginUsd: 80 });
  });

  it("refuses without the balance or below the minimum", () => {
    expect(planLiveEntry(input({ availableUsd: 50 }))).toMatchObject({
      ok: false,
      code: "insufficient_balance",
    });
    const tiny = spec();
    tiny.sizing = { mode: "fixed_margin_usd", value: 3, leverage: 3 };
    expect(planLiveEntry(input({ spec: tiny }))).toMatchObject({
      ok: false,
      code: "below_minimum_size",
    });
    const small = spec();
    small.sizing = { mode: "fixed_margin_usd", value: 20, leverage: 2 }; // $40 order < $100 minimum
    expect(planLiveEntry(input({ spec: small }))).toMatchObject({ ok: false, code: "bad_order" });
  });

  it("refuses an entry whose stop-loss alone could break the loss cap, counting what's already lost", () => {
    // worst case ~ $6.30 stop + $0.90 fees = ~$7.20 per trade; cap $40
    expect(planLiveEntry(input({ realizedLossUsd: 30 }))).toMatchObject({ ok: true });
    const r = planLiveEntry(input({ realizedLossUsd: 36 }));
    expect(r).toMatchObject({ ok: false, code: "would_exceed_loss_cap" });
    expect((r as { reason: string }).reason).toContain("$4.00 left");
    expect(planLiveEntry(input({ realizedLossUsd: 45 }))).toMatchObject({
      ok: false,
      code: "would_exceed_loss_cap",
    });
  });

  it("carries a trailing stop through", () => {
    const s = spec();
    s.exit.trailingStopPct = 2.5;
    expect(planLiveEntry(input({ spec: s }))).toMatchObject({ ok: true, trailingPct: 2.5 });
  });
});

describe("live spec restrictions", () => {
  const ok = { maxMarginUsd: 100, maxLossUsd: 50 };
  it("limits leverage and trailing stops and demands sane budgets", () => {
    expect(liveSpecIssues(spec(), ok, DEFAULT_LIVE_LIMITS)).toEqual([]);
    const hi = spec();
    hi.sizing.leverage = 20;
    hi.exit.stopLossPct = 2;
    expect(liveSpecIssues(hi, ok, DEFAULT_LIVE_LIMITS)[0]).toContain("10x");
    const trail = spec();
    trail.exit.trailingStopPct = 8;
    expect(liveSpecIssues(trail, ok, DEFAULT_LIVE_LIMITS)[0]).toContain("5%");
    expect(
      liveSpecIssues(spec(), { maxMarginUsd: 2, maxLossUsd: 50 }, DEFAULT_LIVE_LIMITS).length,
    ).toBeGreaterThan(0);
    expect(
      liveSpecIssues(spec(), { maxMarginUsd: 100, maxLossUsd: 0 }, DEFAULT_LIVE_LIMITS).length,
    ).toBeGreaterThan(0);
    expect(
      liveSpecIssues(spec(), { maxMarginUsd: 10, maxLossUsd: 500 }, DEFAULT_LIVE_LIMITS)[0],
    ).toContain("20x");
  });
});
