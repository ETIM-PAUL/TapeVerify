# TapeVerify

The social trading network for Strike where every record is proven and followers can't be exploited.

Traders publish calls and run strategies on [Strike Finance](https://docs.strikefinance.org). Every closed trade becomes a signed record, chained into batches whose hash is anchored on Solana, so anyone can check a track record without trusting TapeVerify. Followers copy calls and strategies with guardrails, and the builder fee on each order is the product's revenue.

## Built on Strike

TapeVerify is built on Strike's Builder Codes API. The request signing, builder-connect, deposit/withdraw and user-stream flows in `packages/strike-sdk` follow Strike's reference implementation, [strike-finance/strike-builder-reference](https://github.com/strike-finance/strike-builder-reference), re-implemented for Node with retries, clock sync, reconnecting streams and an encrypted key vault.

## What's in it

- **Calls and copying**: publish a call with a share link, followers copy it with their own margin, a drift limit and guardrails.
- **Strategies**: templates or plain English to a validated spec, backtests on Strike's fees, paper trading, and live trading behind strict safety rules.
- **Verify**: front-running, self/wash-trading and sybil detectors; reputation and clean record; fair-fill scores; signed, chained, Solana-anchored batches; a public verifier that re-checks a record in the browser.
- **Marketplace and creators**: list verified strategies, creator subscriptions paid in USDC, premium calls.
- **Social**: Telegram bot and X posting driven by an outbox.

## Layout

- `apps/web`: React app
- `apps/api`: Fastify API (auth, wallets, calls, follows, strategies, verify, subscriptions)
- `apps/workers`: indexer, live and paper runners, trust engine jobs, CLIs
- `apps/bots`: Telegram and X
- `packages/strike-sdk`: typed Strike client
- `packages/shared`: config, key vault, strategy engine, trading maths
- `packages/verify`: trust engine

## Develop

```sh
cp .env.example .env     # then set VAULT_KEK_HEX (openssl rand -hex 32)
pnpm install
pnpm db:up && pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test
```

Run the pieces (each in its own terminal): `pnpm --filter @tapeverify/api dev`, `pnpm indexer`, `pnpm --filter @tapeverify/web dev`.

Useful commands:

| Command                                                         | What it does                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm --filter @tapeverify/workers perf`                        | load tests (see `docs/LOAD.md`)                                 |
| `pnpm --filter @tapeverify/workers vault:rotate [-- --dry-run]` | re-wrap stored wallet keys under the current key                |
| `pnpm --filter @tapeverify/workers emergency`                   | stop every live run                                             |
| `pnpm test:testnet`                                             | checks against the real Strike testnet (needs a funded account) |

Configuration is in `.env.example`. Never commit `.env`: it holds the vault key, signing seeds and bot tokens.

## Docs

`docs/` holds the architecture, Strike integration notes, trust-engine methodology, security review, risk disclaimers, load results and testing guide.

## Risk

Trading perpetual futures with leverage can lose all of the margin put into a position. Nothing here is financial advice. Verified records prove what happened; they don't predict what will.
