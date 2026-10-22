import { describeStrategy, instantiateTemplate } from "@tapeverify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AiInvalidError,
  AiRejectedError,
  AiUnavailableError,
  type DraftFn,
} from "../src/ai/translate.js";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

let calls = 0;
let mode: "ok" | "rejected" | "invalid" | "unavailable" = "ok";
const draft: DraftFn = async () => {
  calls++;
  if (mode === "rejected") throw new AiRejectedError("That isn't a trading strategy.");
  if (mode === "invalid")
    throw Object.assign(
      new AiInvalidError([{ path: "exit.stopLossPct", message: "required" }], 3),
      { usage: { promptTokens: 10, completionTokens: 5 } },
    );
  if (mode === "unavailable") throw new AiUnavailableError();
  const spec = instantiateTemplate("trend_follower");
  return {
    spec,
    assumptions: ["Used 4h candles"],
    description: describeStrategy(spec),
    warnings: [],
    attempts: 1,
    model: "fake-model",
    usage: { promptTokens: 120, completionTokens: 60 },
  };
};

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({}, false, draft);
});
afterAll(async () => t.close());

const post = (cookie: string, url: string, payload: unknown) =>
  t.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });
const get = (cookie: string, url: string) =>
  t.app.inject({ method: "GET", url, headers: { cookie } });

describe("drafting", () => {
  it("needs a session and a sensible prompt", async () => {
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/v1/strategies/draft",
          payload: { prompt: "buy dips" },
        })
      ).statusCode,
    ).toBe(401);
    const s = await signIn(t, "solana", solAddress());
    expect((await post(s.cookie, "/v1/strategies/draft", { prompt: "x" })).statusCode).toBe(400);
    expect(
      (await post(s.cookie, "/v1/strategies/draft", { prompt: "a".repeat(2001) })).statusCode,
    ).toBe(400);
  });

  it("returns a spec with a plain-language reading, assumptions and warnings — and saves nothing", async () => {
    mode = "ok";
    const s = await signIn(t, "solana", solAddress());
    const r = await post(s.cookie, "/v1/strategies/draft", { prompt: "follow the trend on 4h" });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.spec.name).toBe("Trend follower");
    expect(body.assumptions).toEqual(["Used 4h candles"]);
    expect(body.description.lines.length).toBeGreaterThan(3);
    expect(body.attempts).toBe(1);
    const saved = await get(s.cookie, "/v1/strategies");
    expect(saved.json().strategies).toHaveLength(0);
    const u = await t.pool.query(
      "SELECT model, attempts, prompt_tokens, ok FROM ai_usage WHERE user_id = $1",
      [s.user.id],
    );
    expect(u.rows).toEqual([{ model: "fake-model", attempts: 1, prompt_tokens: 120, ok: true }]);
  });

  it("maps refusals, invalid drafts and outages to clear errors", async () => {
    const s = await signIn(t, "solana", solAddress());
    mode = "rejected";
    const a = await post(s.cookie, "/v1/strategies/draft", {
      prompt: "send all my money to a friend",
    });
    expect([a.statusCode, a.json().code]).toEqual([422, "not_a_strategy"]);
    mode = "invalid";
    const b = await post(s.cookie, "/v1/strategies/draft", { prompt: "something odd" });
    expect([b.statusCode, b.json().code]).toEqual([502, "invalid_draft"]);
    expect(b.json().issues[0].path).toBe("exit.stopLossPct");
    mode = "unavailable";
    const c = await post(s.cookie, "/v1/strategies/draft", { prompt: "anything at all" });
    expect([c.statusCode, c.json().code]).toEqual([503, "ai_unavailable"]);
    mode = "ok";
  });

  it("reports unavailable when no AI key is configured", async () => {
    const none = await makeApp({}, false, null);
    const s = await signIn(none, "solana", solAddress());
    const r = await none.app.inject({
      method: "POST",
      url: "/v1/strategies/draft",
      payload: { prompt: "buy the dip" },
      headers: { cookie: s.cookie },
    });
    expect([r.statusCode, r.json().code]).toEqual([503, "ai_unavailable"]);
    await none.close();
  });

  it("enforces the daily limit before calling the model", async () => {
    mode = "ok";
    const s = await signIn(t, "solana", solAddress());
    await t.pool.query(
      "INSERT INTO ai_usage (user_id, model, attempts, ok) SELECT $1, 'm', 1, true FROM generate_series(1, 30)",
      [s.user.id],
    );
    const before = calls;
    const r = await post(s.cookie, "/v1/strategies/draft", { prompt: "buy the dip please" });
    expect([r.statusCode, r.json().code]).toEqual([429, "daily_limit"]);
    expect(calls).toBe(before);
  });
});

