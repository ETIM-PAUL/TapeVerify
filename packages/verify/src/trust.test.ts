import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base58Decode,
  base58Encode,
  buildMemoTransaction,
  MEMO_PROGRAM,
  solanaAddress,
} from "./anchor.js";
import {
  makerFill,
  scoreAgainstBook,
  scoreAgainstPrice,
  tradeFairScore,
  walkSlice,
} from "./fairfill.js";
import { assessSlp, type SlpVault } from "./health.js";
import { levelFor, usedFraction } from "./liqalert.js";
import {
  anchorMemo,
  batchHash,
  canonicalJson,
  generateSigningKey,
  merkleProof,
  merkleRoot,
  type RecordBundle,
  type RecordPayload,
  recordHash,
  signHex,
  signingKeyFromSeed,
  tradesDigest,
  verifyBundle,
  verifyHex,
  verifyMerkleProof,
} from "./records.js";

describe("walkSlice and fair-fill scoring", () => {
  const asks = [
    { price: 100, size: 1 },
    { price: 101, size: 2 },
    { price: 103, size: 5 },
  ];

  it("prices a slice of the book, skipping what the same order already took", () => {
    expect(walkSlice(asks, 0, 1)).toBe(100);
    expect(walkSlice(asks, 0, 2)).toBeCloseTo(100.5, 9); // 1 @100 + 1 @101
    expect(walkSlice(asks, 1, 2)).toBe(101); // its own earlier fill took the 100 level
    expect(walkSlice(asks, 3, 2)).toBe(103);
    expect(walkSlice(asks, 6, 5)).toBeNull(); // not enough book left
  });

  it("scores a fill at the touch as perfect, and a worse fill lower", () => {
    const at = scoreAgainstBook({ side: "buy", role: "taker", price: 100, size: 1 }, asks, "l3");
    expect(at).toMatchObject({
      basis: "l3",
      refPrice: 100,
      expectedPrice: 100,
      slippageBps: 0,
      score: 100,
    });
    // Paid 100.25 for something the book offered at 100: 25 bps adverse, half the 50 bps allowance.
    const bad = scoreAgainstBook(
      { side: "buy", role: "taker", price: 100.25, size: 1 },
      asks,
      "l3",
    );
    expect(bad.slippageBps).toBeCloseTo(25, 6);
    expect(bad.score).toBe(50);
    expect(
      scoreAgainstBook({ side: "buy", role: "taker", price: 102, size: 1 }, asks, "l3").score,
    ).toBe(0);
  });

  it("does not punish a big order for walking the book, but shows the slippage", () => {
    // 3 units cost (100 + 2*101)/3 = 100.667 by walking the book: that is what a fair fill pays.
    const walked = scoreAgainstBook(
      { side: "buy", role: "taker", price: 100.6667, size: 3 },
      asks,
      "l3",
    );
    expect(walked.slippageBps).toBeGreaterThan(6);
    expect(walked.score).toBeGreaterThanOrEqual(99);
  });

  it("judges each fill of a sweep against its own slice", () => {
    const first = scoreAgainstBook(
      { side: "buy", role: "taker", price: 100, size: 1 },
      asks,
      "l3",
      0,
    );
    const second = scoreAgainstBook(
      { side: "buy", role: "taker", price: 101, size: 2 },
      asks,
      "l3",
      1,
    );
    expect(first.score).toBe(100);
    expect(second.score).toBe(100);
    // Without knowing the first fill consumed the 100 level, the second would look 100bps worse than the touch.
    expect(second.slippageBps).toBeCloseTo(100, 6);
  });

  it("mirrors for sells and handles an empty book", () => {
    const bids = [
      { price: 100, size: 1 },
      { price: 99, size: 1 },
    ];
    expect(
      scoreAgainstBook({ side: "sell", role: "taker", price: 100, size: 1 }, bids, "depth").score,
    ).toBe(100);
    expect(
      scoreAgainstBook({ side: "sell", role: "taker", price: 99.75, size: 1 }, bids, "depth")
        .slippageBps,
    ).toBeCloseTo(25, 6);
    expect(
      scoreAgainstBook({ side: "sell", role: "taker", price: 100, size: 1 }, [], "l3"),
    ).toMatchObject({ basis: "none", score: null });
  });

  it("uses a looser allowance against a mark price or a minute's VWAP, and grades makers as filled at their own price", () => {
    expect(
      scoreAgainstPrice({ side: "buy", role: "taker", price: 100.5, size: 1 }, 100, "mark").score,
    ).toBe(50);
    expect(
      scoreAgainstPrice({ side: "buy", role: "taker", price: 100.75, size: 1 }, 100, "candle")
        .score,
    ).toBe(50);
    expect(
      scoreAgainstPrice({ side: "buy", role: "taker", price: 99, size: 1 }, 100, "mark").score,
    ).toBe(100); // better than the benchmark
    expect(makerFill()).toMatchObject({ basis: "maker", score: 100 });
  });

  it("weights a trade's score by notional and ignores unscored legs", () => {
    expect(
      tradeFairScore([
        { score: 100, slippageBps: 0, notional: 900, basis: "l3" },
        { score: 0, slippageBps: 50, notional: 100, basis: "l3" },
        { score: null, slippageBps: null, notional: 5000, basis: "none" },
      ]),
    ).toMatchObject({ score: 90, slippageBps: 5, scored: 2, of: 3 });
    expect(
      tradeFairScore([{ score: null, slippageBps: null, notional: 10, basis: "none" }]),
    ).toMatchObject({ score: null, scored: 0 });
  });
});

