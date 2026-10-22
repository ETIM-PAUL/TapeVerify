import { createPool } from "@pit/shared";

// Dev seed: fake traders (no keys, no Strike accounts). Idempotent.
const traders = [
  {
    chain: "solana",
    address: "SeedSo1anaTrader1111111111111111111111111111",
    handle: "alpha_wolf",
  },
  {
    chain: "ethereum",
    address: "0x00000000000000000000000000000000000a11ce",
    handle: "bear_whisperer",
  },
  {
    chain: "cardano",
    address: "addr_test1seedcardanotrader000000000000000000000000000000000",
    handle: "ada_ace",
  },
];

const pool = createPool();
try {
  for (const t of traders) {
    await pool.query(
      "INSERT INTO users (chain, address, handle) VALUES ($1, $2, $3) ON CONFLICT (chain, address) DO NOTHING",
      [t.chain, t.address, t.handle],
    );
  }
  console.log(`seeded ${traders.length} users`);
} finally {
  await pool.end();
}
