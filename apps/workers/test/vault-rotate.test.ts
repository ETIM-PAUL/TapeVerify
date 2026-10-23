import { randomBytes } from "node:crypto";
import { KeyVault, LocalKekProvider, rotateApiWallets } from "@tapeverify/shared";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testPool } from "./helpers.js";

let pool: pg.Pool;
const users: string[] = [];
beforeAll(() => {
  pool = testPool();
});
afterEach(async () => {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users.splice(0)]);
});
afterAll(async () => {
  await pool.end();
});

async function wallet(vault: KeyVault, kekId: string, secret: string) {
  const u = await pool.query(
    "INSERT INTO users (chain, address) VALUES ('solana', $1) RETURNING id",
    [`rot-${crypto.randomUUID()}`],
  );
  users.push(u.rows[0].id);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO api_wallets (id, user_id, network, public_key, sealed_private_key, kek_id, fee_share_bps) VALUES ($1,$2,'testnet',$3,$4,$5,10)",
    [id, u.rows[0].id, `pk-${id}`, JSON.stringify(vault.seal(secret, `api_wallet:${id}`)), kekId],
  );
  return id;
}
const stored = async (id: string) =>
  (await pool.query("SELECT sealed_private_key, kek_id FROM api_wallets WHERE id = $1", [id]))
    .rows[0];

describe("rotating the key-encryption key", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it("re-wraps every stored key under the new KEK, proves each opens, and the secrets are unchanged", async () => {
    const old = new KeyVault(new LocalKekProvider("k1", { k1 }));
    const a = await wallet(old, "k1", "secret-a");
    const b = await wallet(old, "k1", "secret-b");
    const before = (await stored(a)).sealed_private_key.ciphertext;

    const next = new LocalKekProvider("k2", { k1, k2 });
    const r = await rotateApiWallets(pool, next, { only: [a, b] });
    expect(r.failed).toEqual([]);
    expect(r.rewrapped).toBe(2);
    expect(r.byKek).toEqual({ k2: 2 }); // nothing left under the old key: it can be retired

    const after = await stored(a);
    expect(after.kek_id).toBe("k2");
    expect(after.sealed_private_key.kekId).toBe("k2");
    expect(after.sealed_private_key.ciphertext).toBe(before); // the encrypted key itself never changed
    // the old key is retired: the rotated secrets still open
    const retired = new KeyVault(new LocalKekProvider("k2", { k2 }));
    expect(retired.open((await stored(a)).sealed_private_key, `api_wallet:${a}`).reveal()).toBe(
      "secret-a",
    );
    expect(retired.open((await stored(b)).sealed_private_key, `api_wallet:${b}`).reveal()).toBe(
      "secret-b",
    );
  });

  it("a dry run changes nothing, and running twice is harmless", async () => {
    const old = new KeyVault(new LocalKekProvider("k1", { k1 }));
    const id = await wallet(old, "k1", "secret-c");
    const next = new LocalKekProvider("k2", { k1, k2 });
    const dry = await rotateApiWallets(pool, next, { dryRun: true, only: [id] });
    expect(dry.rewrapped).toBe(1);
    expect((await stored(id)).kek_id).toBe("k1");
    await rotateApiWallets(pool, next, { only: [id] });
    const again = await rotateApiWallets(pool, next, { only: [id] });
    expect(again.rewrapped).toBe(0);
    expect((await stored(id)).kek_id).toBe("k2");
  });

  it("reports a secret whose old key was retired too early, instead of damaging it or stopping", async () => {
    const lost = new KeyVault(new LocalKekProvider("k0", { k0: randomBytes(32) }));
    const orphan = await wallet(lost, "k0", "secret-d");
    const good = await wallet(new KeyVault(new LocalKekProvider("k1", { k1 })), "k1", "secret-e");
    const r = await rotateApiWallets(pool, new LocalKekProvider("k2", { k1, k2 }), {
      only: [orphan, good],
    });
    expect(r.failed.map((f) => f.id)).toEqual([orphan]);
    expect(r.failed.find((f) => f.id === orphan)?.kekId).toBe("k0");
    expect((await stored(orphan)).kek_id).toBe("k0"); // left exactly as it was
    expect((await stored(good)).kek_id).toBe("k2"); // and the rest still rotated
  });

  it("refuses to bind a secret to the wrong row", async () => {
    const vault = new KeyVault(new LocalKekProvider("k1", { k1 }));
    const a = await wallet(vault, "k1", "secret-f");
    const b = await wallet(vault, "k1", "secret-g");
    const sealedA = (await stored(a)).sealed_private_key;
    expect(() => vault.open(sealedA, `api_wallet:${b}`)).toThrow(); // copied onto another row: won't open
  });
});