describe("canonical JSON, signatures and Merkle proofs", () => {
  it("canonicalizes key order and rejects non-finite numbers", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe(
      '{"a":[2,{"c":"x","d":null}],"b":1}',
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });

  it("signs and verifies with Ed25519, and a seed gives the same key every time", () => {
    const k = generateSigningKey();
    expect(signingKeyFromSeed(k.seed)).toEqual(k);
    expect(k.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const sig = signHex(k, "hello");
    expect(verifyHex(k.publicKey, "hello", sig)).toBe(true);
    expect(verifyHex(k.publicKey, "hellO", sig)).toBe(false);
    expect(verifyHex(generateSigningKey().publicKey, "hello", sig)).toBe(false);
    expect(verifyHex("zz", "hello", sig)).toBe(false);
  });

  it("builds proofs that verify for every leaf of every tree size, and fail for anything else", () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => canonicalJson(i)).map((s) =>
        Buffer.from(s).toString("hex").padEnd(64, "0").slice(0, 64),
      );
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(leaves, i);
        expect(verifyMerkleProof(leaves[i] as string, proof, root), `n=${n} i=${i}`).toBe(true);
        expect(verifyMerkleProof("00".repeat(32), proof, root)).toBe(false);
      }
    }
    const a = ["11".repeat(32), "22".repeat(32)];
    expect(merkleRoot(a)).not.toBe(merkleRoot([...a].reverse()));
    expect(() => merkleRoot([])).toThrow();
  });

  it("separates leaves from nodes, so an inner node can't be passed off as a record", () => {
    const l = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32), "dd".repeat(32)];
    const root = merkleRoot(l);
    const fakeLeaf = merkleRoot(l.slice(0, 2)); // an inner node's hash
    expect(
      verifyMerkleProof(fakeLeaf, [{ hash: merkleRoot(l.slice(2)), side: "right" }], root),
    ).toBe(false);
  });
});

