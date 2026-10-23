import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type Chain,
  type MyPlan,
  type MySubscription,
  type PlanInfo,
  type SubIntent,
} from "../api";
import { usd } from "../format";

const CHAIN_NAME: Record<Chain, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  cardano: "Cardano",
};
const CHAIN_ASSET: Record<Chain, string> = { solana: "USDC", ethereum: "USDC", cardano: "ADA" };

const networkLabel = (chain: Chain, network: string) => {
  const main = network === "mainnet";
  return chain === "solana"
    ? main
      ? "mainnet"
      : "devnet"
    : chain === "ethereum"
      ? main
        ? "mainnet"
        : "Sepolia"
      : main
        ? "mainnet"
        : "preprod";
};

const day = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ghost"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** Subscribe to a creator: pick a chain they accept, pay from any wallet on it, then paste the transaction ID. */
export function SubscribeCard({
  creator,
  signedIn,
  compact = false,
  onChange,
}: {
  creator: string;
  signedIn: boolean;
  compact?: boolean;
  onChange?: () => void;
}) {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const [intent, setIntent] = useState<SubIntent | null>(null);
  const [sig, setSig] = useState("");
  const [picked, setPicked] = useState<Chain | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<PlanInfo>(`/v1/creators/${creator}/plan`)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [creator]);
  useEffect(load, [load]);

  if (!info?.plan || info.viewer?.isSelf) return null;
  const { plan } = info;
  const active = info.viewer?.subscribed;
  const chains = plan.chains?.length ? plan.chains : (["solana"] as Chain[]);
  // Default to the chain the person signed in with, when the creator accepts it.
  const viewerChain = info.viewer?.chain;
  const chain: Chain =
    picked && chains.includes(picked)
      ? picked
      : viewerChain && chains.includes(viewerChain)
        ? viewerChain
        : (chains[0] as Chain);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      setIntent(await api.post<SubIntent>(`/v1/creators/${creator}/subscribe`, { chain }));
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 401 ? "Sign in to subscribe." : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!intent) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/v1/subscriptions/payments/${intent.paymentId}/confirm`, {
        signature: sig.trim(),
      });
      setIntent(null);
      setSig("");
      load();
      onChange?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "subbox" : "card stack"}>
      <div className="row spread">
        <div>
          <h2>{active ? "You're subscribed" : `Subscribe to ${info.creator.name}`}</h2>
          <p className="muted small">
            {active && info.viewer?.endsAt
              ? `Active until ${day(info.viewer.endsAt)}. Renew any time and the days add on.`
              : "See their subscribers-only calls the moment they're posted, and copy them."}
          </p>
        </div>
        <div className="price">
          <b>{usd(plan.priceUsdc)}</b>
          <span className="muted small"> / {plan.periodDays} days</span>
        </div>
      </div>
      {!intent && (
        <div className="stack">
          {chains.length > 1 && (
            <div className="chips" role="group" aria-label="Pay on">
              {chains.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip ${c === chain ? "on" : ""}`}
                  aria-pressed={c === chain}
                  onClick={() => setPicked(c)}
                >
                  Pay on {CHAIN_NAME[c]} ({CHAIN_ASSET[c]})
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <button type="button" disabled={busy} onClick={start}>
              {active ? "Renew" : "Subscribe"}
            </button>
            <span className="muted small">
              {info.subscribers} subscriber{info.subscribers === 1 ? "" : "s"} · paid in{" "}
              {CHAIN_ASSET[chain]} on {CHAIN_NAME[chain]}, straight to the creator
            </span>
          </div>
        </div>
      )}
      {intent && (
        <div className="stack">
          <ol className="warnlist">
            <li>
              Send {intent.pay.exact ? <b>exactly </b> : null}
              <b>
                {intent.pay.amount} {intent.pay.asset}
              </b>{" "}
              on {CHAIN_NAME[intent.pay.chain]} (
              {networkLabel(intent.pay.chain, intent.pay.network)}) to:
              <div className="row mono">
                <code>{intent.pay.address}</code>
                <Copy text={intent.pay.address} label="address" />
                {intent.pay.exact && <Copy text={intent.pay.amount} label="amount" />}
              </div>
              {intent.pay.exact && (
                <span className="muted small">
                  The last digits are a tag that matches the payment to you. Don't round the amount.
                  {intent.pay.asset === "ADA" &&
                    ` That is ${usd(intent.pay.amountUsdc)} at today's ADA price.`}
                </span>
              )}
            </li>
            {intent.pay.memo && (
              <li>
                Add this memo so we can match the payment to you:
                <div className="row mono">
                  <code>{intent.pay.memo}</code>
                  <Copy text={intent.pay.memo} label="memo" />
                </div>
              </li>
            )}
            <li>
              Paste the transaction {intent.pay.chain === "solana" ? "signature" : "ID"} here. We
              check it on the chain; TapeVerify never holds your payment.
            </li>
          </ol>
          <div className="row">
            <input
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              placeholder={
                intent.pay.chain === "solana" ? "Transaction signature" : "Transaction hash"
              }
              spellCheck={false}
              aria-label="Transaction ID"
            />
            <button type="button" disabled={busy || sig.trim().length < 64} onClick={confirm}>
              {busy ? "Checking…" : "I've paid"}
            </button>
            <button type="button" className="ghost" onClick={() => setIntent(null)}>
              Cancel
            </button>
          </div>
          {intent.pay.network !== "mainnet" && (
            <p className="warn small">
              Test payment: this is {networkLabel(intent.pay.chain, intent.pay.network)}, so use
              test funds, not real money.{" "}
              {intent.pay.chain === "cardano" ? (
                <a
                  href="https://developers.cardano.org/docs/integrate-cardano/testnet-faucet"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get test ADA
                </a>
              ) : (
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                  Get test USDC
                </a>
              )}
              .
            </p>
          )}
          <p className="muted small">
            Not showing up yet? Give the network a minute and try again. This payment is good for an
            hour.
          </p>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {!signedIn && <p className="muted small">You'll need to sign in first.</p>}
    </div>
  );
}

/** The creator's side: set a price, see who has subscribed and what has been paid. */
function PlanEditor() {
  const [data, setData] = useState<MyPlan | null>(null);
  const [price, setPrice] = useState("10");
  const [days, setDays] = useState("30");
  const [address, setAddress] = useState("");
  const [ethAddress, setEthAddress] = useState("");
  const [adaAddress, setAdaAddress] = useState("");
  const [active, setActive] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<MyPlan>("/v1/me/plan")
      .then((r) => {
        setData(r);
        if (r.plan) {
          setPrice(r.plan.priceUsdc);
          setDays(String(r.plan.periodDays));
          setAddress(r.plan.payAddress ?? "");
          setEthAddress(r.plan.ethAddress ?? "");
          setAdaAddress(r.plan.adaAddress ?? "");
          setActive(r.plan.active);
        }
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);

  async function save() {
    setErr(null);
    setMsg(null);
    try {
      await api.put("/v1/me/plan", {
        priceUsdc: Number(price),
        periodDays: Number(days),
        payAddress: address.trim() || null,
        ethAddress: ethAddress.trim() || null,
        adaAddress: adaAddress.trim() || null,
        active,
      });
      setMsg("Saved.");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!data) return err ? <p className="error">{err}</p> : null;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Your subscription</h2>
        <p className="muted small">
          Subscribers pay you directly, in USDC on Solana or Ethereum or in ADA on Cardano: add an
          address for each chain you want to accept. ADA is priced from the current ADA-USD price.
          TapeVerify never holds the money and takes no cut. Subscribers see your subscribers-only
          calls while they're open; every call becomes public, with its result, once it closes.
        </p>
        <div className="formgrid">
          <label>
            Price (USDC)
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label>
            Length (days)
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        </div>
        <label>
          Solana address (USDC)
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="A Solana wallet you control"
            spellCheck={false}
          />
        </label>
        <label>
          Ethereum address (USDC)
          <input
            value={ethAddress}
            onChange={(e) => setEthAddress(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <label>
          Cardano address (ADA)
          <input
            value={adaAddress}
            onChange={(e) => setAdaAddress(e.target.value)}
            placeholder="addr1… (addr_test1… on testnet)"
            spellCheck={false}
          />
        </label>
        <p className="muted small">
          Leave a chain empty to not accept payment on it. Add at least one.
        </p>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Open for new subscribers
        </label>
        <div className="row">
          <button type="button" onClick={save}>
            Save plan
          </button>
        </div>
        {msg && <p className="ok">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      <div className="stats">
        <div className="stat">
          <span className="muted">Active subscribers</span>
          <b>{data.activeSubscribers}</b>
        </div>
        <div className="stat">
          <span className="muted">Received</span>
          <b>{usd(data.revenueUsdc)}</b>
        </div>
        <div className="stat">
          <span className="muted">Payments</span>
          <b>{data.payments}</b>
        </div>
      </div>

      {data.subscribers.length > 0 && (
        <div className="card">
          <h2>Subscribers</h2>
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Until</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.subscribers.map((s) => (
                <tr key={`${s.name}-${s.endsAt}`}>
                  <td>{s.name}</td>
                  <td>{day(s.endsAt)}</td>
                  <td className={s.active ? "pos" : "muted"}>{s.active ? "active" : "ended"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.recent.length > 0 && (
        <div className="card">
          <h2>Recent payments</h2>
          <table>
            <tbody>
              {data.recent.map((p) => (
                <tr key={p.signature}>
                  <td>{p.name}</td>
                  <td>{usd(p.amountUsdc)}</td>
                  <td className="muted small">{new Date(p.at).toLocaleString()}</td>
                  <td>
                    <a
                      className="small"
                      href={`/verify?q=${p.signature}`}
                      title="Look this transaction up"
                    >
                      {p.signature.slice(0, 8)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Subscriptions() {
  const [subs, setSubs] = useState<MySubscription[] | null>(null);
  useEffect(() => {
    api
      .get<{ subscriptions: MySubscription[] }>("/v1/me/subscriptions")
      .then((r) => setSubs(r.subscriptions))
      .catch(() => setSubs([]));
  }, []);
  return (
    <div className="stack narrow-page">
      <h1>Subscriptions</h1>
      <div className="card">
        <h2>Creators you subscribe to</h2>
        {subs?.length === 0 && (
          <p className="muted">
            None yet. Open a trader's profile to see whether they offer a subscription.
          </p>
        )}
        <ul className="penalties">
          {subs?.map((s) => (
            <li key={s.ref}>
              <a href={`/t/${s.ref}`}>{s.name}</a>{" "}
              <span className={s.active ? "pos small" : "muted small"}>
                {s.active ? `active until ${day(s.endsAt)}` : `ended ${day(s.endsAt)}`}
              </span>
              {s.active && s.premiumOpen > 0 && (
                <span className="muted small">
                  {" "}
                  · {s.premiumOpen} subscribers-only call{s.premiumOpen === 1 ? "" : "s"} open
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <PlanEditor />
    </div>
  );
}
