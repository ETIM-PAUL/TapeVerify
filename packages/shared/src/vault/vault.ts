import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KekProvider } from "./kek.js";
import { Secret } from "./secret.js";

/** Storable form: all fields base64, safe to persist in Postgres. */
export interface SealedSecret {
  v: 1;
  kekId: string;
  wrappedDek: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

/**
 * Envelope encryption: each secret gets its own random DEK (AES-256-GCM); the DEK is wrapped by
 * a KEK. `context` (e.g. `api_wallet:<id>`) is bound as AAD, so a sealed value copied onto another
 * row fails to decrypt. Rotation re-wraps DEKs without touching ciphertext.
 */
export class KeyVault {
  constructor(private readonly kek: KekProvider) {}

  seal(plaintext: Secret | string, context: string): SealedSecret {
    const value = typeof plaintext === "string" ? plaintext : plaintext.reveal();
    const aad = Buffer.from(context, "utf8");
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    try {
      const c = createCipheriv("aes-256-gcm", dek, iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
      const { kekId, wrapped } = this.kek.wrap(dek, aad);
      return {
        v: 1,
        kekId,
        wrappedDek: wrapped.toString("base64"),
        iv: iv.toString("base64"),
        ciphertext: ct.toString("base64"),
        tag: c.getAuthTag().toString("base64"),
      };
    } finally {
      dek.fill(0);
    }
  }

  open(sealed: SealedSecret, context: string): Secret {
    const aad = Buffer.from(context, "utf8");
    const dek = this.kek.unwrap(sealed.kekId, Buffer.from(sealed.wrappedDek, "base64"), aad);
    try {
      const d = createDecipheriv("aes-256-gcm", dek, Buffer.from(sealed.iv, "base64"));
      d.setAAD(aad);
      d.setAuthTag(Buffer.from(sealed.tag, "base64"));
      const pt = Buffer.concat([d.update(Buffer.from(sealed.ciphertext, "base64")), d.final()]);
      return new Secret(pt.toString("utf8"));
    } finally {
      dek.fill(0);
    }
  }

  /** Re-wrap the DEK under the current KEK (key rotation). Ciphertext is unchanged. */
  rewrap(sealed: SealedSecret, context: string): SealedSecret {
    if (sealed.kekId === this.kek.currentId) return sealed;
    const aad = Buffer.from(context, "utf8");
    const dek = this.kek.unwrap(sealed.kekId, Buffer.from(sealed.wrappedDek, "base64"), aad);
    try {
      const { kekId, wrapped } = this.kek.wrap(dek, aad);
      return { ...sealed, kekId, wrappedDek: wrapped.toString("base64") };
    } finally {
      dek.fill(0);
    }
  }
}
