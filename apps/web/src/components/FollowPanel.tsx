import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  type Call,
  type CallDetail,
  type FollowInfo,
  type FollowPreview,
  type LiveView,
} from "../api";
import { usd } from "../format";
import { Modal } from "./Modal";

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
  const [flags, setFlags] = useState<Array<{
    kind: string;
    severity: string;
    summary: string;
  }> | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const mine: FollowInfo | null = detail.viewer?.follow ?? null;
  const [preview, setPreview] = useState<FollowPreview | null>(null);
  const following = Boolean(mine);
  const [closing, setClosing] = useState(false);

  async function closeMine(id: string) {
    setError(null);
    setClosing(true);
    try {
      await api.post(`/v1/follows/${id}/close`);
      // Wait for the exit fill to be recorded (up to 60s).
      for (let i = 0; i < 40; i++) {
        const r = await api.get<CallDetail>(`/v1/calls/${call.code}`);
        if (r.viewer?.follow?.status === "closed") break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClosing(false);
      onFollowed();
    }
  }

  // What the person's own limits would do to this copy, shown before they press Follow.
  useEffect(() => {
    const m = Number(margin);
    if (following || !(m > 0)) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .post<FollowPreview>(`/v1/calls/${call.code}/follow/preview`, { marginUsd: margin })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [margin, call.code, following]);

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
        {mine.status === "closed" && mine.exit?.realizedPnl && (
          <p>
            Result:{" "}
            <b className={Number(mine.exit.realizedPnl) >= 0 ? "ok" : "error"}>
              {usd(mine.exit.realizedPnl)}
            </b>
          </p>
        )}
        {mine.status === "open" && (
          <button type="button" disabled={closing} onClick={() => closeMine(mine.id)}>
            Close my position
          </button>
        )}
        {error && <p className="error">{error}</p>}
        {closing && (
          <Modal title="Closing position" onClose={() => {}}>
            <p className="muted">
              Closing your copy of this {call.symbol} {call.side}. Waiting for the exchange to
              confirm. This window closes by itself when it does.
            </p>
          </Modal>
        )}
      </div>
    );
  }

  const blocked = live && !live.followable.ok ? live.followable : null;
  const m = Number(margin) || 0;
  const guard = preview?.guard;
  const guardBlocked = guard?.ok === false;
  const notional = guard?.ok ? guard.marginUsd * guard.leverage : m * call.leverage;

  async function follow(acceptRisk = false) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/v1/calls/${call.code}/follow`, {
        marginUsd: margin,
        requestKey: key,
        ...(acceptRisk ? { acceptRisk: true } : {}),
      });
      setKey(crypto.randomUUID());
      setFlags(null);
      onFollowed();
    } catch (e) {
      if (e instanceof ApiError && e.code === "caller_flagged") {
        setFlags((e.data?.flags as typeof flags) ?? []);
        setBusy(false);
        return;
      }
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
            <button
              type="button"
              disabled={busy || !(m > 0) || guardBlocked}
              onClick={() => follow()}
            >
              {busy ? "Placing…" : "Follow"}
            </button>
          </div>
          {preview && guard && (
            <div className={guardBlocked ? "banner" : "guardnote"}>
              {guard.ok ? (
                guard.adjustments.length > 0 ? (
                  <div>
                    <b>Your guardrails will change this copy:</b>
                    <ul className="warnlist">
                      {guard.adjustments.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                    <span className="small muted">
                      You'll copy with {usd(guard.marginUsd)} at {guard.leverage}x.{" "}
                      <a href="/guardrails">Edit guardrails</a>
                    </span>
                  </div>
                ) : (
                  preview.guardrails.length > 0 && (
                    <span className="small muted">
                      Within your guardrails. <a href="/guardrails">Edit</a>
                    </span>
                  )
                )
              ) : (
                <span>
                  {guard.reason} <a href="/guardrails">Edit guardrails</a>
                </span>
              )}
            </div>
          )}
          {preview && preview.guardrails.length === 0 && (
            <p className="muted small">
              No limits set. <a href="/guardrails">Set guardrails</a> to cap margin, leverage and
              losses on every copy.
            </p>
          )}
          <p className="muted small">
            Position value ≈ {usd(notional)} at market. You enter at the live price, not the
            caller's.
          </p>
        </>
      )}
      {flags && (
        <div className="stack">
          <p className="warn">
            TapeVerify's trust checks have flagged this caller. Following means copying someone with
            unresolved trust concerns:
          </p>
          <ul className="warnlist">
            {flags.map((f) => (
              <li key={`${f.kind}-${f.summary}`}>
                {f.severity}: {f.summary}
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={() => follow(true)}>
              Follow anyway
            </button>
            <button type="button" onClick={() => setFlags(null)}>
              Don't follow
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
