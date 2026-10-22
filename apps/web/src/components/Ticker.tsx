import { useEffect, useRef, useState } from "react";
import { api, type MarketInfo } from "../api";

type Dir = "up" | "down" | "";

const fmt = (v: string) => {
  const n = Number(v);
  return n >= 100
    ? n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : n.toLocaleString("en-US", { maximumSignificantDigits: 5 });
};

/** The board: every market's mark price, tinting green or red when it moves since the last look. */
export function Ticker() {
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [dirs, setDirs] = useState<Record<string, Dir>>({});
  const last = useRef<Record<string, number>>({});
  useEffect(() => {
    const load = () =>
      api
        .get<{ markets: MarketInfo[] }>("/v1/markets")
        .then((r) => {
          const next: Record<string, Dir> = {};
          for (const m of r.markets) {
            const prev = last.current[m.symbol];
            const now = Number(m.mark);
            next[m.symbol] = prev === undefined || prev === now ? "" : now > prev ? "up" : "down";
            last.current[m.symbol] = now;
          }
          setMarkets(r.markets);
          setDirs((old) => {
            // keep the last tint until the price moves again
            const merged: Record<string, Dir> = { ...old };
            for (const [k, v] of Object.entries(next)) if (v) merged[k] = v;
            return merged;
          });
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (markets.length === 0) return null;
  return (
    <div className="ticker" aria-label="Mark prices">
      <div className="ticker-in">
        {markets.map((m) => (
          <span key={m.symbol} className={`tick ${dirs[m.symbol] ?? ""}`}>
            {m.baseAsset}
            <b>{fmt(m.mark)}</b>
          </span>
        ))}
        <span className="ticker-net">Mark prices from Strike</span>
      </div>
    </div>
  );
}
