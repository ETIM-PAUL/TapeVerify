/** Exact decimal arithmetic on non-negative decimal strings via scaled BigInt. */

export interface Scaled {
  n: bigint;
  scale: number;
}

export function parse(s: string): Scaled {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal: ${s}`);
  const [w = "0", f = ""] = s.split(".");
  return { n: BigInt(w + f), scale: f.length };
}

export function rescale(a: Scaled, scale: number): bigint {
  return a.n * 10n ** BigInt(scale - a.scale);
}

export function format(n: bigint, scale: number): string {
  const digits = n.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale ? digits.slice(-scale).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

const common = (a: Scaled, b: Scaled) => Math.max(a.scale, b.scale);

export const cmp = (a: string, b: string): number => {
  const x = parse(a);
  const y = parse(b);
  const s = common(x, y);
  const l = rescale(x, s);
  const r = rescale(y, s);
  return l < r ? -1 : l > r ? 1 : 0;
};

export function mul(a: string, b: string): string {
  const x = parse(a);
  const y = parse(b);
  return format(x.n * y.n, x.scale + y.scale);
}

/** True if value = anchor + k * step for some integer k >= 0. A zero step means "no grid". */
export function isOnGrid(value: string, anchor: string, step: string): boolean {
  const v = parse(value);
  const a = parse(anchor);
  const st = parse(step);
  const s = Math.max(v.scale, a.scale, st.scale);
  const stepN = rescale(st, s);
  if (stepN === 0n) return true;
  const diff = rescale(v, s) - rescale(a, s);
  return diff >= 0n && diff % stepN === 0n;
}

/** Nearest grid point to `value` (ties round up), clamped to >= anchor. */
export function roundToGrid(value: string, anchor: string, step: string): string {
  const v = parse(value);
  const a = parse(anchor);
  const st = parse(step);
  const s = Math.max(v.scale, a.scale, st.scale);
  const stepN = rescale(st, s);
  const an = rescale(a, s);
  if (stepN === 0n) return format(rescale(v, s), s);
  let diff = rescale(v, s) - an;
  if (diff < 0n) diff = 0n;
  const k = (diff * 2n + stepN) / (stepN * 2n);
  return format(an + k * stepN, s);
}

/** a / b truncated (never rounded up) to `places` decimals. b must be positive. */
export function divFloor(a: string, b: string, places: number): string {
  const x = parse(a);
  const y = parse(b);
  if (y.n === 0n) throw new Error("Division by zero");
  const q = (x.n * 10n ** BigInt(places + y.scale)) / (y.n * 10n ** BigInt(x.scale));
  return format(q, places);
}

/** Largest grid point `anchor + k * step` that is <= value, or null if value < anchor. */
export function floorToGrid(value: string, anchor: string, step: string): string | null {
  const v = parse(value);
  const a = parse(anchor);
  const st = parse(step);
  const s = Math.max(v.scale, a.scale, st.scale);
  const vn = rescale(v, s);
  const an = rescale(a, s);
  const stepN = rescale(st, s);
  if (vn < an) return null;
  if (stepN === 0n) return format(vn, s);
  return format(an + ((vn - an) / stepN) * stepN, s);
}
