import {
  batchHash,
  generateSigningKey,
  merkleProof,
  merkleRoot,
  type RecordPayload,
  recordHash,
  signHex,
} from "@tapeverify/verify";
import { describe, expect, it } from "vitest";
import {
  type Bundle,
  canonicalJson,
  checkAnchorOnChain,
  recordHashOf,
  sha256Hex,
  supportsEd25519,
  verifyBundle,
} from "./verifier.js";

// The browser verifier is written separately from the server's on purpose, so these tests build real bundles with the
// server's code and require the browser's answers to agree, check for check, including on tampered ones.

const key = generateSigningKey();
function make(over: { tamper?: (b: Bundle) => void } = {}): Bundle {
  const payload: RecordPayload = {
    v: 1,
    ref: "alice",
    accountId: "acct",
    seq: 2,
    takenMs: 1_000,
    stats: {
      trades: 12,
      netPnl: "34.5",
      winRate: 0.58,
      nested: { b: [1, 2, { z: null, a: "é" }] },
    },
    tradesDigest: "ab".repeat(32),
    tradeCount: 12,
    prevHash: "cd".repeat(32),
  };
  const hash = recordHash(payload);
  const leaves = [hash, "11".repeat(32), "22".repeat(32), "33".repeat(32), "44".repeat(32)];
  const bp = {
    v: 1,
    createdMs: 2_000,
    count: leaves.length,
    merkleRoot: merkleRoot(leaves),
    prevHash: null,
  };
  const bh = batchHash(bp);
  const b: Bundle = {
    payload: payload as unknown as Bundle["payload"],
    recordHash: hash,
    signature: signHex(key, hash),
    signerKey: key.publicKey,
    previous: { recordHash: "cd".repeat(32) },
    batch: { ...bp, id: 9, batchHash: bh, signature: signHex(key, bh), signerKey: key.publicKey },
    proof: merkleProof(leaves, 0),
    anchor: { chain: "solana", cluster: "devnet", signature: "sig", memo: `tape1:9:${bh}` },
  };
  over.tamper?.(b);
  return b;
}
const failing = async (b: Bundle, k = key.publicKey) =>
  (await verifyBundle(b, k)).filter((c) => !c.ok).map((c) => c.name);

describe("hashing agrees with the server", () => {
  it("canonicalises and hashes exactly the same", async () => {
    const v = { b: 1, a: [2, { d: null, c: "é " }], n: 0.1 };
    expect(canonicalJson(v)).toBe('{"a":[2,{"c":"é ","d":null}],"b":1,"n":0.1}');
    const { canonicalJson: server } = await import("@tapeverify/verify");
    expect(canonicalJson(v)).toBe(server(v));
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const b = make();
    expect(await recordHashOf(b.payload)).toBe(b.recordHash);
  });
});

describe("verifying in the browser", () => {
  it("has Ed25519 in this environment", async () => {
    expect(await supportsEd25519()).toBe(true);
  });

  it("passes an untouched bundle", async () => {
    expect(await failing(make())).toEqual([]);
  });

  it("catches an edited stat, a swapped signer, a broken chain, a bad proof and a wrong memo, like the server does", async () => {
    expect(
      await failing(
        make({ tamper: (b) => ((b.payload.stats as Record<string, unknown>).netPnl = "3400") }),
      ),
    ).toContain("Record hash matches its contents");
    const other = generateSigningKey();
    expect(
      await failing(
        make({
          tamper: (b) => {
            b.signerKey = other.publicKey;
            b.signature = signHex(other, b.recordHash);
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "Signed by the key you are comparing against",
        "Record signature is valid",
      ]),
    );
    expect(
      await failing(make({ tamper: (b) => (b.previous = { recordHash: "00".repeat(32) }) })),
    ).toContain("Chained to the previous record");
    expect(
      await failing(
        make({
          tamper: (b) =>
            b.proof && (b.proof[0] = { ...b.proof[0], hash: "00".repeat(32) } as never),
        }),
      ),
    ).toContain("Record is in the batch's Merkle tree");
    expect(
      await failing(make({ tamper: (b) => b.batch && (b.batch.merkleRoot = "00".repeat(32)) })),
    ).toEqual(
      expect.arrayContaining([
        "Batch hash matches its contents",
        "Record is in the batch's Merkle tree",
      ]),
    );
    expect(
      await failing(make({ tamper: (b) => b.anchor && (b.anchor.memo = "tape1:9:wrong") })),
    ).toContain("Anchor memo names this batch");
  });

  it("re-hashing an edited record doesn't help: the signature and the batch no longer agree", async () => {
    const f = await failing(
      make({
        tamper: async (b) => {
          (b.payload.stats as Record<string, unknown>).netPnl = "3400";
        },
      }),
    );
    expect(f).toContain("Record hash matches its contents");
    const b = make();
    (b.payload.stats as Record<string, unknown>).netPnl = "3400";
    b.recordHash = await recordHashOf(b.payload);
    expect(await failing(b)).toEqual(
      expect.arrayContaining(["Record signature is valid", "Record is in the batch's Merkle tree"]),
    );
  });

  it("agrees with the server's verifier on every tampering, check by check", async () => {
    const { verifyBundle: serverVerify } = await import("@tapeverify/verify");
    const cases: Array<(b: Bundle) => void> = [
      () => {},
      (b) => ((b.payload.stats as Record<string, unknown>).trades = 1),
      (b) => (b.signature = "00".repeat(64)),
      (b) => (b.previous = null),
      (b) => (b.batch = null),
      (b) => (b.anchor = null),
      (b) => b.batch && (b.batch.signature = "00".repeat(64)),
    ];
    for (const [i, tamper] of cases.entries()) {
      const bundle = make({ tamper });
      const browser = (await verifyBundle(bundle, key.publicKey)).map((c) => c.ok);
      const server = serverVerify(bundle as never, key.publicKey).map((c) => c.ok);
      expect(browser, `case ${i}`).toEqual(server);
    }
  });

  it("checks the anchor on a Solana node itself, and reports what it finds", async () => {
    const b = make();
    const node = (memo: string | null, err: unknown = null) =>
      (async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              memo === null
                ? null
                : {
                    slot: 5,
                    meta: { err },
                    transaction: {
                      message: { instructions: [{ program: "spl-memo", parsed: memo }] },
                    },
                  },
          }),
        )) as unknown as typeof fetch;
    const want = b.anchor?.memo as string;
    expect(await checkAnchorOnChain(b, "http://rpc", node(want))).toMatchObject({
      ok: true,
      detail: "slot 5",
    });
    expect(await checkAnchorOnChain(b, "http://rpc", node("tape1:9:other"))).toMatchObject({
      ok: false,
      detail: "The memo on-chain is different",
    });
    expect(await checkAnchorOnChain(b, "http://rpc", node(null))).toMatchObject({ ok: false });
    expect(
      await checkAnchorOnChain(b, "http://rpc", node(want, { InstructionError: 1 })),
    ).toMatchObject({ ok: false, detail: "The transaction failed on-chain" });
    expect(
      await checkAnchorOnChain(b, "http://rpc", (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch),
    ).toMatchObject({ ok: false });
    expect(await checkAnchorOnChain({ ...b, anchor: null }, "http://rpc")).toMatchObject({
      ok: false,
      detail: "not anchored yet",
    });
  });
});
