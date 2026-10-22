import { describe, expect, it } from "vitest";
import {
  callLines,
  escapeTelegramHtml,
  type PostCall,
  resultPct,
  telegramText,
  vaultEligibility,
  xText,
} from "./social.js";

const call = (over: Partial<PostCall> = {}): PostCall => ({
  code: "abc12345",
  symbol: "BTC-USD",
  side: "long",
  leverage: 10,
  entryPrice: "80000",
  tpPrice: "84000",
  slPrice: "78000",
  exitPrice: null,
  exitReason: null,
  trader: "alice",
  ...over,
});

describe("call posts", () => {
  it("states only what the fill shows when a call opens", () => {
    expect(callLines("opened", call())).toEqual([
      "LONG BTC-USD 10x by alice",
      "Entry 80,000 (from the fill) · TP 84,000 · SL 78,000",
    ]);
    expect(callLines("opened", call({ entryPrice: null, tpPrice: null, slPrice: null }))[1]).toBe(
      "Entry pending (from the fill)",
    );
  });

  it("reports the leveraged result and why it closed", () => {
    expect(resultPct(call({ exitPrice: "84000" }))).toBeCloseTo(50, 9);
    expect(resultPct(call({ side: "short", exitPrice: "84000" }))).toBeCloseTo(-50, 9);
    expect(resultPct(call())).toBeNull();
    expect(callLines("closed", call({ exitPrice: "84000", exitReason: "tp" }))[1]).toBe(
      "Closed +50.00% (take-profit)",
    );
    expect(callLines("closed", call({ exitPrice: "79000", exitReason: "sl" }))[1]).toBe(
      "Closed -12.50% (stop-loss)",
    );
  });

  it("escapes Telegram HTML so a handle can't inject markup", () => {
    expect(escapeTelegramHtml("<b>&")).toBe("&lt;b&gt;&amp;");
    expect(telegramText("opened", call({ trader: "<script>x</script>" }))).not.toContain(
      "<script>",
    );
  });

  it("fits X's limit with the link counted as 23 characters", () => {
    const long = call({ trader: "x".repeat(400) });
    const t = xText("opened", long, "https://pit.example/c/abc12345");
    expect(t.endsWith("https://pit.example/c/abc12345")).toBe(true);
    expect(t.length - "https://pit.example/c/abc12345".length + 23).toBeLessThanOrEqual(280);
    expect(xText("opened", call(), "https://p/c/x")).toContain("LONG BTC-USD 10x by alice");
  });
});

describe("vault graduation", () => {
  const good = {
    trades: 40,
    activeDays: 20,
    totalReturnPct: 12,
    maxDrawdownPct: 15,
    clean: true,
    reputation: 72,
  };
  it("passes only when every criterion is met", () => {
    expect(vaultEligibility(good).eligible).toBe(true);
    for (const [k, v] of [
      ["trades", 10],
      ["activeDays", 5],
      ["totalReturnPct", -1],
      ["totalReturnPct", null],
      ["maxDrawdownPct", 50],
      ["maxDrawdownPct", null],
      ["clean", false],
      ["reputation", 40],
      ["reputation", null],
    ] as const) {
      const r = vaultEligibility({ ...good, [k]: v });
      expect(r.eligible, `${k}=${v}`).toBe(false);
      expect(r.criteria.filter((c) => !c.met)).toHaveLength(1);
    }
  });
});
