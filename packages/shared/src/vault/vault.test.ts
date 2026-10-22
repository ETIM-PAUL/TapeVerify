import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { KeyVault, LocalKekProvider, Secret } from "./index.js";

const kek = (id: string) => ({ [id]: randomBytes(32) });

describe("KeyVault", () => {
  it("round-trips a secret", () => {
    const vault = new KeyVault(new LocalKekProvider("k1", kek("k1")));
    const sealed = vault.seal("deadbeef".repeat(8), "api_wallet:1");
    expect(JSON.stringify(sealed)).not.toContain("deadbeef");
    expect(vault.open(sealed, "api_wallet:1").reveal()).toBe("deadbeef".repeat(8));
  });

  it("binds ciphertext to its context", () => {
    const vault = new KeyVault(new LocalKekProvider("k1", kek("k1")));
    const sealed = vault.seal("secret", "api_wallet:1");
    expect(() => vault.open(sealed, "api_wallet:2")).toThrow();
  });

  it("detects tampering", () => {
    const vault = new KeyVault(new LocalKekProvider("k1", kek("k1")));
    const sealed = vault.seal("secret", "ctx");
    const ct = Buffer.from(sealed.ciphertext, "base64");
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => vault.open({ ...sealed, ciphertext: ct.toString("base64") }, "ctx")).toThrow();
  });

  it("rotates KEKs without changing ciphertext", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const old = new KeyVault(new LocalKekProvider("k1", { k1 }));
    const sealed = old.seal("secret", "ctx");

    const rotated = new KeyVault(new LocalKekProvider("k2", { k1, k2 }));
    const re = rotated.rewrap(sealed, "ctx");
    expect(re.kekId).toBe("k2");
    expect(re.ciphertext).toBe(sealed.ciphertext);
    expect(rotated.open(re, "ctx").reveal()).toBe("secret");

    // after retiring k1, old sealed values no longer open but rewrapped ones do
    const retired = new KeyVault(new LocalKekProvider("k2", { k2 }));
    expect(() => retired.open(sealed, "ctx")).toThrow();
    expect(retired.open(re, "ctx").reveal()).toBe("secret");
  });

  it("never leaks a Secret via JSON, string or inspect", () => {
    const s = new Secret("hunter2");
    expect(JSON.stringify({ s })).not.toContain("hunter2");
    expect(`${s}`).not.toContain("hunter2");
    expect(inspect(s)).not.toContain("hunter2");
  });
});
