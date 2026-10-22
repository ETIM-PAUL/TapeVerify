/** Canonical form of a positive decimal string: "117500.00" -> "117500", "72247.30" -> "72247.3". */
export function normalizeDecimal(s: string): string {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal: ${s}`);
  const [whole = "0", frac = ""] = s.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

/** Exact sum of decimal strings (no floating point). */
export function sumDecimals(values: string[]): string {
  const decimals = Math.max(0, ...values.map((v) => v.split(".")[1]?.length ?? 0));
  let total = 0n;
  for (const v of values) {
    const [w = "0", f = ""] = v.split(".");
    total += BigInt(w + f.padEnd(decimals, "0"));
  }
  const digits = total.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals ? digits.slice(-decimals) : "";
  return normalizeDecimal(frac ? `${whole}.${frac}` : whole);
}

/** Numeric compare of two non-negative decimal strings. */
export function compareDecimals(a: string, b: string): number {
  const [aw = "0", af = ""] = a.split(".");
  const [bw = "0", bf = ""] = b.split(".");
  const n = Math.max(af.length, bf.length);
  const x = BigInt(aw + af.padEnd(n, "0"));
  const y = BigInt(bw + bf.padEnd(n, "0"));
  return x < y ? -1 : x > y ? 1 : 0;
}
