import { randomUUID } from "node:crypto";
import { anchorMemo, generateSigningKey, sealBatch, takeSnapshots } from "@tapeverify/verify";
import { describe, expect, it } from "vitest";
import { classify } from "../src/routes/verifier.js";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;
const key = generateSigningKey();

describe("what a pasted string is", () => {
  it("recognises links, codes, hashes, memos, signatures and record numbers", () => {
    const hash = "ab".repeat(32);
    expect(classify("https://tapeverify.example/call/k7Qm2xPa")).toEqual({
      kind: "call",
      value: "k7Qm2xPa",
    });
    expect(classify("https://api.example/c/k7Qm2xPa?x=1")).toEqual({
      kind: "call",
      value: "k7Qm2xPa",
    });
    expect(classify("  k7Qm2xPa ")).toEqual({ kind: "call", value: "k7Qm2xPa" });
    expect(classify(hash.toUpperCase())).toEqual({ kind: "hash", value: hash });
    expect(classify(`tape1:12:${hash}`)).toEqual({ kind: "memo", value: hash, batchId: 12 });
    expect(classify("5".repeat(88)).kind).toBe("signature");
    expect(classify("42")).toEqual({ kind: "record_id", value: "42" });
    expect(classify("not a thing!").kind).toBe("unknown");
    expect(classify('"quoted"')).toEqual({ kind: "call", value: "quoted" });
  });
});

async function world(extra: { fetchImpl?: typeof fetch } = {}) {
  const t = await makeApp({}, false, null, { RECORD_PUBLIC_KEY: key.publicKey }, extra);
  const trader = await signIn(t, "solana", solAddress());
  const account = `verif-${randomUUID()}`;
  await t.pool.query("UPDATE users SET strike_account_id = $2, handle = $3 WHERE id = $1", [
    trader.user.id,
    account,
    `vf${Math.random().toString(36).slice(2, 8)}`,
  ]);
  return { t, trader, account };
}
const lookup = async (t: TestApp, q: string) =>
  (
    await t.app.inject({ method: "GET", url: `/v1/verify/lookup?q=${encodeURIComponent(q)}` })
  ).json();