describe("verifying a record bundle", () => {
  const key = generateSigningKey();
  function bundle(over: { tamper?: (b: RecordBundle) => void } = {}) {
    const payload: RecordPayload = {
      v: 1,
      ref: "alice",
      accountId: "acct",
      seq: 2,
      takenMs: 1_000,
      stats: { trades: 12, netPnl: "34.5" },
      tradesDigest: tradesDigest([]),
      tradeCount: 12,
      prevHash: "ab".repeat(32),
    };
    const hash = recordHash(payload);
    const leaves = [hash, "cd".repeat(32), "ef".repeat(32)];
    const bp = { v: 1, createdMs: 2_000, count: 3, merkleRoot: merkleRoot(leaves), prevHash: null };
    const bh = batchHash(bp);
    const b: RecordBundle = {
      payload,
      recordHash: hash,
      signature: signHex(key, hash),
      signerKey: key.publicKey,
      previous: { recordHash: "ab".repeat(32) },
      batch: { ...bp, id: 7, batchHash: bh, signature: signHex(key, bh), signerKey: key.publicKey },
      proof: merkleProof(leaves, 0),
      anchor: { chain: "solana", cluster: "devnet", signature: "sig", memo: anchorMemo(7, bh) },
    };
    over.tamper?.(b);
    return b;
  }
  const failing = (b: RecordBundle) =>
    verifyBundle(b, key.publicKey)
      .filter((c) => !c.ok)
      .map((c) => c.name);

  it("passes when nothing was touched", () => {
    expect(failing(bundle())).toEqual([]);
  });

  it("catches a quietly edited stat", () => {
    expect(
      failing(
        bundle({ tamper: (b) => ((b.payload.stats as Record<string, unknown>).netPnl = "3400") }),
      ),
    ).toContain("record hash matches its contents");
  });

  it("catches an edit that was re-hashed but not re-signed, and one signed by a different key", () => {
    const f1 = failing(
      bundle({
        tamper: (b) => {
          (b.payload.stats as Record<string, unknown>).netPnl = "3400";
          b.recordHash = recordHash(b.payload);
        },
      }),
    );
    expect(f1).toContain("record signature is valid");
    expect(f1).toContain("record is in the batch's Merkle tree"); // and the batch root no longer holds it
    const other = generateSigningKey();
    const f2 = failing(
      bundle({
        tamper: (b) => {
          b.signerKey = other.publicKey;
          b.signature = signHex(other, b.recordHash);
        },
      }),
    );
    expect(f2).toContain("signer is the published TapeVerify key");
    expect(f2).toContain("record signature is valid");
  });

  it("catches a broken chain, a swapped batch root and a wrong anchor memo", () => {
    expect(
      failing(bundle({ tamper: (b) => (b.previous = { recordHash: "00".repeat(32) }) })),
    ).toContain("chained to the previous record");
    expect(
      failing(bundle({ tamper: (b) => b.batch && (b.batch.merkleRoot = "00".repeat(32)) })),
    ).toEqual(
      expect.arrayContaining([
        "batch hash matches its contents",
        "record is in the batch's Merkle tree",
      ]),
    );
    expect(
      failing(bundle({ tamper: (b) => b.anchor && (b.anchor.memo = "tape1:7:wrong") })),
    ).toContain("anchor memo names this batch");
  });

  it("reports what is not there yet instead of passing it", () => {
    expect(failing(bundle({ tamper: (b) => ((b.batch = null), (b.proof = null)) }))).toContain(
      "included in a signed batch",
    );
    expect(failing(bundle({ tamper: (b) => (b.anchor = null) }))).toContain(
      "batch anchored on-chain",
    );
  });

  it("commits to the whole trade history", () => {
    const t = {
      symbol: "BTC-USD",
      side: "long",
      openedMs: 1,
      closedMs: 2,
      size: "1",
      entryPrice: "100",
      exitPrice: "101",
      netPnl: "1",
      liquidated: false,
    };
    expect(tradesDigest([t])).not.toBe(tradesDigest([{ ...t, netPnl: "2" }]));
    expect(tradesDigest([t, { ...t, closedMs: 5 }])).toBe(tradesDigest([{ ...t, closedMs: 5 }, t]));
  });
});

describe("the Solana memo transaction", () => {
  it("round-trips base58", () => {
    expect(base58Decode("11111111111111111111111111111111")).toEqual(new Uint8Array(32));
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    const b = Uint8Array.from([0, 0, 1, 2, 3, 250, 251]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
    expect(base58Decode(MEMO_PROGRAM)).toHaveLength(32);
    expect(base58Encode(base58Decode(MEMO_PROGRAM))).toBe(MEMO_PROGRAM);
    expect(() => base58Decode("0OIl")).toThrow();
  });

  it("lays out a legacy transaction the network can parse, signed over its message", () => {
    const payer = generateSigningKey();
    const blockhash = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const memo = "tape1:3:abcdef";
    const { raw, signature } = buildMemoTransaction(payer, memo, blockhash);

    expect(raw[0]).toBe(1); // one signature
    const sig = raw.subarray(1, 65);
    const message = raw.subarray(65);
    expect(base58Encode(sig)).toBe(signature);
    expect([...message.subarray(0, 4)]).toEqual([1, 0, 1, 2]); // header + two accounts
    expect(message.subarray(4, 36).toString("hex")).toBe(payer.publicKey);
    expect(base58Encode(message.subarray(36, 68))).toBe(MEMO_PROGRAM);
    expect(base58Encode(message.subarray(68, 100))).toBe(blockhash);
    // one instruction: program index 1, one account (the payer), then the memo text
    expect([...message.subarray(100, 105)]).toEqual([1, 1, 1, 0, memo.length]);
    expect(message.subarray(105).toString("utf8")).toBe(memo);

    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(payer.publicKey, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, message, pub, sig)).toBe(true);
    expect(solanaAddress(payer)).toBe(base58Encode(Buffer.from(payer.publicKey, "hex")));
    expect(() => buildMemoTransaction(payer, "x".repeat(600), blockhash)).toThrow();
  });
});

