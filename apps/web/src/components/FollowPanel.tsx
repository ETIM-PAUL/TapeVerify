import { useState } from "react";
import { api, type Call, type CallDetail, type FollowInfo, type LiveView } from "../api";
import { usd } from "../format";

const BLOCKED: Record<string, string> = {
  expired: "The follow window for this call is over.",
  not_open: "This call isn't open for following.",
  drifted: "The price has moved too far from the caller's entry to follow safely.",
};

export function FollowPanel({
  call,
  live,
  detail,
  available,
  onFollowed,
}: {
  call: Call;
  live: LiveView | null;
  detail: CallDetail;
  available: number;
  onFollowed: () => void;
}) {
  const [margin, setMargin] = useState("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const mine: FollowInfo | null = detail.viewer?.follow ?? null;

  if (mine) {
    return (
      <div className="card">
        <h2>You're following this call</h2>
        <p>
          {mine.status === "pending" && "Order sent. Waiting for your fill…"}
          {mine.status === "open" &&
            `Open. Your entry: ${usd(mine.entry?.price)} (caller entered at ${usd(mine.callEntryPrice)}).`}
          {mine.status === "closed" &&
            `Closed at ${usd(mine.exit?.price)}${mine.exit?.reason ? ` (${mine.exit.reason})` : ""}.`}
          {mine.status === "failed" && `Not filled: ${mine.failReason ?? "rejected"}.`}
        </p>
      </div>
    );
  }

  const blocked = live && !live.followable.ok ? live.followable : null;
  const m = Number(margin) || 0;
  const notional = m * call.leverage;

  async function follow() {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/v1/calls/${call.code}/follow`, { marginUsd: margin, requestKey: key });
      setKey(crypto.randomUUID());
      onFollowed();
    } catch (e) {
      setError((e as Error).message);
      onFollowed(); // refresh live state: the block reason may have changed
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Follow this call</h2>
      {blocked ? (
        <p className="warn">
          {BLOCKED[blocked.reason]}
          {blocked.reason === "drifted" &&
            blocked.driftBps !== undefined &&
            ` (${blocked.driftBps} bps from entry, limit ${call.maxDriftBps})`}
        </p>
      ) : (
        <>
          <p className="muted small">
            Copies the caller's {call.side} {call.symbol} at {call.leverage}x with the same
            take-profit and stop-loss, using your own margin. Available: {usd(available)}.
          </p>
          <div className="row">
            <input
              inputMode="decimal"
              value={margin}
              onChange={(e) => setMargin(e.target.value)}
              placeholder="Margin (USD)"
            />
            <button type="button" disabled={busy || !(m > 0)} onClick={follow}>
              {busy ? "Placing…" : "Follow"}
            </button>
          </div>
          <p className="muted small">
            Position value ≈ {usd(notional)} at market. You enter at the live price, not the
            caller's.
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
