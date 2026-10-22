# Pit

Pit, protected by Argus: the social trading network for Strike where every record is proven and followers can't be exploited.

Built for the Strike Hackathon on Strike's Builder Codes API.

## Built on Strike

Pit is built on [Strike Finance](https://docs.strikefinance.org)'s Builder Codes API. The request signing, builder-connect, deposit/withdraw and user-stream flows in `packages/strike-sdk` follow Strike's reference implementation, [strike-finance/strike-builder-reference](https://github.com/strike-finance/strike-builder-reference), re-implemented for Node with retries, clock sync, reconnecting streams and an encrypted key vault.

## Layout

- `apps/web` — React app
- `apps/api` — Pit API (auth, wallets, deposits, withdrawals)
- `apps/workers`, `apps/bots` — later phases
- `packages/strike-sdk` — typed Strike client
- `packages/shared` — config and key vault
- `packages/argus` — trust engine (later phase)

## Develop

```sh
cp .env.example .env     # then fill VAULT_KEK_HEX (openssl rand -hex 32)
pnpm install
pnpm db:up && pnpm db:migrate
pnpm test
```
