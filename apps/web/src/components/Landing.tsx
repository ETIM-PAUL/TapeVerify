import { useEffect, useState } from "react";
import { api, type FeedEvent, type User } from "../api";
import type { ActiveWallet } from "../wallet-context";
import { Connect } from "./Connect";
import { EventRow } from "./Social";

const POINTS = [
  {
    title: "Records you can check yourself",
    body: "Paste any call or record into the verifier. Records are re-checked in your own browser against a public key, so you don't have to take our word for it.",
    href: "/verify",
    link: "Open the verifier",
  },
  {
    title: "See how fairly trades were filled",
    body: "Every fill is compared with the order book at that moment, so slippage shows up as a score instead of staying hidden.",
    href: "/leaderboard",
    link: "See the leaderboard",
  },
  {
    title: "Copy with limits you set",
    body: "Choose a maximum margin, loss and daily loss once. Every copy respects them, and a replay shows what following a trader would have made.",
    href: "/feed",
    link: "Browse the feed",
  },
];

export function Landing({ onDone }: { onDone: (user: User, wallet: ActiveWallet) => void }) {
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  useEffect(() => {
    api
      .get<{ events: FeedEvent[] }>("/v1/feed?scope=all&limit=6")
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, []);

  return (
    <div className="stack landing">
      <div className="hero">
        <div className="stack">
          <h1 className="display">Copy traders whose results you can check.</h1>
          <p className="lede">
            TapeVerify is social trading on Strike. Every trade comes from the trader's own fills,
            every record is signed and anchored on-chain, and you decide how much of it you copy.
          </p>
          <div className="row">
            <a className="connect-link" href="/verify">
              Verify something
            </a>
            <a className="sharelink" href="/leaderboard">
              See top traders
            </a>
          </div>
        </div>
        <Connect onDone={onDone} bare />
      </div>

      <div className="points">
        {POINTS.map((p) => (
          <div key={p.title} className="card stack">
            <h2>{p.title}</h2>
            <p className="muted">{p.body}</p>
            <a href={p.href}>{p.link}</a>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Happening now</h2>
        {events === null ? null : events.length === 0 ? (
          <p className="muted">
            Nothing has been posted yet. Connect a wallet and post the first call.
          </p>
        ) : (
          <ul className="penalties">
            {events.map((e) => (
              <EventRow
                key={`${e.kind}-${e.at}-${e.call?.code ?? e.trade?.symbol}-${e.trader.ref}`}
                e={e}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
