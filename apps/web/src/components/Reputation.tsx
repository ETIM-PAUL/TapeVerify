import type { VerifyInfo } from "../api";

export const KIND_LABEL: Record<string, string> = {
  front_running: "Exited right after followers entered",
  front_running_pattern: "Repeatedly exits right after followers enter",
  self_trade: "Trades with itself",
  collusion_pair: "Trades back and forth with one other account",
  sybil_cluster: "Follower accounts that look like one operator",
};

/** One short badge: the strongest trust signal first. */
export function TrustBadge({ verify }: { verify: VerifyInfo | null }) {
  if (!verify) return <span className="muted small">—</span>;
  if (verify.clean) return <span className="badge clean">Clean record</span>;
  if (verify.underReview)
    return (
      <span
        className={`badge ${verify.worst === "high" || verify.worst === "critical" ? "flag" : "review"}`}
      >
        Under review
      </span>
    );
  if (verify.penalties.length > 0) return <span className="badge flag">Flagged</span>;
  return <span className="muted small">Not yet</span>;
}

export function ReputationCard({ verify }: { verify: VerifyInfo | null }) {
  if (!verify)
    return (
      <div className="card">
        <h2>Reputation</h2>
        <p className="muted">No score yet: it needs a track record of closed trades.</p>
      </div>
    );
  return (
    <div className="card">
      <div className="row spread">
        <h2>Reputation</h2>
        <TrustBadge verify={verify} />
      </div>
      <div className="stats">
        <div className="stat">
          <span className="muted">Score</span>
          <b>{verify.score}</b>
        </div>
        <div className="stat">
          <span className="muted">From performance</span>
          <b>{verify.performance}</b>
        </div>
        <div className="stat">
          <span className="muted">Trust penalty</span>
          <b className={verify.penalties.length ? "error" : ""}>
            {verify.penalties.length
              ? `-${verify.penalties.reduce((a, p) => a + p.points, 0)}`
              : "0"}
          </b>
        </div>
      </div>
      {verify.penalties.length > 0 && (
        <ul className="penalties">
          {verify.penalties.map((p) => (
            <li key={`${p.kind}-${p.summary}`}>
              <b>{KIND_LABEL[p.kind] ?? p.kind}</b>{" "}
              <span className="muted small">
                · {p.severity} · {p.status} · -{p.points}
              </span>
              <br />
              <span className="muted">{p.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {!verify.clean && verify.cleanReasons.length > 0 && (
        <details>
          <summary className="muted small">Why there's no clean-record badge</summary>
          <ul className="warnlist">
            {verify.cleanReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">
        Reputation combines verified performance with trust checks (front-running, self-trading,
        fake followers). A flag counts against the score until a reviewer decides, and the trader
        can appeal.
      </p>
    </div>
  );
}