describe("Strike protocol vault health", () => {
  const vault = (over: Partial<SlpVault> = {}): SlpVault => ({
    vaultId: "v",
    name: "SLP",
    status: "active",
    equity: 7000,
    walletBalance: 7100,
    sharePrice: 1.02,
    totalShares: 6900,
    depositors: 14,
    allTimePnl: 300,
    allTimeDeposits: 7000,
    allTimeWithdrawals: 400,
    ...over,
  });

  it("is ok for a vault that has held its value", () => {
    expect(assessSlp(vault(), vault())).toMatchObject({ status: "ok" });
  });
  it("is unknown when the vault can't be read", () => {
    expect(assessSlp(null, null).status).toBe("unknown");
  });
  it("watches a small share-price fall and alerts on a large one", () => {
    expect(assessSlp(vault({ sharePrice: 1.0 }), vault({ sharePrice: 1.03 })).status).toBe("watch");
    expect(assessSlp(vault({ sharePrice: 0.9 }), vault({ sharePrice: 1.03 })).status).toBe("alert");
  });
  it("does not mistake withdrawals for losses, but does catch equity that vanished", () => {
    const past = vault({ equity: 7000, allTimeWithdrawals: 400 });
    // 3,000 left through withdrawals: equity of 4,000 is exactly what's expected.
    expect(
      assessSlp(
        vault({ equity: 4000, walletBalance: 4050, allTimeWithdrawals: 3400, sharePrice: 1.02 }),
        past,
      ).status,
    ).toBe("ok");
    // 2,000 simply disappeared.
    expect(
      assessSlp(
        vault({ equity: 5000, walletBalance: 5050, allTimeWithdrawals: 400, sharePrice: 1.02 }),
        past,
      ).status,
    ).toBe("watch");
    expect(
      assessSlp(
        vault({ equity: 3000, walletBalance: 3050, allTimeWithdrawals: 400, sharePrice: 1.02 }),
        past,
      ).status,
    ).toBe("alert");
  });
  it("alerts on an inactive or empty vault and watches large open losses", () => {
    expect(assessSlp(vault({ status: "paused" }), null).status).toBe("alert");
    expect(assessSlp(vault({ equity: 0 }), null).status).toBe("alert");
    expect(assessSlp(vault({ equity: 6000, walletBalance: 7000 }), null).status).toBe("watch");
  });
});

describe("liquidation runway", () => {
  it("measures how much of the way from entry to liquidation the mark has used", () => {
    expect(usedFraction({ side: "long", entryPrice: 100, markPrice: 100, liqPrice: 90 })).toBe(0);
    expect(
      usedFraction({ side: "long", entryPrice: 100, markPrice: 94, liqPrice: 90 }),
    ).toBeCloseTo(0.6, 9);
    expect(usedFraction({ side: "long", entryPrice: 100, markPrice: 110, liqPrice: 90 })).toBe(0); // in profit
    expect(
      usedFraction({ side: "short", entryPrice: 100, markPrice: 108, liqPrice: 110 }),
    ).toBeCloseTo(0.8, 9);
    expect(usedFraction({ side: "long", entryPrice: 100, markPrice: 95, liqPrice: 0 })).toBeNull();
    expect(
      usedFraction({ side: "long", entryPrice: 100, markPrice: 95, liqPrice: 105 }),
    ).toBeNull(); // nonsense input
  });
  it("maps runway used to a level, the same at any leverage", () => {
    expect(levelFor(0.3)).toBeNull();
    expect(levelFor(0.6)).toBe("warn");
    expect(levelFor(0.8)).toBe("danger");
    expect(levelFor(0.95)).toBe("critical");
  });
});