async function closedCall(
  t: TestApp,
  userId: string,
  account: string,
  over: { entry?: number; exit?: number; premium?: boolean; status?: string } = {},
) {
  const code = `V${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const order = String(Math.floor(Math.random() * 1e9));
  const entry = over.entry ?? 80000;
  const exit = over.exit ?? 84000;
  await t.pool.query(
    `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_order_id, entry_trade_id, entry_price, entry_size, entry_ts_ms, exit_price, exit_size, exit_ts_ms, exit_reason, premium)
     VALUES ($1,$2,'BTC-USD','long',10,0.002,$3,50,$4,$5,1,$6,0.002,$7,$8,0.002,$9,'tp',$10)`,
    [
      code,
      userId,
      now,
      over.status ?? "closed",
      order,
      entry,
      now - 2 * HOUR,
      over.status === "open" ? null : exit,
      now - HOUR,
      over.premium ?? false,
    ],
  );
  // the fills Strike reported: entry in two pieces, exit in one
  const fill = (
    id: string,
    orderId: string,
    side: string,
    price: number,
    size: number,
    ts: number,
    role = "taker",
  ) =>
    t.pool.query(
      `INSERT INTO fills (account_id, id, trade_id, order_id, symbol, side, role, price, size, realized_pnl, fee, ts_ms, raw) VALUES ($1,$2,$3,$4,'BTC-USD',$5,$6,$7,$8,0,0,$9,'{}')`,
      [account, id, Math.floor(Math.random() * 1e9), orderId, side, role, price, size, ts],
    );
  await fill(`${code}-e1`, order, "buy", entry - 10, 0.001, now - 2 * HOUR);
  await fill(`${code}-e2`, order, "buy", entry + 10, 0.001, now - 2 * HOUR + 500);
  await fill(`${code}-x1`, `${order}-x`, "sell", exit, 0.002, now - HOUR);
  return code;
}

describe("verifying a call", () => {
  it("checks the call's entry and exit against the fills Strike reported", async () => {
    const { t, trader, account } = await world();
    const code = await closedCall(t, trader.user.id, account);
    const r = await lookup(t, code);
    expect(r.type).toBe("call");
    expect(r.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual([
      ["Entry matches Strike fills", true],
      ["Exit matches closing fills", true],
    ]);
    expect(r.checks[0].detail).toMatch(/2 fills/);
    expect(r.call).toMatchObject({ code, side: "long", leverage: 10, status: "closed" });
    expect(r.call.resultPct).toBeCloseTo(50, 6);
    expect(r.fills.filter((f: { leg: string }) => f.leg === "entry")).toHaveLength(2);
    expect(r.fills.filter((f: { leg: string }) => f.leg === "exit")).toHaveLength(1);
    expect(r.links.call).toContain(`/call/${code}`);
    // pasting the link works the same
    expect((await lookup(t, `https://x.example/call/${code}`)).call.code).toBe(code);
    await t.close();
  });

  it("fails the check, and says why, when the call doesn't match the fills", async () => {
    const { t, trader, account } = await world();
    const code = await closedCall(t, trader.user.id, account);
    await t.pool.query(
      "UPDATE calls SET entry_price = 79000, exit_price = 90000 WHERE short_code = $1",
      [code],
    ); // someone edited the call
    const r = await lookup(t, code);
    expect(r.checks.map((c: { ok: boolean }) => c.ok)).toEqual([false, false]);
    expect(r.checks[0].detail).toMatch(/the call says 79000/);
    expect(r.checks[1].detail).toMatch(/the call says 90000/);
    await t.close();
  });

  it("says plainly when there are no fills to check against", async () => {
    const { t, trader, account } = await world();
    const code = await closedCall(t, trader.user.id, account);
    await t.pool.query("DELETE FROM fills WHERE account_id = $1", [account]);
    const r = await lookup(t, code);
    expect(r.checks.every((c: { ok: boolean }) => !c.ok)).toBe(true);
    expect(r.checks[0].detail).toMatch(/No fills for the entry order/);
    await t.close();
  });

  it("reveals nothing about a premium call that is still locked, and verifies it once it closes", async () => {
    const { t, trader, account } = await world();
    const code = await closedCall(t, trader.user.id, account, { premium: true, status: "open" });
    const locked = await lookup(t, code);
    expect(locked).toMatchObject({ type: "call", locked: true });
    for (const secret of ["80000", "long", "checks", "fills"])
      expect(JSON.stringify(locked), secret).not.toContain(secret);
    await t.pool.query(
      "UPDATE calls SET status = 'closed', exit_price = 84000, exit_ts_ms = $2 WHERE short_code = $1",
      [code, Date.now() - 1000],
    );
    expect((await lookup(t, code)).locked).toBe(false);
    await t.close();
  });

  it("includes how fairly the caller's entry was filled when that's known", async () => {
    const { t, trader, account } = await world();
    const code = await closedCall(t, trader.user.id, account);
    await t.pool.query(
      "INSERT INTO fill_scores (account_id, fill_id, basis, slippage_bps, score, scored_ms) VALUES ($1,$2,'l3',3.5,93,1)",
      [account, `${code}-e1`],
    );
    expect((await lookup(t, code)).entryFill).toEqual({ basis: "l3", slippageBps: 3.5, score: 93 });
    await t.close();
  });

  it("answers for unknown input without guessing", async () => {
    const { t } = await world();
    expect((await lookup(t, "ZZZZZZZZ")).type).toBe("unknown");
    expect((await lookup(t, "!!! nothing !!!")).message).toMatch(/Paste a call link/);
    expect((await lookup(t, "ab".repeat(32))).type).toBe("unknown");
    expect((await t.app.inject({ method: "GET", url: "/v1/verify/lookup" })).statusCode).toBe(400);
    await t.close();
  });
});

