# TapeVerify

**Social trading where every track record is proven, and followers can't be exploited.**

TapeVerify lets traders post trades as shareable calls and lets anyone copy them with their own money on Strike. Every result is rebuilt from Strike's public fills, signed and anchored on Solana, so a follower can check a trader's record in their own browser instead of trusting a screenshot.

Built for the Strike Hackathon on Strike Finance's Builder Codes API.

- **Live demo (Strike testnet):** https://app-production-252e.up.railway.app
- **Pitch deck:** https://app-production-252e.up.railway.app/deck.html
- **Telegram bot:** [@tapeverify_bot](https://t.me/tapeverify_bot)
- **Repository:** https://github.com/ETIM-PAUL/TapeVerify

## Contents

- [The problem](#the-problem)
- [The solution](#the-solution)
- [How it fits alongside Strike's copy trading](#how-it-fits-alongside-strikes-copy-trading)
- [Features](#features)
- [How it uses Strike](#how-it-uses-strike)
- [How a trade flows through Strike](#how-a-trade-flows-through-strike)
- [Order-book history from Strike L3](#order-book-history-from-strike-l3)
- [Telegram bot](#telegram-bot)
- [How verification works](#how-verification-works)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Try it](#try-it)
- [Testing](#testing)
- [Security](#security)
- [Roadmap](#roadmap)
- [License](#license)

## The problem

Copy trading runs on trust it hasn't earned:

- **Track records can't be checked.** They are screenshots or numbers in a platform's database that can be edited quietly.
- **Leaderboards are gamed.** Wash trades and throwaway accounts inflate volume and win rates.
- **Followers get exploited.** A trader can open a position, wait for followers to pile in, then exit into their buying.
- **Copying is all or nothing.** Most copy trading mirrors every trade, inside a single exchange.

## The solution

TapeVerify replaces "trust us" with a record anyone can verify:

- **Results come from the exchange, not the trader.** Every trade is rebuilt from Strike's public fills and linked to the exact fills behind it.
- **History can't be rewritten.** Records are signed, hash-chained, batched into a Merkle tree and anchored on Solana. Changing one breaks the chain.
- **You check it, not us.** The verifier runs in your browser and queries Solana directly.
- **Abuse is detected.** Wash trading, fake followers, front-running and bad fills are flagged with published thresholds.
- **Copy one trade at a time.** Followers choose which calls to copy, with their own margin and limits.

TapeVerify earns only the builder fee on orders that actually trade, capped at what each user approved.

## How it fits alongside Strike's copy trading

Strike is adding native copy trading of top Hyperliquid traders. TapeVerify does a different job, and the two work side by side:

| | Strike's copy trading | TapeVerify |
|---|---|---|
| Whose trades | Top Hyperliquid traders | Traders and creators on Strike |
| What you copy | Everything the trader does | One call at a time, chosen by the follower |
| Proof of the record | The trader's Hyperliquid stats | Rebuilt from Strike fills, signed, anchored on Solana and checked in your browser |
| Follower protection | Not described | Price-drift limit, personal guardrails, front-running and wash-trade detection |
| Creator earnings | Not described | Builder-fee share on clones, a strategy marketplace and paid subscriptions |

In short: Strike's copy trading brings in proven traders from elsewhere, and TapeVerify proves and protects the traders building their record on Strike.

## Features

| Feature | What it does |
|---|---|
| **Calls** | Open a position on Strike and get a share link with a live preview card for X and Telegram |
| **Copying** | Follow a call with your own margin, a price-drift limit and personal guardrails |
| **Strategy studio** | Describe a strategy in plain English or start from a template, backtest it with Strike's real fees, paper trade it, then run it live |
| **Live trading** | Per-run margin and loss caps, stop-losses that live on Strike, an emergency stop, and no re-sending of an order with an unclear outcome |
| **Verified records** | Signed, hash-chained trader records anchored on Solana, checked in the browser |
| **Trust engine** | Detects wash trading, fake followers, front-running of followers and poor fills, with a reputation penalty and an appeal path |
| **Marketplace** | Strategies with a live record can be listed and cloned into the buyer's own budget, earning the creator a share of the fee |
| **Subscriptions** | Creators sell early access to calls, paid straight to them in USDC on Solana or Ethereum, or in ADA on Cardano |
| **Social** | Feed, leaderboard, comments, notifications, and posting to Telegram and X |
| **Multi-chain onboarding** | Sign in and fund your Strike account from a Solana, Ethereum or Cardano wallet |

## How it uses Strike

| Strike capability | How TapeVerify uses it |
|---|---|
| **Builder connect** | Users approve a builder fee cap from their own wallet. TapeVerify holds a trade-only API wallet that cannot withdraw |
| **Builder fee** | Every call, copy and live-strategy order carries `X-Builder-Fee-Bps`, capped at the lower of the configured fee and what the user approved |
| **Strategy orders** | `/v2/order/strategy` places the entry with its take-profit and stop-loss attached, so exits live on Strike |
| **Public fill history** | The source of truth for every trade, stat and leaderboard rank |
| **Order book and L3 data** | TapeVerify records Strike's L3 feed and keeps the order-book history, so each fill is scored against the book as it was at that moment |
| **Deposits and withdrawals** | Quotes and transactions for Solana, Ethereum and Cardano wallets |
| **Markets, mark prices, klines** | The call form, backtester, live runner and price ticker |
| **Vaults** | The protocol vault powers the "Strike healthy" badge |

Real calls have been opened, filled and closed through TapeVerify on Strike's testnet.

## How a trade flows through Strike

**1. Connecting a user**

1. TapeVerify generates a trade-only API wallet and asks Strike for a challenge (`POST /auth/builder/request-signature`) naming the builder code and the fee cap.
2. The user signs it with their own Solana, Ethereum or Cardano wallet.
3. Strike confirms it (`POST /auth/builder/verify-signature`). TapeVerify checks the approved fee isn't higher than the one shown, then stores the key encrypted.
4. The user funds their Strike account through `/v2/deposit/quote`, `/v2/deposit/build-tx` and `/v2/deposit`.

**2. Posting a call**

1. The form loads the market's limits and mark price from `/v2/markets`.
2. TapeVerify sets the leverage (`POST /v2/leverage`).
3. It places the entry with the take-profit and stop-loss attached (`POST /v2/order/strategy`), with the `X-Builder-Fee-Bps` header.
4. A worker reads the user's orders and fills (`/v2/history/order`, `/v2/history/fill`) and records the real entry price from the fill.

**3. Copying a call**

1. The follower's order goes through the same `/v2/order/strategy` call from their own account, with their own margin.
2. Before sending it, TapeVerify checks the current mark price (from `/v2/markets`) against the caller's entry and blocks the copy if it has drifted too far.

**4. Closing**

1. A reduce-only market order (`POST /v2/order`) closes the position, and the leftover exit orders are cancelled (`DELETE /v2/order/cancel`).
2. The exit price and result are recorded from the closing fills.

**5. Proving the record**

1. Workers stream the order book (`/ws/l3`, `/v2/l3/snapshot`) and prices (`/ws/price`) and backfill candles (`/v2/klines`).
2. Each fill is scored against the order book at that moment.
3. Closed trades are rebuilt from public fills, signed, batched and anchored on Solana.

### Strike endpoints used

| Area | Endpoints |
|---|---|
| Onboarding | `/auth/builder/request-signature`, `/auth/builder/verify-signature`, `/v2/time` |
| Market data | `/v2/markets`, `/v2/markPrice`, `/v2/klines`, `/v2/depth`, `/v2/trades`, `/v2/fee-tiers`, `/v2/l3/snapshot`, `/ws/l3`, `/ws/price` |
| Trading | `/v2/leverage`, `/v2/order/strategy`, `/v2/order`, `/v2/order/cancel`, `/v2/order/cancel-all` |
| Account | `/v2/account`, `/v2/portfolio`, `/v2/positions`, `/v2/sub-accounts`, `/ws/user-api` |
| History | `/v2/history/fill`, `/v2/history/order`, `/v2/history/funding`, `/v2/history/transaction` |
| Funds | `/v2/deposit/quote`, `/v2/deposit/build-tx`, `/v2/deposit`, `/v2/withdraw/quote`, `/v2/withdraw` |
| Vaults | `/v2/vaults` |

## Order-book history from Strike L3

Strike's [L3 feed](https://docs.strikefinance.org/api/l3) shows the public order book order by order: a snapshot (`GET /v2/l3/snapshot`) plus a live stream (`{symbol}@l3` on `/ws/l3`). It only ever shows the book **now**. There is no historical or replay endpoint, so anything not recorded live is gone.

TapeVerify's workers record it continuously and keep the history Strike doesn't:

| Strike's bootstrap rule | What TapeVerify does |
|---|---|
| Subscribe to `/ws/l3`, then buffer updates before fetching the snapshot | Subscribes on connect and buffers from the first message |
| Drop buffered updates at or below `last_sequence`, apply the rest in order | Does exactly that, and also restarts if the snapshot is older than the first buffered update |
| On a sequence gap or a `clear`, stop and bootstrap again | Ends the recorded segment and starts a fresh one. It never guesses through a gap |
| `order_id` is an opaque string, prices and sizes are decimal strings | Stored as given, with exact decimal maths |
| `429` and `503` can happen | Retries the snapshot with backoff, then reconnects |

Recordings are saved as gap-free segments with checkpoints, so the book can be rebuilt at any past moment. That is what lets TapeVerify score a fill against the exact book it traded into, long after the fact.

**What L3 is not:** it is not the Strike Node's full message history. L3 covers visible order-book changes, with a sequence number per market. The node's nonce-ordered log of every order, deposit, withdrawal and liquidation is described in [Strike's docs](https://docs.strikefinance.org/perpetuals/strike-node) but isn't published yet.

## Telegram bot

[@tapeverify_bot](https://t.me/tapeverify_bot) posts calls to Telegram groups, so people can follow a trade in one tap.

| Command | What it does |
|---|---|
| `/link CODE` | Links your Telegram account to TapeVerify. Get the code under Connections in the app |
| `/tape` | In a group, starts posting your calls there (group admins only) |
| `/stop` | Stops posting to that group |
| `/call CODE` | Shows a call in the chat, with a preview card and a Follow button |
| `/help` | Lists the commands |

Each opened or closed call is posted automatically with a live preview card. Posts go through an outbox, so a failed send retries instead of being lost.

## How verification works

```
Strike fills ──► trades (linked to the fills behind them)
                    │
                    ▼
      record  = stats + digest of every closed trade + hash of the previous record
      hash    = sha256("tape-record:" + canonical JSON), signed with Ed25519
                    │
                    ▼
      batch   = Merkle tree over record hashes, chained to the previous batch, signed
                    │
                    ▼
      Solana memo   tape1:<batch id>:<batch hash>
                    │
                    ▼
      Your browser re-checks the hash, signature, Merkle proof and Solana memo
```

Paste a call link, a record hash or a Solana transaction into the Verify page to check it.

## Architecture

```
 Browser (React) ─────────►  API (Fastify) ─────────►  Strike Builder Codes API
   wallet sign-in              auth, calls, follows,       signed orders + fee header
   in-browser verifier         strategies, payments        public fills, markets
        ▲                            │
        │                            ▼
        │                       PostgreSQL ◄──── Workers
        │                            ▲            indexer (order book, candles, fills)
        │                            │            live and paper runners
        └── checks records and       │            trust engine ──► signed batches ──► Solana
            Solana anchors ──────────┘            bots (Telegram, X)
```

**Tech stack:** TypeScript, React, Vite, Fastify, PostgreSQL, Redis, pnpm workspaces, Vitest and Biome.

| Path | Contents |
|---|---|
| `apps/web` | React app and the in-browser verifier |
| `apps/api` | Fastify API |
| `apps/workers` | Indexer, live and paper runners, trust jobs |
| `apps/bots` | Telegram and X bots |
| `packages/strike-sdk` | Typed Strike client: request signing, retries, clock sync, streams |
| `packages/shared` | Config, key vault, strategy engine, trading maths, migrations |
| `packages/verify` | Trust engine and record signing |

## Getting started

### Prerequisites

- Node.js 22 or newer
- pnpm
- Docker, for PostgreSQL and Redis

### Install

```sh
git clone https://github.com/ETIM-PAUL/TapeVerify.git && cd TapeVerify
cp .env.example .env     # set VAULT_KEK_HEX (openssl rand -hex 32) and BUILDER_CODE
pnpm install
pnpm db:up               # start PostgreSQL and Redis
pnpm db:migrate          # create the database tables
```

### Run

Start each service in its own terminal:

```sh
pnpm --filter @tapeverify/api dev     # API on http://localhost:3001
pnpm indexer                          # background workers
pnpm --filter @tapeverify/web dev     # web app on http://localhost:5173
```

Everything runs against Strike's testnet by default. To trade for real, set `STRIKE_NETWORK=mainnet` and `LIVE_ENABLED=true`.

### Configuration

All settings live in `.env`, and [.env.example](.env.example) documents every option. The main ones:

| Variable | Purpose |
|---|---|
| `STRIKE_NETWORK` | `testnet` (default) or `mainnet` |
| `BUILDER_CODE`, `BUILDER_FEE_BPS` | Your Strike builder code and the fee charged |
| `DATABASE_URL`, `REDIS_URL` | PostgreSQL and Redis connections |
| `VAULT_KEK_HEX`, `VAULT_KEK_ID` | Key that encrypts stored API wallets |
| `PUBLIC_WEB_URL`, `PUBLIC_SHARE_URL` | Public addresses used in share links |
| `OPENAI_API_KEY` | Enables plain-English strategy drafting |
| `RECORD_SIGNING_SEED`, `ANCHOR_SOLANA_SEED` | Keys that sign records and anchor them on Solana |
| `TELEGRAM_BOT_TOKEN`, `X_ACCESS_TOKEN` | Optional posting to Telegram and X |
| `SUBSCRIPTIONS_ETH_RPC_URL`, `SUBSCRIPTIONS_KOIOS_URL` | Nodes that check Ethereum and Cardano subscription payments |

## Try it

1. **Connect.** Open the app, connect a Solana, Ethereum or Cardano wallet, and approve the builder fee.
2. **Fund.** Deposit test funds into your Strike account from the Account page.
3. **Post a call.** Pick a market, set size, leverage and exits, review the cost, and confirm. You get a share link.
4. **Copy a call.** Open someone's call link, set your margin and follow it. Close your copy any time.
5. **Verify.** Open a trader's record or a closed call and choose **Verify**. Your browser re-checks it.
6. **Build a strategy.** In the Studio, describe a strategy, backtest it, and start a paper or live run.
7. **Subscribe.** Open a creator's profile and pay for early access on the chain of your choice.

## Testing

```sh
pnpm lint            # formatting and lint rules
pnpm typecheck       # type-check every package
pnpm test            # unit, integration and end-to-end tests
pnpm test:testnet    # tests against the real Strike testnet
pnpm --filter @tapeverify/workers perf    # load tests
```

The suite covers the live runner under failure (an outage with a position open, a rejected close, a restart mid-order), payment verification on all three chains, the record chain and verifier, and a full user journey.

## Security

- **Trade-only keys.** API wallets can place orders but cannot withdraw. Withdrawals always need the user's own wallet signature.
- **Encrypted at rest.** Each API wallet key is encrypted with its own data key (AES-256-GCM), wrapped by a master key, and bound to the wallet it belongs to.
- **Fee ceiling enforced on the server.** A user is never charged more than they approved.
- **Payments never held.** Subscription payments go straight from subscriber to creator. TapeVerify only checks them on-chain.
- **Web hardening.** Origin checks, rate limits on every public route, security headers and bounded sessions.

## Roadmap

- **Fair-execution audit for any Strike account.** Paste a wallet address, account ID or vault ID and check that account's orders against TapeVerify's recorded order book: fills at prices the book allowed, queue priority respected, and every fill accounted for. It uses Strike's bulk history exports (`POST /v2/orders/export` and `/v2/fills/export`, which return an account's complete history as one gzipped JSONL file), so it scales to market makers with hundreds of millions of orders, and it works for any trader, not just TapeVerify users
- An API so other Strike builders can use the trust engine
- Full matching-engine replay verification once Strike publishes the node's nonce-ordered message log
- A mobile app
- Portfolio-level and multi-asset strategies

## Acknowledgements

The request signing, builder-connect, deposit, withdraw and user-stream flows in `packages/strike-sdk` follow Strike's reference implementation, [strike-finance/strike-builder-reference](https://github.com/strike-finance/strike-builder-reference), re-implemented for Node.

## License

Released under the [MIT License](LICENSE).

## Disclaimer

Trading perpetual futures with leverage carries risk. Nothing here is financial advice.
