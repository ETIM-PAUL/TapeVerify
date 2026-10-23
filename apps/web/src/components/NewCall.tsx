import { useEffect, useMemo, useState } from "react";
import { api, type Call, type MarketInfo } from "../api";
import { usd } from "../format";
import { Modal } from "./Modal";

const decimals = (s: string) => s.split(".")[1]?.length ?? 0;

/** The smallest size that clears both the market's min size and its min order value. */
function minSizeFor(m: MarketInfo): string {
  const mark = Number(m.mark);
  const step = Number(m.stepSize);
  const min = Number(m.minSize);
  if (!(mark > 0) || !(step > 0)) return m.minSize;
  const want = Math.max(min, (Number(m.minNotional) / mark) * 1.02);
  const steps = Math.ceil((want - min) / step - 1e-9);
  return (min + steps * step).toFixed(Math.max(decimals(m.stepSize), decimals(m.minSize)));
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

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
  const [confirming, setConfirming] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [created, setCreated] = useState<Call | null>(null);
  const [copied, setCopied] = useState(false);
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
  useEffect(() => setError(null), [symbol, side, size, leverage, tp, sl]);

  const market = markets.find((m) => m.symbol === symbol);
  const maxLev = market?.maxLeverage ?? 25;
  useEffect(() => {
    if (Number(leverage) > maxLev) setLeverage(String(maxLev));
  }, [maxLev, leverage]);

  const mark = Number(market?.mark) || 0;
  const lev = Math.max(1, Number(leverage) || 1);
  const long = side === "long";
  const notional = useMemo(
    () => (mark > 0 && Number(size) > 0 ? Number(size) * mark : 0),
    [mark, size],
  );
  const margin = notional / lev;
  const dir = long ? 1 : -1;
  // What a take-profit / stop-loss at `price` would be worth, from the current mark.
  const outcome = (price: string) => {
    const p = Number(price);
    if (!(p > 0) || !(notional > 0)) return null;
    const pnl = Number(size) * (p - mark) * dir;
    return {
      pnl,
      onMargin: margin > 0 ? (pnl / margin) * 100 : 0,
      move: ((p - mark) / mark) * 100,
    };
  };
  const tpOut = outcome(tp);
  const slOut = outcome(sl);

  function review() {
    setError(null);
    if (!market) return setError("Pick a market first");
    if (!(Number(size) > 0)) return setError("Enter a size");
    if (notional < Number(market.minNotional))
      return setError(
        `Minimum order value is ${usd(market.minNotional)}. Your order is about ${usd(notional)}. Use "Min" to fill the smallest size.`,
      );
    if (!tp && !sl) return setError("Set a take-profit, a stop-loss, or both");
    if (tp && Number(tp) > 0 && Number(tp) > mark !== long)
      return setError(
        `Take-profit ${tp} must be ${long ? "above" : "below"} the current price ${mark} for a ${side}`,
      );
    if (sl && Number(sl) > 0 && Number(sl) > mark === long)
      return setError(
        `Stop-loss ${sl} must be ${long ? "below" : "above"} the current price ${mark} for a ${side}`,
      );
    setModalError(null);
    setConfirming(true);
  }

  async function submit() {
    setModalError(null);
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
      setCopied(false);
      setRequestKey(crypto.randomUUID()); // a fresh key for the next call
      setSize("");
      setTp("");
      setSl("");
      setConfirming(false);
      onCreated();
    } catch (e) {
      setModalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card newcall">
      <div className="nc-head">
        <h2>New call</h2>
        <p className="muted small">
          Opens a real position on Strike and gives you a link followers can copy.
        </p>
      </div>

      <div className="nc-market">
        <label className="nc-field nc-grow">
          <span>Market</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {markets.map((m) => (
              <option key={m.symbol}>{m.symbol}</option>
            ))}
          </select>
        </label>
        <div className="nc-field">
          <span>Direction</span>
          <div className="seg nc-side">
            <button type="button" className={long ? "on long" : ""} onClick={() => setSide("long")}>
              Long
            </button>
            <button
              type="button"
              className={!long ? "on short" : ""}
              onClick={() => setSide("short")}
            >
              Short
            </button>
          </div>
        </div>
        <div className="nc-mark">
          <span className="muted small">Mark price</span>
          <b>{market ? usd(market.mark) : "—"}</b>
        </div>
      </div>

      <div className="nc-section">
        <h3>Position</h3>
        <div className="nc-grid">
          <label className="nc-field">
            <span>Size</span>
            <div className="nc-input">
              <input
                inputMode="decimal"
                placeholder={market ? `Min ${minSizeFor(market)}` : "0"}
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
              <em>{market?.baseAsset ?? ""}</em>
              {market && (
                <button
                  type="button"
                  className="ghost nc-min"
                  onClick={() => setSize(minSizeFor(market))}
                >
                  Min
                </button>
              )}
            </div>
            <small className="muted">
              {notional > 0
                ? `Position value ${usd(notional)}`
                : `Min order ${usd(market?.minNotional ?? 0)}`}
            </small>
          </label>
          <div className="nc-field">
            <span>
              Leverage <b className="nc-lev">{lev}x</b>
            </span>
            <input
              type="range"
              min={1}
              max={maxLev}
              value={lev}
              aria-label="Leverage"
              onChange={(e) => setLeverage(e.target.value)}
            />
            <div className="nc-chips">
              {[1, 2, 5, 10, 20]
                .filter((n) => n <= maxLev)
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip ${lev === n ? "on" : ""}`}
                    onClick={() => setLeverage(String(n))}
                  >
                    {n}x
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>

      <div className="nc-section">
        <h3>Exits</h3>
        <div className="nc-grid">
          <label className="nc-field">
            <span>Take-profit</span>
            <div className="nc-input">
              <i>$</i>
              <input
                inputMode="decimal"
                placeholder={mark ? (mark * (1 + 0.03 * dir)).toPrecision(5) : "Price"}
                value={tp}
                onChange={(e) => setTp(e.target.value)}
              />
            </div>
            <small className={tpOut ? (tpOut.pnl >= 0 ? "ok" : "error") : "muted"}>
              {tpOut
                ? `${signed(tpOut.pnl)} (${pct(tpOut.onMargin)} on margin)`
                : `Must be ${long ? "above" : "below"} the mark`}
            </small>
          </label>
          <label className="nc-field">
            <span>Stop-loss</span>
            <div className="nc-input">
              <i>$</i>
              <input
                inputMode="decimal"
                placeholder={mark ? (mark * (1 - 0.02 * dir)).toPrecision(5) : "Price"}
                value={sl}
                onChange={(e) => setSl(e.target.value)}
              />
            </div>
            <small className={slOut ? (slOut.pnl >= 0 ? "ok" : "error") : "muted"}>
              {slOut
                ? `${signed(slOut.pnl)} (${pct(slOut.onMargin)} on margin)`
                : `Must be ${long ? "below" : "above"} the mark`}
            </small>
          </label>
        </div>
        <p className="muted small">
          Set at least one. Exits are placed with the order and trigger on the mark price.
        </p>
      </div>

      <div className="nc-section">
        <h3>Followers</h3>
        <div className="nc-grid">
          <div className="nc-field">
            <span>Follow window</span>
            <div className="nc-chips">
              {[15, 30, 60, 240].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${Number(expiry) === n ? "on" : ""}`}
                  onClick={() => setExpiry(String(n))}
                >
                  {n < 60 ? `${n} min` : `${n / 60} h`}
                </button>
              ))}
            </div>
            <div className="nc-input">
              <input
                inputMode="numeric"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
              <em>min</em>
            </div>
            <small className="muted">
              How long people can copy this call. Your position stays open after.
            </small>
          </div>
          <label className="nc-field">
            <span>Max price drift</span>
            <div className="nc-input">
              <input inputMode="numeric" value={drift} onChange={(e) => setDrift(e.target.value)} />
              <em>bps</em>
            </div>
            <small className="muted">
              Followers are blocked once price moves {(Number(drift) / 100 || 0).toFixed(2)}% from
              your entry.
            </small>
          </label>
        </div>
        {hasPlan ? (
          <div className="nc-premium">
            <label className="check">
              <input
                type="checkbox"
                checked={premium}
                onChange={(e) => setPremium(e.target.checked)}
              />
              Subscribers only: hide the trade from everyone else until it closes
            </label>
            {premium && (
              <label className="nc-field">
                <span>Make it public after</span>
                <div className="nc-input">
                  <input
                    inputMode="numeric"
                    value={delay}
                    onChange={(e) => setDelay(e.target.value)}
                  />
                  <em>min</em>
                </div>
                <small className="muted">0 keeps it hidden until it closes.</small>
              </label>
            )}
          </div>
        ) : (
          <p className="muted small">
            Want to charge for early calls? <a href="/subscriptions">Open a subscription</a>.
          </p>
        )}
      </div>

      <div className="nc-summary">
        <div>
          <span className="muted small">Position value</span>
          <b>{usd(notional)}</b>
        </div>
        <div>
          <span className="muted small">Margin you'll put up</span>
          <b className="accent">{usd(margin)}</b>
        </div>
        <div>
          <span className="muted small">Max leverage</span>
          <b>{maxLev}x</b>
        </div>
      </div>

      <button type="button" className="nc-submit" disabled={busy || !size} onClick={review}>
        Review call
      </button>
      {error && <p className="error">{error}</p>}

      {created && (
        <div className="quote nc-created">
          <p className="ok">Order sent. Your entry price is recorded from the actual fill.</p>
          <div className="row">
            <input readOnly value={created.url} onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="ghost"
              onClick={() => {
                navigator.clipboard?.writeText(created.url);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      {confirming && market && (
        <Modal title="Confirm your call" onClose={() => !busy && setConfirming(false)}>
          <div className="nc-confirm">
            <div className="nc-cost">
              <span className="muted small">This call will cost</span>
              <b>{usd(margin)}</b>
              <span className="muted small">
                margin from your Strike balance, for a {usd(notional)} position
              </span>
            </div>
            <dl className="nc-lines">
              <div>
                <dt>Market</dt>
                <dd>
                  <span className={`side ${side}`}>{side}</span> {symbol} · {lev}x
                </dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>
                  {size} {market.baseAsset}
                </dd>
              </div>
              <div>
                <dt>Approx. entry</dt>
                <dd>{usd(market.mark)} (market order)</dd>
              </div>
              {tp && (
                <div>
                  <dt>Take-profit</dt>
                  <dd>
                    {usd(tp)}
                    {tpOut && <span className="ok"> {signed(tpOut.pnl)}</span>}
                  </dd>
                </div>
              )}
              {sl && (
                <div>
                  <dt>Stop-loss</dt>
                  <dd>
                    {usd(sl)}
                    {slOut && <span className="error"> {signed(slOut.pnl)}</span>}
                  </dd>
                </div>
              )}
              <div>
                <dt>Follow window</dt>
                <dd>{expiry} min</dd>
              </div>
              <div>
                <dt>Max drift</dt>
                <dd>{drift} bps</dd>
              </div>
              {premium && (
                <div>
                  <dt>Visibility</dt>
                  <dd>Subscribers only</dd>
                </div>
              )}
            </dl>
            <p className="muted small">
              This opens a real position now. The estimates use the current mark price, so the fill
              and the amounts above can differ slightly, and trading fees apply. Your entry price is
              recorded from the actual fill.
            </p>
            {modalError && <p className="error">{modalError}</p>}
            <div className="row nc-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={submit}>
                {busy ? "Placing order…" : `Confirm and open ${usd(margin)} position`}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
