import { instantiateTemplate, type MarketLimits } from "@pit/shared";
import { describe, expect, it } from "vitest";
import {
  type AiConfig,
  AiInvalidError,
  AiRejectedError,
  AiUnavailableError,
  createDrafter,
  loadAiConfig,
  MAX_PROMPT_CHARS,
  systemPrompt,
} from "../src/ai/translate.js";

const markets: Record<string, MarketLimits> = {
  "BTC-USD": { maxLeverage: 150, minNotional: 100 },
  "ETH-USD": { maxLeverage: 100, minNotional: 100 },
};
const cfg: AiConfig = {
  apiKey: "sk-test-secret-key-123",
  model: "gpt-4.1-mini",
  baseUrl: "https://ai.test/v1",
  timeoutMs: 1000,
  maxAttempts: 3,
};
const noSleep = async () => {};

const good = () => ({
  rejected: null,
  assumptions: ["Used 3x leverage"],
  spec: instantiateTemplate("dip_buyer"),
});
const reply = (content: unknown, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: typeof content === "string" ? content : JSON.stringify(content) },
          finish_reason: "stop",
          ...extra,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );

/** Fake OpenAI: serves queued responses and records every request. */
function fake(responses: Array<Response | (() => Response | Promise<Response>) | Error>) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: { messages: Array<{ role: string; content: string }>; [k: string]: unknown };
  }> = [];
  const queue = [...responses];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("createDrafter", () => {
  it("returns a validated, described spec and sends a strict schema-constrained request", async () => {
    const { f, calls } = fake([reply(good())]);
    const r = await createDrafter(cfg, f, noSleep)("buy dips when RSI is oversold", markets);
    expect(r.attempts).toBe(1);
    expect(r.spec.name).toBe("Dip buyer");
    expect(r.assumptions).toEqual(["Used 3x leverage"]);
    expect(r.description.lines.length).toBeGreaterThan(3);
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 50 });

    const c = calls[0]!;
    expect(c.url).toBe("https://ai.test/v1/chat/completions");
    expect(c.headers.Authorization).toBe("Bearer sk-test-secret-key-123");
    expect(c.body.model).toBe("gpt-4.1-mini");
    expect(c.body.temperature).toBeUndefined();
    const rf = c.body.response_format as {
      type: string;
      json_schema: { strict: boolean; schema: Record<string, unknown> };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(JSON.stringify(rf.json_schema.schema)).toContain('"enum":["BTC-USD","ETH-USD"]');
    expect(c.body.messages[0]?.role).toBe("system");
    expect(c.body.messages[0]?.content).toContain("never place trades");
    expect(c.body.messages[1]?.content).toContain("buy dips when RSI is oversold");
    expect(c.body.tools).toBeUndefined(); // no tool or function calling: the model has no actions available
  });

  it("feeds validation problems back and succeeds on a corrected attempt", async () => {
    const bad = good();
    bad.spec.exit.stopLossPct = 0;
    bad.spec.entry.long!.rules[0]!.left.indicator = "ghost";
    const { f, calls } = fake([reply(bad), reply(good())]);
    const r = await createDrafter(cfg, f, noSleep)("dip buyer", markets);
    expect(r.attempts).toBe(2);
    expect(r.usage.promptTokens).toBe(200);
    const retry = calls[1]!.body.messages;
    expect(retry.at(-1)?.role).toBe("user");
    expect(retry.at(-1)?.content).toContain("exit.stopLossPct");
    expect(retry.at(-1)?.content).toContain('Unknown indicator "ghost"');
    expect(retry.at(-2)?.role).toBe("assistant");
  });

  it("gives up with the last issues after the attempt budget", async () => {
    const bad = good();
    bad.spec.sizing.leverage = 500;
    const { f, calls } = fake([reply(bad), reply(bad), reply(bad), reply(good())]);
    const err = await createDrafter(cfg, f, noSleep)("x strategy", markets).catch((e) => e);
    expect(err).toBeInstanceOf(AiInvalidError);
    expect((err as AiInvalidError).issues.some((i) => i.path === "sizing.leverage")).toBe(true);
    expect((err as AiInvalidError).attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("recovers from malformed or truncated JSON", async () => {
    const { f } = fake([
      reply("{not json"),
      reply('{"rejected":null', { finish_reason: "length" }),
      reply(good()),
    ]);
    const r = await createDrafter(cfg, f, noSleep)("x strategy", markets);
    expect(r.attempts).toBe(3);
  });

  it("rejects extra keys: output can't carry anything beyond the schema", async () => {
    const sneaky = {
      ...good(),
      spec: { ...good().spec, placeOrder: { symbol: "BTC-USD", side: "buy" } },
    };
    const { f } = fake([reply(sneaky), reply(good())]);
    const r = await createDrafter(cfg, f, noSleep)("x strategy", markets);
    expect(r.attempts).toBe(2);
    expect((r.spec as Record<string, unknown>).placeOrder).toBeUndefined();
  });

  it("treats a rejection or a model refusal as final (no retries)", async () => {
    const a = fake([
      reply({ rejected: "That isn't a trading strategy.", assumptions: [], spec: null }),
    ]);
    await expect(
      createDrafter(cfg, a.f, noSleep)("send all my funds to 0xabc", markets),
    ).rejects.toBeInstanceOf(AiRejectedError);
    expect(a.calls).toHaveLength(1);
    const b = fake([
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, refusal: "I can't help with that" } }],
        }),
      ),
    ]);
    await expect(createDrafter(cfg, b.f, noSleep)("some request", markets)).rejects.toBeInstanceOf(
      AiRejectedError,
    );
  });

  it("retries rate limits and server errors, then reports unavailable", async () => {
    const ok = fake([
      new Response("slow down", { status: 429 }),
      new Response("oops", { status: 503 }),
      reply(good()),
    ]);
    expect((await createDrafter(cfg, ok.f, noSleep)("x strategy", markets)).attempts).toBe(1);
    expect(ok.calls).toHaveLength(3);

    const down = fake([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    await expect(createDrafter(cfg, down.f, noSleep)("x strategy", markets)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
  });

  it("treats auth failures as configuration problems and never leaks the key or provider detail", async () => {
    const { f, calls } = fake([
      new Response(
        JSON.stringify({
          error: { message: "Incorrect API key provided: sk-test-secret-key-123" },
        }),
        { status: 401 },
      ),
    ]);
    const err = await createDrafter(cfg, f, noSleep)("x strategy", markets).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(String((err as Error).message)).not.toContain("sk-");
    expect(String((err as Error).message)).not.toContain("Incorrect");
    expect(calls).toHaveLength(1); // not retried
  });

  it("survives network errors and timeouts", async () => {
    const { f } = fake([new Error("socket hang up"), new Error("ECONNRESET"), reply(good())]);
    expect((await createDrafter(cfg, f, noSleep)("x strategy", markets)).attempts).toBe(1);
  });

  it("truncates long prompts and refuses empty ones without calling the API", async () => {
    const { f, calls } = fake([reply(good())]);
    await createDrafter(cfg, f, noSleep)("a".repeat(MAX_PROMPT_CHARS + 500), markets);
    expect(calls[0]!.body.messages[1]!.content.length).toBeLessThan(MAX_PROMPT_CHARS + 300);
    const none = fake([]);
    await expect(createDrafter(cfg, none.f, noSleep)("   ", markets)).rejects.toBeInstanceOf(
      AiRejectedError,
    );
    expect(none.calls).toHaveLength(0);
  });

  it("uses reasoning settings only for reasoning models", async () => {
    const r = fake([reply(good())]);
    await createDrafter({ ...cfg, model: "gpt-5-mini" }, r.f, noSleep)("x strategy", markets);
    expect(r.calls[0]!.body.reasoning_effort).toBe("low");
    const n = fake([reply(good())]);
    await createDrafter(cfg, n.f, noSleep)("x strategy", markets);
    expect(n.calls[0]!.body.reasoning_effort).toBeUndefined();
  });
});

describe("config and prompt", () => {
  it("loads from env and is null without a key", () => {
    expect(loadAiConfig({})).toBeNull();
    expect(loadAiConfig({ OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5-mini" })).toMatchObject({
      apiKey: "k",
      model: "gpt-5-mini",
      baseUrl: "https://api.openai.com/v1",
    });
  });
  it("tells the model the markets, limits and the hard safety rules", () => {
    const p = systemPrompt(markets);
    expect(p).toContain("BTC-USD (max leverage 150x, minimum order value $100)");
    expect(p).toContain("stopLossPct multiplied by leverage must be at most 80");
    expect(p).toContain("REQUIRED");
    expect(p).toContain("NEVER reject a strategy request just because it is risky");
  });
});