describe("verifying records and batches", () => {
  async function anchored() {
    const memoFor = new Map<string, string>();
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      const sigIn = JSON.parse(init.body).params[0];
      const memo = memoFor.get(sigIn);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result:
            memo === undefined
              ? null
              : {
                  slot: 7,
                  blockTime: 1,
                  meta: { err: null },
                  transaction: {
                    message: { instructions: [{ program: "spl-memo", parsed: memo }] },
                  },
                },
        }),
      );
    }) as unknown as typeof fetch;
    const { t, trader, account } = await world({ fetchImpl });
    for (let i = 0; i < 3; i++)
      await t.pool.query(
        `INSERT INTO trades (account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional, gross_pnl, fees, funding, net_pnl)
         VALUES ($1,'BTC-USD','long',$2,$3,1,100,101,100,1,0,0,1)`,
        [account, Date.now() - (i + 2) * HOUR, Date.now() - (i + 1) * HOUR],
      );
    await takeSnapshots(t.pool, key, Date.now(), undefined, [trader.user.id]);
    const batch = await sealBatch(t.pool, key);
    const b = (
      await t.pool.query("SELECT batch_hash, merkle_root FROM record_batches WHERE id = $1", [
        batch?.id,
      ])
    ).rows[0];
    const signature = solAddress() + solAddress();
    const memo = anchorMemo(batch?.id as number, b.batch_hash);
    await t.pool.query("UPDATE record_batches SET anchor = $2 WHERE id = $1", [
      batch?.id,
      JSON.stringify({ chain: "solana", cluster: "devnet", signature, memo }),
    ]);
    memoFor.set(signature, memo);
    const rec = (
      await t.pool.query("SELECT id, record_hash FROM record_snapshots WHERE user_id = $1", [
        trader.user.id,
      ])
    ).rows[0];
    return {
      t,
      batchId: batch?.id as number,
      batchHash: b.batch_hash as string,
      root: b.merkle_root as string,
      signature,
      memo,
      rec,
      memoFor,
    };
  }

  it("finds a record by its hash or number, ready to be verified in the browser", async () => {
    const a = await anchored();
    for (const q of [a.rec.record_hash, String(a.rec.id)]) {
      const r = await lookup(a.t, q);
      expect(r).toMatchObject({
        type: "record",
        recordId: Number(a.rec.id),
        seq: 1,
        batched: true,
      });
    }
    await a.t.close();
  });

  it("verifies a batch from its hash, root, memo or anchor transaction, including what the chain says", async () => {
    const a = await anchored();
    for (const q of [a.batchHash, a.root, a.memo, a.signature]) {
      const r = await lookup(a.t, q);
      expect(r.type, q).toBe("batch");
      expect(
        r.checks.filter((c: { ok: boolean }) => !c.ok),
        q,
      ).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.records).toHaveLength(1);
      expect(r.batch.anchor.signature).toBe(a.signature);
    }
    await a.t.close();
  });

  it("flags a batch whose on-chain memo is different, one that can't be found on-chain, and a memo naming the wrong batch", async () => {
    const a = await anchored();
    a.memoFor.set(a.signature, "pit1:999:deadbeef");
    const bad = await lookup(a.t, a.batchHash);
    expect(
      bad.checks.find((c: { name: string }) => c.name.startsWith("Anchor transaction")).ok,
    ).toBe(false);
    expect(bad.ok).toBe(false);
    a.memoFor.delete(a.signature);
    expect(
      (await lookup(a.t, a.batchHash)).checks.find((c: { name: string }) =>
        c.name.startsWith("Anchor transaction"),
      ).detail,
    ).toMatch(/not found/);
    a.memoFor.set(a.signature, a.memo);
    const wrong = await lookup(a.t, `tape1:${a.batchId + 1000}:${a.batchHash}`);
    expect(wrong.checks.at(-1)).toMatchObject({ name: "Memo names this batch", ok: false });
    await a.t.close();
  });

  it("notices a batch edited after it was signed", async () => {
    const a = await anchored();
    await a.t.pool.query("UPDATE record_batches SET count = 999 WHERE id = $1", [a.batchId]);
    const r = await lookup(a.t, a.batchHash);
    expect(
      r.checks.find((c: { name: string }) => c.name === "Batch hash matches its contents").ok,
    ).toBe(false);
    expect(r.ok).toBe(false);
    await a.t.close();
  });
});
