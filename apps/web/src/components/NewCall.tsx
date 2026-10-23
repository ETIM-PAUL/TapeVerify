import { useEffect, useMemo, useState } from "react";
import { api, type Call, type MarketInfo } from "../api";
import { usd } from "../format";

export function NewCall({ onCreated }: { onCreated: () => void }) {
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [symbol, setSymbol] = useState("BTC-USD");
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState("5");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [expiry, setExpiry] = useState("60");
  const [drift, setDrift] = useState("50");
  const [premium, setPremium] = useState(false);
  const [delay, setDelay] = useState("0");
  const [hasPlan, setHasPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Call | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api
      .get<{ markets: MarketInfo[] }>("/v1/markets")
      .then((r) => {
        setMarkets(r.markets);
        if (r.markets.length && !r.markets.some((m) => m.symbol === "BTC-USD"))
          setSymbol(r.markets[0]?.symbol ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get<{ plan: { active: boolean } | null }>("/v1/me/plan")
      .then((r) => setHasPlan(Boolean(r.plan?.active)))
      .catch(() => {});
  }, []);

  // An old error shouldn't linger once the inputs it was about have changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears on input change only
  useEffect(() => setError(null), [symbol, side, size, leverage, tp, sl]);

  const market = markets.find((m) => m.symbol === symbol);
  const notional = useMemo(
    () => (market && Number(size) > 0 ? Number(size) * Number(market.mark) : 0),
    [market, size],
  );

  async function submit() {
    setError(null);
    const mark = Number(market?.mark);
    const long = side === "long";
    if (mark > 0) {
      if (tp && Number(tp) > 0 && Number(tp) > mark !== long)
        return setError(
          `Take-profit ${tp} must be ${long ? "above" : "below"} the current price ${mark} for a ${side}`,
        );
      if (sl && Number(sl) > 0 && Number(sl) > mark === long)
        return setError(
          `Stop-loss ${sl} must be ${long ? "below" : "above"} the current price ${mark} for a ${side}`,
        );
    }
    setBusy(true);
    try {
      const { call } = await api.post<{ call: Call }>("/v1/calls", {
        symbol,
        side,
        size,
        leverage: Number(leverage),
        tpPrice: tp || undefined,
        slPrice: sl || undefined,
        expiryMinutes: Number(expiry),
        maxDriftBps: Number(drift),
        ...(premium ? { premium: true, publicDelayMinutes: Number(delay) || 0 } : {}),
        requestKey,
      });
      setCreated(call);
      setRequestKey(crypto.randomUUID()); // a fresh key for the next call
      setSize("");
      setTp("");
      setSl("");
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>New call</h2>
      <div className="row">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {markets.map((m) => (
            <option key={m.symbol}>{m.symbol}</option>
          ))}
        </select>
        <div className="seg">
          <button
            type="button"
            className={side === "long" ? "on" : ""}
            onClick={() => setSide("long")}
          >
            Long
          </button>
          <button
            type="button"
            className={side === "short" ? "on" : ""}
            onClick={() => setSide("short")}
          >
            Short
          </button>
        </div>
      </div>
      <div className="row">
        <input
          inputMode="decimal"
          placeholder={`Size (${market?.baseAsset ?? ""})`}
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
        <input
          inputMode="numeric"
          placeholder="Leverage"
          value={leverage}
          onChange={(e) => setLeverage(e.target.value)}
        />
      </div>
      <div className="row">
        <input
          inputMode="decimal"
          placeholder="Take-profit price"
          value={tp}
          onChange={(e) => setTp(e.target.value)}
        />
        <input
          inputMode="decimal"
          placeholder="Stop-loss price"
          value={sl}
          onChange={(e) => setSl(e.target.value)}
        />
      </div>
      <div className="row">
        <label className="muted small">
          Followers have (min)
          <input inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <label className="muted small">
          Max price drift (bps)
          <input inputMode="numeric" value={drift} onChange={(e) => setDrift(e.target.value)} />
        </label>
      </div>
      {market && (
        <p className="muted small">
          Mark {usd(market.mark)} · value ≈ {usd(notional)} · margin ≈{" "}
          {usd(notional / (Number(leverage) || 1))} · min order {usd(market.minNotional)} · max
          leverage {market.maxLeverage}x
        </p>
      )}
      {hasPlan ? (
        <div className="stack">
          <label className="check">
            <input
              type="checkbox"
              checked={premium}
              onChange={(e) => setPremium(e.target.checked)}
            />
            Subscribers only: hide the trade from everyone else until it closes
          </label>
          {premium && (
            <label className="muted small">
              Make it public after (minutes, 0 = when it closes)
              <input inputMode="numeric" value={delay} onChange={(e) => setDelay(e.target.value)} />
            </label>
          )}
        </div>
      ) : (
        <p className="muted small">
          Want to charge for early calls? <a href="/subscriptions">Open a subscription</a>.
        </p>
      )}
      <button type="button" disabled={busy || !size} onClick={submit}>
        {busy ? "Placing…" : "Open position and create link"}
      </button>
      {error && <p className="error">{error}</p>}
      {created && (
        <div className="quote">
          <p className="ok">Order sent. Your entry price is recorded from the actual fill.</p>
          <input readOnly value={created.url} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className="ghost"
            onClick={() => navigator.clipboard?.writeText(created.url)}
          >
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}
