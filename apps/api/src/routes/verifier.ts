import { anchorMemo, batchHash, fetchMemos, verifyHex } from "@tapeverify/verify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { callWithTrader } from "../calls/model.js";
import { lockedNow } from "../lock.js";

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const HEX64 = /^[0-9a-f]{64}$/i;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** What a pasted string is: a call link or code, a record or batch hash, an anchor memo or a transaction signature. */
export function classify(raw: string): {
  kind: "call" | "hash" | "memo" | "signature" | "record_id" | "unknown";
  value: string;
  batchId?: number;
} {
  const q = raw.trim().replace(/^["'`]|["'`]$/g, "");
  const memo = /^tape1:(\d+):([0-9a-f]{64})$/i.exec(q);
  if (memo)
    return { kind: "memo", value: (memo[2] as string).toLowerCase(), batchId: Number(memo[1]) };
  if (HEX64.test(q)) return { kind: "hash", value: q.toLowerCase() };
  const link = /\/(?:call|c)\/([A-Za-z0-9]{4,16})(?:[/?#].*)?$/.exec(q);
  if (link) return { kind: "call", value: link[1] as string };
  if (SIGNATURE.test(q)) return { kind: "signature", value: q };
  if (/^\d{1,9}$/.test(q)) return { kind: "record_id", value: q };
  if (/^[A-Za-z0-9]{4,16}$/.test(q)) return { kind: "call", value: q };
  return { kind: "unknown", value: q };
}

const rel = (a: number, b: number) => Math.abs(a - b) / (Math.abs(b) || 1);

export function verifierRoutes(app: FastifyInstance, d: AppDeps) {
  const web = d.api.publicWebUrl.replace(/\/$/, "");

  async function lookupCall(code: string) {
    const [row] = await callWithTrader(d.pool, "c.short_code = $1", [code]);
    if (!row) return { type: "unknown" as const, message: "No call with that code." };
    const trader = { ref: row.handle ?? row.user_id, name: row.handle ?? short(row.address) };
    if (lockedNow(row)) {
      return {
        type: "call" as const,
        locked: true,
        trader,
        code: row.short_code,
        message:
          "This is a premium call. Its details stay hidden until it closes, and then it can be verified here.",
      };
    }
    const checks: Check[] = [];
    const fills: Array<Record<string, unknown>> = [];
    const acct = (
      await d.pool.query("SELECT strike_account_id FROM users WHERE id = $1", [row.user_id])
    ).rows[0]?.strike_account_id as string | undefined;
    const entryPrice = row.entry_price === null ? null : Number(row.entry_price);
    let entryFillId: string | null = null;

    if (!acct) {
      checks.push({
        name: "Entry matches Strike fills",
        ok: false,
        detail: "This account's fills aren't indexed.",
      });
    } else if (entryPrice === null || row.entry_order_id === null) {
      checks.push({
        name: "Entry matches Strike fills",
        ok: false,
        detail: "The entry hasn't been recorded from a fill yet.",
      });
    } else {
      const ef = (
        await d.pool.query(
          "SELECT id, trade_id, side, price, size, role, ts_ms FROM fills WHERE account_id = $1 AND order_id = $2 ORDER BY ts_ms",
          [acct, String(row.entry_order_id)],
        )
      ).rows;
      if (ef.length === 0) {
        checks.push({
          name: "Entry matches Strike fills",
          ok: false,
          detail: "No fills for the entry order are indexed.",
        });
      } else {
        const size = ef.reduce((a, f) => a + Number(f.size), 0);
        const vwap = ef.reduce((a, f) => a + Number(f.price) * Number(f.size), 0) / size;
        const priceOk = rel(vwap, entryPrice) <= 1e-6;
        const sizeOk = row.entry_size === null || rel(size, Number(row.entry_size)) <= 1e-6;
        checks.push({
          name: "Entry matches Strike fills",
          ok: priceOk && sizeOk,
          detail: `${ef.length} fill${ef.length === 1 ? "" : "s"}, average ${vwap.toPrecision(8).replace(/\.?0+$/, "")} for ${size} (the call says ${row.entry_price} for ${row.entry_size}).`,
        });
        entryFillId = ef[0]?.id ?? null;
        for (const f of ef)
          fills.push({
            leg: "entry",
            id: f.id,
            side: f.side,
            price: String(f.price),
            size: String(f.size),
            role: f.role,
            at: Number(f.ts_ms),
          });
      }
    }

    if (
      row.status === "closed" &&
      row.exit_price !== null &&
      row.exit_ts_ms !== null &&
      row.entry_ts_ms !== null &&
      acct
    ) {
      const opposite = row.side === "long" ? "sell" : "buy";
      const cf = (
        await d.pool.query(
          "SELECT id, side, price, size, role, ts_ms FROM fills WHERE account_id = $1 AND symbol = $2 AND side = $3 AND ts_ms BETWEEN $4 AND $5 ORDER BY ts_ms",
          [acct, row.symbol, opposite, row.entry_ts_ms, row.exit_ts_ms],
        )
      ).rows;
      const want = Number(row.exit_size ?? row.entry_size ?? 0);
      const used: typeof cf = [];
      let got = 0;
      for (const f of cf) {
        if (got >= want - 1e-12) break;
        used.push(f);
        got += Number(f.size);
      }
      if (used.length === 0) {
        checks.push({
          name: "Exit matches closing fills",
          ok: false,
          detail: "No closing fills for this account are indexed.",
        });
      } else {
        const vwap = used.reduce((a, f) => a + Number(f.price) * Number(f.size), 0) / got;
        checks.push({
          name: "Exit matches closing fills",
          ok: rel(vwap, Number(row.exit_price)) <= 1e-4,
          detail: `${used.length} fill${used.length === 1 ? "" : "s"}, average ${vwap.toPrecision(8).replace(/\.?0+$/, "")} (the call says ${row.exit_price}).`,
        });
        for (const f of used)
          fills.push({
            leg: "exit",
            id: f.id,
            side: f.side,
            price: String(f.price),
            size: String(f.size),
            role: f.role,
            at: Number(f.ts_ms),
          });
      }
    }

    const fair =
      entryFillId && acct
        ? (
            await d.pool.query(
              "SELECT basis, slippage_bps, score FROM fill_scores WHERE account_id = $1 AND fill_id = $2",
              [acct, entryFillId],
            )
          ).rows[0]
        : null;
    const dir = row.side === "long" ? 1 : -1;
    const result =
      row.status === "closed" && row.entry_price && row.exit_price
        ? ((Number(row.exit_price) - Number(row.entry_price)) / Number(row.entry_price)) *
          100 *
          dir *
          row.leverage
        : null;
    return {
      type: "call" as const,
      locked: false,
      trader,
      call: {
        code: row.short_code,
        symbol: row.symbol,
        side: row.side,
        leverage: row.leverage,
        status: row.status,
        entry: row.entry_price
          ? {
              price: String(row.entry_price),
              size: row.entry_size === null ? null : String(row.entry_size),
              at: row.entry_ts_ms === null ? null : Number(row.entry_ts_ms),
            }
          : null,
        exit: row.exit_price
          ? {
              price: String(row.exit_price),
              reason: row.exit_reason,
              at: row.exit_ts_ms === null ? null : Number(row.exit_ts_ms),
            }
          : null,
        resultPct: result,
      },
      checks,
      fills,
      entryFill: fair
        ? {
            basis: fair.basis,
            slippageBps: fair.slippage_bps === null ? null : Number(fair.slippage_bps),
            score: fair.score,
          }
        : null,
      links: { call: `${web}/call/${row.short_code}`, trader: `${web}/t/${trader.ref}` },
    };
  }

  async function lookupBatch(b: Record<string, unknown>) {
    const id = Number(b.id);
    const checks: Check[] = [];
    const payload = {
      v: 1,
      createdMs: Number(b.created_ms),
      count: Number(b.count),
      merkleRoot: String(b.merkle_root),
      prevHash: (b.prev_hash as string | null) ?? null,
    };
    checks.push({
      name: "Batch hash matches its contents",
      ok: batchHash(payload) === b.batch_hash,
    });
    const key = d.api.recordPublicKey;
    checks.push(
      key
        ? {
            name: "Batch signature is valid",
            ok: b.signer_key === key && verifyHex(key, String(b.batch_hash), String(b.signature)),
          }
        : {
            name: "Batch signature is valid",
            ok: false,
            detail: "No public key is configured to check against.",
          },
    );
    const prev = (
      await d.pool.query(
        "SELECT batch_hash FROM record_batches WHERE id < $1 ORDER BY id DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    checks.push({
      name: "Chained to the previous batch",
      ok: (prev?.batch_hash ?? null) === payload.prevHash,
      detail: prev ? undefined : "first batch",
    });
    const anchor = b.anchor as { signature: string; cluster: string; memo: string } | null;
    if (!anchor) checks.push({ name: "Anchored on-chain", ok: false, detail: "Not anchored yet." });
    else {
      const want = anchorMemo(id, String(b.batch_hash));
      let onChain: Check = {
        name: "Anchor transaction on-chain carries this batch hash",
        ok: false,
        detail: "Chain not checked.",
      };
      if (d.api.anchorRpcUrl) {
        try {
          const tx = await fetchMemos(d.api.anchorRpcUrl, anchor.signature, d.fetchImpl);
          onChain = !tx
            ? { ...onChain, detail: "Transaction not found on the chain." }
            : tx.failed
              ? { ...onChain, detail: "The transaction failed." }
              : {
                  ...onChain,
                  ok: tx.memos.includes(want),
                  detail: tx.memos.includes(want)
                    ? `slot ${tx.slot}`
                    : "The on-chain memo doesn't match.",
                };
        } catch (e) {
          onChain.detail = `Chain unreachable: ${(e as Error).message}`;
        }
      }
      checks.push({ name: "Anchor memo names this batch", ok: anchor.memo === want }, onChain);
    }
    const recs = await d.pool.query(
      `SELECT s.id, s.seq, u.handle, u.address FROM record_snapshots s JOIN users u ON u.id = s.user_id WHERE s.batch_id = $1 ORDER BY s.leaf_index LIMIT 200`,
      [id],
    );
    return {
      type: "batch" as const,
      batch: {
        id,
        v: 1,
        createdMs: Number(b.created_ms),
        count: Number(b.count),
        merkleRoot: b.merkle_root,
        batchHash: b.batch_hash,
        prevHash: b.prev_hash,
        signature: b.signature,
        signerKey: b.signer_key,
        anchor,
      },
      records: recs.rows.map((r) => ({
        id: Number(r.id),
        seq: r.seq,
        trader: r.handle ?? short(r.address),
      })),
      checks,
      ok: checks.every((c) => c.ok),
    };
  }

  app.get(
    "/v1/verify/lookup",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const { q } = z.object({ q: z.string().trim().min(1).max(300) }).parse(req.query);
      const c = classify(q);
      if (c.kind === "call") return lookupCall(c.value);

      if (c.kind === "record_id") {
        const r = (
          await d.pool.query(
            "SELECT s.id, s.seq, s.taken_ms, s.batch_id, u.handle, u.address FROM record_snapshots s JOIN users u ON u.id = s.user_id WHERE s.id = $1",
            [Number(c.value)],
          )
        ).rows[0];
        if (!r) return { type: "unknown" as const, message: "No record with that number." };
        return {
          type: "record" as const,
          recordId: Number(r.id),
          trader: r.handle ?? short(r.address),
          seq: r.seq,
          takenAt: Number(r.taken_ms),
          batched: r.batch_id !== null,
        };
      }
      if (c.kind === "hash" || c.kind === "memo") {
        if (c.kind === "hash") {
          const r = (
            await d.pool.query(
              "SELECT s.id, s.seq, s.taken_ms, s.batch_id, u.handle, u.address FROM record_snapshots s JOIN users u ON u.id = s.user_id WHERE s.record_hash = $1",
              [c.value],
            )
          ).rows[0];
          if (r)
            return {
              type: "record" as const,
              recordId: Number(r.id),
              trader: r.handle ?? short(r.address),
              seq: r.seq,
              takenAt: Number(r.taken_ms),
              batched: r.batch_id !== null,
            };
        }
        const b = (
          await d.pool.query(
            "SELECT * FROM record_batches WHERE batch_hash = $1 OR merkle_root = $1 ORDER BY id LIMIT 1",
            [c.value],
          )
        ).rows[0];
        if (b) {
          const out = await lookupBatch(b);
          if (c.kind === "memo" && c.batchId !== Number(b.id))
            out.checks.push({
              name: "Memo names this batch",
              ok: false,
              detail: `The memo says batch ${c.batchId}, but that hash belongs to batch ${b.id}.`,
            });
          return out;
        }
        return { type: "unknown" as const, message: "Nothing here matches that hash." };
      }
      if (c.kind === "signature") {
        const b = (
          await d.pool.query("SELECT * FROM record_batches WHERE anchor->>'signature' = $1", [
            c.value,
          ])
        ).rows[0];
        return b
          ? lookupBatch(b)
          : { type: "unknown" as const, message: "That transaction isn't one of our anchors." };
      }
      return {
        type: "unknown" as const,
        message:
          "Paste a call link or code, a record hash, an anchor memo or a transaction signature.",
      };
    },
  );
}
