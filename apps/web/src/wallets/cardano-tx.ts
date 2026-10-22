/**
 * Minimal CBOR walking, just enough to attach a CIP-30 witness set to a transaction without
 * re-encoding the body (re-encoding could change the body bytes and therefore the tx hash).
 * A Cardano tx is the array [body, witness_set, is_valid, auxiliary_data].
 */

const hexToBytes = (hex: string) => {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

interface Head {
  major: number;
  /** Argument value, or -1 for an indefinite length. */
  arg: number;
  /** Offset of the first byte after the head. */
  next: number;
}

function readHead(b: Uint8Array, at: number): Head {
  const first = b[at];
  if (first === undefined) throw new Error("CBOR: unexpected end");
  const major = first >> 5;
  const info = first & 31;
  if (info < 24) return { major, arg: info, next: at + 1 };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (width === 0) {
    if (info === 31) return { major, arg: -1, next: at + 1 };
    throw new Error("CBOR: reserved additional info");
  }
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 256 + (b[at + 1 + i] ?? 0);
  return { major, arg: v, next: at + 1 + width };
}

/** Offset just past the CBOR item starting at `at`. */
export function itemEnd(b: Uint8Array, at: number): number {
  const h = readHead(b, at);
  switch (h.major) {
    case 0:
    case 1:
    case 7:
      return h.next;
    case 2:
    case 3: {
      if (h.arg >= 0) return h.next + h.arg;
      let p = h.next; // indefinite string: chunks until break (0xff)
      while (b[p] !== 0xff) p = itemEnd(b, p);
      return p + 1;
    }
    case 4:
    case 5: {
      let p = h.next;
      const per = h.major === 5 ? 2 : 1;
      if (h.arg >= 0) {
        for (let i = 0; i < h.arg * per; i++) p = itemEnd(b, p);
        return p;
      }
      while (b[p] !== 0xff) for (let i = 0; i < per; i++) p = itemEnd(b, p);
      return p + 1;
    }
    case 6:
      return itemEnd(b, h.next);
    default:
      throw new Error("CBOR: unsupported item");
  }
}

/** True if the wallet returned a whole transaction (array) rather than a witness set (map). */
export const isFullTx = (hex: string) => (hexToBytes(hex)[0] ?? 0) >> 5 === 4;

/**
 * Returns the transaction with its witness set replaced by the wallet's. Only supports an empty
 * original witness set, which is what a Strike-built payment transaction carries.
 */
export function attachWitnessSet(txHex: string, witnessHex: string): string {
  if (isFullTx(witnessHex)) return witnessHex.replace(/^0x/i, "");
  const tx = hexToBytes(txHex);
  const wit = hexToBytes(witnessHex);
  if ((wit[0] ?? 0) >> 5 !== 5)
    throw new Error("Wallet returned neither a transaction nor a witness set");

  const top = readHead(tx, 0);
  if (top.major !== 4 || top.arg < 2) throw new Error("Not a Cardano transaction");
  const bodyEnd = itemEnd(tx, top.next);
  const witEnd = itemEnd(tx, bodyEnd);
  const original = tx.subarray(bodyEnd, witEnd);
  if (!(original.length === 1 && original[0] === 0xa0)) {
    throw new Error("Transaction already has witnesses; merging is not supported");
  }
  const out = new Uint8Array(bodyEnd + wit.length + (tx.length - witEnd));
  out.set(tx.subarray(0, bodyEnd), 0);
  out.set(wit, bodyEnd);
  out.set(tx.subarray(witEnd), bodyEnd + wit.length);
  return bytesToHex(out);
}
