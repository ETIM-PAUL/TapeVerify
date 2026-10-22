import { describe, expect, it } from "vitest";
import { describeStrategy } from "./describe.js";
import { draftEnvelopeSchema, draftJsonSchema, strategySpecSchema } from "./spec.js";
import { instantiateTemplate, TEMPLATES } from "./templates.js";
import { type ValidateOptions, validateStrategy } from "./validate.js";

const opts: ValidateOptions = {
  markets: {
    "BTC-USD": { maxLeverage: 150, minNotional: 100 },
    "ETH-USD": { maxLeverage: 100, minNotional: 100 },
  },
};
const spec = () => structuredClone(instantiateTemplate("dip_buyer"));
const check = (mutate: (s: ReturnType<typeof spec>) => void) => {
  const s = spec();
  mutate(s);
  return validateStrategy(s, opts);
};
const paths = (r: ReturnType<typeof validateStrategy>) => r.issues.map((i) => i.path);

describe("templates", () => {
  it.each(TEMPLATES.map((t) => t.id))(
    "%s is a valid spec and reads back in plain language",
    (id) => {
      const s = instantiateTemplate(id);
      const r = validateStrategy(s, opts);
      expect(r.issues, JSON.stringify(r.issues)).toEqual([]);
      expect(r.ok).toBe(true);
      const d = describeStrategy(s);
      expect(d.lines.length).toBeGreaterThanOrEqual(4);
      expect(d.lines.map((l) => l.text).join(" ")).not.toMatch(/undefined|null|\[unknown/);
    },
  );

  it("applies parameters and flags the funding template", () => {
    const s = instantiateTemplate("breakout", {
      market: "ETH-USD",
      leverage: 2,
      marginUsd: 250,
      maxLossUsd: 40,
    });
    expect(s.market).toBe("ETH-USD");
    expect(s.sizing).toMatchObject({ leverage: 2, value: 250 });
    expect(s.risk.maxLossUsd).toBe(40);
    expect(TEMPLATES.filter((t) => t.needsFundingHistory).map((t) => t.id)).toEqual([
      "funding_rate",
    ]);
    expect(
      validateStrategy(instantiateTemplate("funding_rate"), opts).warnings.some((w) =>
        w.message.includes("backtested"),
      ),
    ).toBe(true);
  });
});

describe("describeStrategy", () => {
  it("states every rule, exit, size and limit", () => {
    const d = describeStrategy(instantiateTemplate("dip_buyer"));
    const text = d.lines.map((l) => `${l.label}: ${l.text}`).join("\n");
    expect(d.headline).toBe("Dip buyer: long on BTC-USD");
    expect(text).toContain("BTC-USD, 1-hour candles");
    expect(text).toContain(
      "Buy (long) when: ALL of: RSI(14) is below 30; the close price is above EMA(200)",
    );
    expect(text).toContain("stop-loss 3% from entry, take-profit 5%, close after 72 candles");
    expect(text).toContain("Also close a long when: RSI(14) is above 60");
    expect(text).toContain("$100 margin per trade at 3x leverage (about $300 of exposure)");
    expect(text).toContain("stops itself after $100 of total losses");
    expect(text).toContain("one position at a time");
  });

  it("describes both directions and crossovers", () => {
    const text = describeStrategy(instantiateTemplate("trend_follower"))
      .lines.map((l) => l.text)
      .join("\n");
    expect(text).toContain("EMA(20) crosses above EMA(50)");
    expect(text).toContain("EMA(20) crosses below EMA(50)");
    expect(text).toContain("trailing stop 3% behind the best price");
  });
});

describe("validateStrategy", () => {
  it("rejects shape errors, extra keys and wrong versions with paths", () => {
    expect(validateStrategy({}, opts).ok).toBe(false);
    expect(validateStrategy({ ...spec(), version: 2 }, opts).ok).toBe(false);
    expect(validateStrategy({ ...spec(), placeOrder: true }, opts).ok).toBe(false); // unknown keys can't smuggle anything in
    const bad = validateStrategy(
      { ...spec(), sizing: { mode: "fixed_margin_usd", value: "lots", leverage: 3 } },
      opts,
    );
    expect(bad.issues.some((i) => i.path === "sizing.value")).toBe(true);
  });

  it("requires a stop-loss and keeps it inside the liquidation distance", () => {
    expect(
      paths(
        check((s) => {
          s.exit.stopLossPct = 0;
        }),
      ),
    ).toContain("exit.stopLossPct");
    expect(
      paths(
        check((s) => {
          s.exit.stopLossPct = 60;
        }),
      ),
    ).toContain("exit.stopLossPct");
    const r = check((s) => {
      s.sizing.leverage = 20;
      s.exit.stopLossPct = 5;
    }); // 5% x 20 = 100 > 80
    expect(r.issues.find((i) => i.path === "exit.stopLossPct")?.message).toContain("liquidation");
    expect(
      check((s) => {
        s.sizing.leverage = 20;
        s.exit.stopLossPct = 3;
        s.sizing.value = 100;
      }).ok,
    ).toBe(true); // 60
  });

  it("checks leverage against the market and minimum order value", () => {
    expect(
      paths(
        check((s) => {
          s.sizing.leverage = 151;
          s.exit.stopLossPct = 0.2;
        }),
      ),
    ).toContain("sizing.leverage");
    expect(
      paths(
        check((s) => {
          s.sizing.leverage = 0;
        }),
      ),
    ).toContain("sizing.leverage");
    expect(
      paths(
        check((s) => {
          s.sizing.value = 20;
          s.sizing.leverage = 2;
        }),
      ),
    ).toContain("sizing.value"); // $40 < $100
    expect(
      paths(
        check((s) => {
          s.market = "DOGE-USD";
        }),
      ),
    ).toContain("market");
  });

  it("validates indicators and references", () => {
    expect(
      paths(
        check((s) => {
          s.indicators.push({ id: "rsi14", type: "sma", period: 5 });
        }),
      ),
    ).toContain("indicators.2.id"); // duplicate
    expect(
      paths(
        check((s) => {
          s.indicators[0]!.period = 1;
        }),
      ),
    ).toContain("indicators.0.period");
    expect(
      paths(
        check((s) => {
          s.indicators[0]!.period = 501;
        }),
      ),
    ).toContain("indicators.0.period");
    expect(
      paths(
        check((s) => {
          s.indicators[0]!.id = "RSI 14";
        }),
      ),
    ).toContain("indicators.0.id");
    expect(
      check((s) => {
        s.entry.long!.rules[0]!.left.indicator = "ghost";
      }).issues.some((i) => i.message.includes("Unknown indicator")),
    ).toBe(true);
    expect(
      paths(
        check((s) => {
          s.indicators = Array.from({ length: 7 }, (_, i) => ({
            id: `i${i}`,
            type: "sma" as const,
            period: 5 + i,
          }));
        }),
      ),
    ).toContain("indicators");
  });

  it("catches rules that make no sense", () => {
    const rsiVsPrice = check((s) => {
      s.entry.long!.rules[0] = {
        left: { kind: "indicator", indicator: "rsi14", value: null, price: null },
        op: ">",
        right: { kind: "price", indicator: null, value: null, price: "close" },
      };
    });
    expect(rsiVsPrice.issues.some((i) => i.message.includes("Can't compare"))).toBe(true);
    const numNum = check((s) => {
      s.entry.long!.rules[0] = {
        left: { kind: "number", indicator: null, value: 1, price: null },
        op: ">",
        right: { kind: "number", indicator: null, value: 2, price: null },
      };
    });
    expect(numNum.issues.some((i) => i.message.includes("at least one price or indicator"))).toBe(
      true,
    );
    expect(
      check((s) => {
        s.entry.long!.rules[0]!.right = {
          kind: "number",
          indicator: null,
          value: 150,
          price: null,
        };
      }).issues.some((i) => i.message.includes("0 and 100")),
    ).toBe(true);
    expect(
      paths(
        check((s) => {
          s.entry.long!.rules = [];
        }),
      ),
    ).toContain("entry.long.rules");
    expect(
      paths(
        check((s) => {
          s.entry.long = null;
        }),
      ),
    ).toContain("entry.long");
  });

  it("keeps entries consistent with the direction", () => {
    const t = instantiateTemplate("trend_follower");
    expect(
      validateStrategy({ ...t, direction: "long" }, opts).issues.some(
        (i) => i.path === "entry.short",
      ),
    ).toBe(true);
    expect(
      validateStrategy({ ...t, direction: "short" }, opts).issues.some(
        (i) => i.path === "entry.long",
      ),
    ).toBe(true);
    expect(
      validateStrategy({ ...t, entry: { ...t.entry, short: null } }, opts).issues.some(
        (i) => i.path === "entry.short",
      ),
    ).toBe(true);
  });

  it("requires a loss limit and warns when one losing trade exceeds it", () => {
    expect(
      paths(
        check((s) => {
          s.risk.maxLossUsd = 0;
        }),
      ),
    ).toContain("risk.maxLossUsd");
    const w = check((s) => {
      s.risk.maxLossUsd = 1;
    });
    expect(w.ok).toBe(true);
    expect(w.warnings.some((x) => x.path === "risk.maxLossUsd")).toBe(true);
  });

  it("can't be fed NaN or infinity", () => {
    expect(
      validateStrategy(
        { ...spec(), sizing: { mode: "fixed_margin_usd", value: Number.NaN, leverage: 3 } },
        opts,
      ).ok,
    ).toBe(false);
    expect(
      check((s) => {
        s.entry.long!.rules[0]!.right = {
          kind: "number",
          indicator: null,
          value: Number.POSITIVE_INFINITY,
          price: null,
        };
      }).ok,
    ).toBe(false);
  });
});

describe("JSON schema for the model", () => {
  it("is strict: every object lists all its keys, closes extras, and pins the markets", () => {
    const schema = draftJsonSchema(["BTC-USD", "ETH-USD"]);
    const walk = (node: unknown, path = ""): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        expect(n.additionalProperties, path).toBe(false);
        expect([...(n.required as string[])].sort(), path).toEqual(
          Object.keys(n.properties as object).sort(),
        );
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    };
    walk(schema);
    expect(JSON.stringify(schema)).toContain('"enum":["BTC-USD","ETH-USD"]');
  });

  it("accepts what the templates look like wrapped as a draft, and refusals", () => {
    const ok = draftEnvelopeSchema.safeParse({
      rejected: null,
      assumptions: ["leverage defaulted to 3x"],
      spec: instantiateTemplate("breakout"),
    });
    expect(ok.success).toBe(true);
    expect(
      draftEnvelopeSchema.safeParse({
        rejected: "not a trading strategy",
        assumptions: [],
        spec: null,
      }).success,
    ).toBe(true);
    expect(strategySpecSchema.safeParse(instantiateTemplate("trend_follower")).success).toBe(true);
  });
});
