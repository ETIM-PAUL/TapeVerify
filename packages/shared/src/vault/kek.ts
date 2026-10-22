import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Key-encryption-key provider. Production should implement this over a KMS. */
export interface KekProvider {
  /** Id of the key used for new wraps. */
  readonly currentId: string;
  wrap(dek: Buffer, aad: Buffer): { kekId: string; wrapped: Buffer };
  unwrap(kekId: string, wrapped: Buffer, aad: Buffer): Buffer;
}

/** In-process KEKs (dev/test, or a KEK injected from a secret manager). Supports rotation. */
export class LocalKekProvider implements KekProvider {
  readonly #keys = new Map<string, Buffer>();
  readonly currentId: string;

  constructor(currentId: string, keys: Record<string, Buffer | string>) {
    for (const [id, key] of Object.entries(keys)) {
      const buf = typeof key === "string" ? Buffer.from(key, "hex") : key;
      if (buf.length !== 32) throw new Error(`KEK ${id} must be 32 bytes`);
      this.#keys.set(id, buf);
    }
    if (!this.#keys.has(currentId)) throw new Error(`Current KEK ${currentId} not provided`);
    this.currentId = currentId;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): LocalKekProvider {
    const hex = env.VAULT_KEK_HEX;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("VAULT_KEK_HEX must be 64 hex chars (openssl rand -hex 32)");
    }
    const id = env.VAULT_KEK_ID ?? "dev-1";
    const keys: Record<string, string> = { [id]: hex };
    // Previous KEKs kept for rotation: VAULT_KEK_PREV_<ID>=hex
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("VAULT_KEK_PREV_") && v) keys[k.slice("VAULT_KEK_PREV_".length)] = v;
    }
    return new LocalKekProvider(id, keys);
  }

  wrap(dek: Buffer, aad: Buffer) {
    const kek = this.#key(this.currentId);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", kek, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return { kekId: this.currentId, wrapped: Buffer.concat([iv, ct, c.getAuthTag()]) };
  }

  unwrap(kekId: string, wrapped: Buffer, aad: Buffer): Buffer {
    const kek = this.#key(kekId);
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(wrapped.length - 16);
    const ct = wrapped.subarray(12, wrapped.length - 16);
    const d = createDecipheriv("aes-256-gcm", kek, iv);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }

  #key(id: string): Buffer {
    const k = this.#keys.get(id);
    if (!k) throw new Error(`Unknown KEK ${id}`);
    return k;
  }
}