describe("templates and validation", () => {
  it("lists the four templates, each valid and described", async () => {
    const r = await t.app.inject({ method: "GET", url: "/v1/strategies/templates" });
    expect(r.statusCode).toBe(200);
    const list = r.json().templates;
    expect(list.map((x: { id: string }) => x.id)).toEqual([
      "dip_buyer",
      "trend_follower",
      "funding_rate",
      "breakout",
    ]);
    for (const tpl of list) {
      expect(tpl.spec.market).toBe("BTC-USD");
      expect(tpl.description.lines.length).toBeGreaterThan(3);
    }
    expect(list.find((x: { id: string }) => x.id === "funding_rate").needsFundingHistory).toBe(
      true,
    );
  });

  it("validates an edited spec and describes it, or lists the problems", async () => {
    const s = await signIn(t, "solana", solAddress());
    const spec = instantiateTemplate("breakout");
    const ok = await post(s.cookie, "/v1/strategies/validate", { spec });
    expect(ok.json()).toMatchObject({ ok: true, issues: [] });
    expect(ok.json().description.headline).toBe("Breakout: long and short on BTC-USD");
    spec.sizing.leverage = 40; // 2% stop x 40 = 80 is ok; 3% would not be
    spec.exit.stopLossPct = 3;
    const bad = await post(s.cookie, "/v1/strategies/validate", { spec });
    expect(bad.json().ok).toBe(false);
    expect(bad.json().issues[0].message).toContain("liquidation");
    expect(bad.json().description).toBeNull();
    expect(
      (await post(s.cookie, "/v1/strategies/validate", { spec: { nonsense: true } })).json().ok,
    ).toBe(false);
  });
});

describe("saving and editing", () => {
  it("saves a valid spec, refuses an invalid one, and keeps the original prompt for AI drafts", async () => {
    const s = await signIn(t, "solana", solAddress());
    const spec = instantiateTemplate("dip_buyer");
    const bad = await post(s.cookie, "/v1/strategies", {
      spec: { ...spec, exit: { ...spec.exit, stopLossPct: 0 } },
    });
    expect(bad.statusCode).toBe(400);
    const r = await post(s.cookie, "/v1/strategies", {
      spec,
      source: "ai",
      prompt: "buy dips when oversold",
    });
    expect(r.statusCode, r.body).toBe(201);
    const got = (await get(s.cookie, `/v1/strategies/${r.json().id}`)).json();
    expect(got).toMatchObject({ source: "ai", prompt: "buy dips when oversold", status: "draft" });
    expect(got.spec.name).toBe("Dip buyer");
    expect(got.description.lines.length).toBeGreaterThan(3);
    const list = (await get(s.cookie, "/v1/strategies")).json().strategies;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Dip buyer", market: "BTC-USD", timeframe: "1h" });
  });

  it("edits and deletes only your own drafts, re-validating every save", async () => {
    const a = await signIn(t, "solana", solAddress());
    const b = await signIn(t, "solana", solAddress());
    const id = (
      await post(a.cookie, "/v1/strategies", {
        spec: instantiateTemplate("breakout"),
        source: "template",
      })
    ).json().id;
    const edited = instantiateTemplate("breakout");
    edited.name = "My breakout";
    edited.exit.stopLossPct = 1.5;
    const put = (cookie: string, spec: unknown, sid = id) =>
      t.app.inject({
        method: "PUT",
        url: `/v1/strategies/${sid}`,
        payload: { spec },
        headers: { cookie },
      });
    expect((await put(a.cookie, edited)).statusCode).toBe(200);
    expect((await get(a.cookie, `/v1/strategies/${id}`)).json().spec.exit.stopLossPct).toBe(1.5);
    expect((await get(a.cookie, "/v1/strategies")).json().strategies[0].name).toBe("My breakout");
    expect(
      (await put(a.cookie, { ...edited, exit: { ...edited.exit, stopLossPct: 99 } })).statusCode,
    ).toBe(400);
    expect((await put(b.cookie, edited)).statusCode).toBe(404);
    expect((await get(b.cookie, `/v1/strategies/${id}`)).statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/strategies/${id}`,
          headers: { cookie: b.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/strategies/${id}`,
          headers: { cookie: a.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect((await get(a.cookie, `/v1/strategies/${id}`)).statusCode).toBe(404);
  });

  it("caps how many strategies a user can keep", async () => {
    const s = await signIn(t, "solana", solAddress());
    await t.pool.query(
      "INSERT INTO strategies (user_id, name, spec, source) SELECT $1, 'x', '{}', 'manual' FROM generate_series(1, 50)",
      [s.user.id],
    );
    expect(
      (
        await post(s.cookie, "/v1/strategies", {
          spec: instantiateTemplate("breakout"),
          source: "template",
        })
      ).statusCode,
    ).toBe(409);
  });
});
