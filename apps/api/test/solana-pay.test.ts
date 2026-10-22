import { describe, expect, it } from "vitest";
import { verifyTokenPayment } from "../src/solana-pay.js";

const RECIPIENT = "CreatorWallet1111111111111111111111111111111";
const MINT = "UsdcMint111111111111111111111111111111111";
const want = {
  recipient: RECIPIENT,
  mint: MINT,
  minBaseUnits: 10_000_000n,
  memo: "TV-ABC12345",
  notBeforeMs: 1_800_000_000_000,
};

const tx = (over: Record<string, unknown> = {}) => ({
  slot: 99,
  blockTime: 1_800_000_100,
  meta: {
    err: null,
    preTokenBalances: [
      { accountIndex: 3, mint: MINT, owner: RECIPIENT, uiTokenAmount: { amount: "2000000" } },
    ],
    postTokenBalances: [
      { accountIndex: 3, mint: MINT, owner: RECIPIENT, uiTokenAmount: { amount: "12000000" } },
    ],
  },
  transaction: { message: { instructions: [{ program: "spl-memo", parsed: "TV-ABC12345" }] } },
  ...over,
});
const rpc = (result: unknown, error?: { message: string }) =>
  (async () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result, error }),
    )) as unknown as typeof fetch;
const check = (result: unknown, w = want) =>
  verifyTokenPayment("http://rpc", "sig", w, rpc(result));

describe("verifying a token payment from the chain", () => {
  it("accepts a payment that arrived, with the memo, at or above the price", async () => {
    expect(await check(tx())).toMatchObject({ ok: true, slot: 99, paidBaseUnits: 10_000_000n });
    // paying more than the price is fine
    const more = tx();
    (more.meta.postTokenBalances[0] as { uiTokenAmount: { amount: string } }).uiTokenAmount.amount =
      "99000000";
    expect(await check(more)).toMatchObject({ ok: true });
  });

  it("counts what the creator received, not what the sender says it sent", async () => {
    const short = tx();
    (
      short.meta.postTokenBalances[0] as { uiTokenAmount: { amount: string } }
    ).uiTokenAmount.amount = "11999999"; // up by 9,999,999
    expect(await check(short)).toMatchObject({ ok: false, code: "wrong_amount" });
  });

  it("refuses a transaction that doesn't exist yet, one that failed, and one from before the payment began", async () => {
    expect(await check(null)).toMatchObject({ ok: false, code: "not_found" });
    expect(await check(tx({ meta: { err: { InstructionError: [0, "x"] } } }))).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(await check(tx({ blockTime: 1_700_000_000 }))).toMatchObject({
      ok: false,
      code: "too_old",
    });
  });

  it("refuses a payment to somebody else, in another token, or without the reference", async () => {
    const other = tx();
    (other.meta.postTokenBalances[0] as { owner: string }).owner =
      "SomeoneElse111111111111111111111111111111111";
    expect(await check(other)).toMatchObject({ ok: false, code: "wrong_recipient" });
    const wrongMint = tx();
    (wrongMint.meta.postTokenBalances[0] as { mint: string }).mint = "OtherToken";
    expect(await check(wrongMint)).toMatchObject({ ok: false, code: "wrong_recipient" });
    expect(await check(tx({ transaction: { message: { instructions: [] } } }))).toMatchObject({
      ok: false,
      code: "missing_memo",
    });
    expect(
      await check(
        tx({
          transaction: {
            message: { instructions: [{ program: "spl-memo", parsed: "TV-SOMEONEELSE" }] },
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: "missing_memo" });
  });

  it("refuses money that left the creator's account", async () => {
    const out = tx();
    (out.meta.postTokenBalances[0] as { uiTokenAmount: { amount: string } }).uiTokenAmount.amount =
      "1000000"; // went down
    expect(await check(out)).toMatchObject({ ok: false, code: "wrong_recipient" });
  });

  it("surfaces an RPC error instead of guessing", async () => {
    await expect(
      verifyTokenPayment("http://rpc", "sig", want, rpc(undefined, { message: "node is behind" })),
    ).rejects.toThrow(/node is behind/);
  });
});
