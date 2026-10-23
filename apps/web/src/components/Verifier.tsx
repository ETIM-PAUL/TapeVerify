import { useCallback, useEffect, useState } from "react";
import { api, type LookupCheck, type LookupOut } from "../api";
import { usd } from "../format";
import {
  type Bundle,
  batchHashOf,
  checkAnchorOnChain,
  supportsEd25519,
  verifyBundle,
  verifyEd25519,
} from "../verifier";

interface KeyInfo {
  publicKey: string | null;
  rpcUrl: string | null;
}
type Recheck = { checks: LookupCheck[]; key: string };

const EXAMPLES = [
  "a call link or code",
  "a record hash",
  "an anchor memo (tape1:…)",
  "a Solana transaction signature",
];

/** A batch that simply hasn't been written to the chain yet isn't a failure: everything else can still be proven. */
const isPending = (c: LookupCheck) => !c.ok && c.detail === "not anchored yet";

function Checks({ checks }: { checks: LookupCheck[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.name} className={c.ok ? "pass" : isPending(c) ? "pending" : "fail"}>
          <span className="mark" aria-hidden="true">
            {c.ok ? "✓" : isPending(c) ? "…" : "✗"}
          </span>
          <span>
            {c.name}
            {c.detail && <span className="muted small"> · {c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const verdict = (checks: LookupCheck[]): "pass" | "pending" | "fail" => {
  if (checks.length === 0 || checks.some((c) => !c.ok && !isPending(c))) return "fail";
  return checks.some(isPending) ? "pending" : "pass";
};
const VERDICT_TEXT = {
  pass: "Verified in your browser",
  pending: "Verified · waiting for on-chain anchor",
  fail: "Something doesn't check out",
};

export function Verifier() {
  const initial = new URLSearchParams(window.location.search).get("q") ?? "";
  const [q, setQ] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LookupOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState<KeyInfo | null>(null);
  const [expectedKey, setExpectedKey] = useState("");
  const [recheck, setRecheck] = useState<Recheck | null>(null);
  const [edOk, setEdOk] = useState<boolean | null>(null);
  const [fileText, setFileText] = useState("");
  const [fileResult, setFileResult] = useState<Recheck | null>(null);

  useEffect(() => {
    api
      .get<KeyInfo>("/v1/records/key")
      .then((k) => {
        setKey(k);
        setExpectedKey(k.publicKey ?? "");
      })
      .catch(() => setKey({ publicKey: null, rpcUrl: null }));
    supportsEd25519().then(setEdOk);
  }, []);

  /** Re-check a record in this browser: our server's word is not part of the answer. */
  const recheckBundle = useCallback(
    async (bundle: Bundle, trusted: string): Promise<Recheck> => {
      const checks = await verifyBundle(bundle, trusted);
      if (key?.rpcUrl && bundle.anchor) checks.push(await checkAnchorOnChain(bundle, key.rpcUrl));
      return { checks, key: trusted };
    },
    [key],
  );

  const go = useCallback(
    async (text: string) => {
      const query = text.trim();
      if (!query) return;
      setBusy(true);
      setErr(null);
      setResult(null);
      setRecheck(null);
      window.history.replaceState(null, "", `/verify?q=${encodeURIComponent(query)}`);
      try {
        const r = await api.get<LookupOut>(`/v1/verify/lookup?q=${encodeURIComponent(query)}`);
        setResult(r);
        if (r.type === "record") {
          const bundle = await api.get<Bundle & { publicKey: string }>(`/v1/records/${r.recordId}`);
          setRecheck(await recheckBundle(bundle, expectedKey || bundle.publicKey));
        } else if (r.type === "batch") {
          const b = r.batch;
          const local: LookupCheck[] = [
            {
              name: "Batch hash matches its contents (checked here)",
              ok: (await batchHashOf(b)) === b.batchHash,
            },
            {
              name: "Batch signature is valid (checked here)",
              ok:
                b.signerKey === (expectedKey || b.signerKey) &&
                (await verifyEd25519(expectedKey || b.signerKey, b.batchHash, b.signature)),
            },
          ];
          if (key?.rpcUrl && b.anchor)
            local.push(
              await checkAnchorOnChain(
                {
                  anchor: {
                    chain: "solana",
                    cluster: b.anchor.cluster,
                    signature: b.anchor.signature,
                    memo: b.anchor.memo,
                  },
                  batch: { ...b, id: b.id },
                } as unknown as Bundle,
                key.rpcUrl,
              ),
            );
          setRecheck({ checks: local, key: expectedKey || b.signerKey });
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [expectedKey, key, recheckBundle],
  );

  // Open straight into a result when someone follows a "verify this" link.
  useEffect(() => {
    if (initial && key) void go(initial);
  }, [key]);

  async function checkFile() {
    setFileResult(null);
    try {
      const b = JSON.parse(fileText) as Bundle;
      if (!b.payload || !b.recordHash || !b.signature)
        throw new Error("That doesn't look like a record file.");
      setFileResult(await recheckBundle(b, expectedKey || b.signerKey));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const batchVerdict =
    result?.type === "batch" ? verdict([...result.checks, ...(recheck?.checks ?? [])]) : "fail";

  return (
    <div className="stack narrow-page verifier">
      <div>
        <h1>Verify anything</h1>
        <p className="muted">
          Paste a call, a record, or an on-chain anchor. Records are checked in your browser, not by
          our server, so you don't have to trust us to trust the answer.
        </p>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void go(q);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Call link, record hash, tape1:… memo or transaction signature"
          aria-label="What to verify"
          autoFocus
        />
        <button type="submit" disabled={busy || !q.trim()}>
          {busy ? "Checking…" : "Verify"}
        </button>
      </form>
      <p className="muted small">You can paste: {EXAMPLES.join(" · ")}.</p>
      {edOk === false && (
        <p className="banner">
          This browser can't check Ed25519 signatures yet, so signature checks will fail. Use a
          current Chrome, Safari or Firefox.
        </p>
      )}
      {err && <p className="error">{err}</p>}

      {result?.type === "unknown" && (
        <div className="card">
          <p>{result.message}</p>
        </div>
      )}

      {result?.type === "call" && result.locked && (
        <div className="card">
          <h2>Premium call from {result.trader.name}</h2>
          <p className="muted">{result.message}</p>
        </div>
      )}

      {result?.type === "call" && !result.locked && (
        <div className="card stack">
          <div className="row spread">
            <h2>
              {result.call.symbol} {result.call.side} {result.call.leverage}x by{" "}
              <a href={result.links.trader}>{result.trader.name}</a>
            </h2>
            <span className={`verdict ${verdict(result.checks)}`}>
              {verdict(result.checks) === "pass" ? "Matches Strike's fills" : "Doesn't fully match"}
            </span>
          </div>
          <div className="stats">
            <div className="stat">
              <span className="muted">Entry</span>
              <b>{result.call.entry ? usd(result.call.entry.price) : "—"}</b>
            </div>
            <div className="stat">
              <span className="muted">Exit</span>
              <b>{result.call.exit ? usd(result.call.exit.price) : "open"}</b>
            </div>
            <div className="stat">
              <span className="muted">Result</span>
              <b className={(result.call.resultPct ?? 0) >= 0 ? "pos" : "neg"}>
                {result.call.resultPct === null
                  ? "—"
                  : `${result.call.resultPct >= 0 ? "+" : ""}${result.call.resultPct.toFixed(2)}%`}
              </b>
            </div>
            {result.entryFill?.score != null && (
              <div className="stat">
                <span className="muted">Entry fill quality</span>
                <b>{result.entryFill.score}/100</b>
              </div>
            )}
          </div>
          <Checks checks={result.checks} />
          <details>
            <summary className="muted small">The fills behind it ({result.fills.length})</summary>
            <table>
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>Fill</th>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Size</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {result.fills.map((f) => (
                  <tr key={`${f.leg}-${f.id}`}>
                    <td>{f.leg}</td>
                    <td className="small">{f.id}</td>
                    <td>{f.side}</td>
                    <td>{f.price}</td>
                    <td>{f.size}</td>
                    <td className="small">{new Date(f.at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="muted small">
            These are the fills Strike reported for the trader's account, compared with what the
            call says. <a href={result.links.call}>Open the call</a>.
          </p>
        </div>
      )}

      {result?.type === "record" && (
        <div className="card stack">
          <div className="row spread">
            <h2>
              Record #{result.seq} for {result.trader}
            </h2>
            {recheck && (
              <span className={`verdict ${verdict(recheck.checks)}`}>
                {VERDICT_TEXT[verdict(recheck.checks)]}
              </span>
            )}
          </div>
          <p className="muted small">
            Taken {new Date(result.takenAt).toLocaleString()}.{" "}
            {result.batched ? "" : "Not in a signed batch yet."}
          </p>
          {recheck ? <Checks checks={recheck.checks} /> : <p className="muted">Checking…</p>}
        </div>
      )}

      {result?.type === "batch" && (
        <div className="card stack">
          <div className="row spread">
            <h2>
              Batch {result.batch.id} · {result.batch.count} records
            </h2>
            <span className={`verdict ${batchVerdict}`}>
              {batchVerdict === "pass"
                ? "Checks out"
                : batchVerdict === "pending"
                  ? "Checks out · waiting for on-chain anchor"
                  : "Something doesn't check out"}
            </span>
          </div>
          <p className="muted small">Sealed {new Date(result.batch.createdMs).toLocaleString()}.</p>
          <h3 className="small muted">Checked by our server</h3>
          <Checks checks={result.checks} />
          {recheck && (
            <>
              <h3 className="small muted">Checked again in your browser</h3>
              <Checks checks={recheck.checks} />
            </>
          )}
          <details>
            <summary className="muted small">Records in this batch</summary>
            <ul className="warnlist">
              {result.records.map((r) => (
                <li key={r.id}>
                  <a href={`/verify?q=${r.id}`}>
                    {r.trader} · record #{r.seq}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div className="card stack">
        <h2>Don't trust the key we show you</h2>
        <p className="muted small">
          Every check above is against one public key. If our site showed you a different key, it
          could "verify" forged records. Compare it with the key published somewhere we don't
          control (our README and repository), or paste the one you trust here and re-run the check.
        </p>
        <label>
          Public key to check against
          <input
            value={expectedKey}
            onChange={(e) => setExpectedKey(e.target.value.trim())}
            placeholder="64 hex characters"
            spellCheck={false}
          />
        </label>
        {key?.publicKey && expectedKey && expectedKey !== key.publicKey && (
          <p className="warn small">
            This is different from the key this site reports ({key.publicKey.slice(0, 12)}…). That's
            fine if you got yours from a source you trust.
          </p>
        )}
        <details>
          <summary className="muted small">Verify a record file you downloaded</summary>
          <div className="stack">
            <textarea
              className="code"
              value={fileText}
              onChange={(e) => setFileText(e.target.value)}
              placeholder="Paste the record JSON (the bundle from /v1/records/<id>)"
            />
            <div className="row">
              <button
                type="button"
                className="ghost"
                disabled={!fileText.trim()}
                onClick={checkFile}
              >
                Check this file
              </button>
            </div>
            {fileResult && <Checks checks={fileResult.checks} />}
          </div>
        </details>
      </div>
    </div>
  );
}
