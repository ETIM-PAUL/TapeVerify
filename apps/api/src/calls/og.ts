import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);
const FONTS = [
  require.resolve("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
  require.resolve("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
];

export interface OgData {
  symbol: string;
  side: "long" | "short";
  leverage: number;
  status: "pending" | "open" | "expired" | "closed" | "failed";
  trader: string;
  entry: string | null;
  /** Current mark while live, exit price once closed. */
  now: string | null;
  nowLabel: string;
  tp: string | null;
  sl: string | null;
  /** Leveraged % move (live) or realized result (closed), if known. */
  resultPct: number | null;
  footer: string;
  /** A premium call that is still locked: the card says so and shows nothing about the trade. */
  locked?: boolean;
}

export const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function price(v: string | null): string {
  if (v === null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 2 : n >= 1 ? 3 : 5;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
}

const STATUS_LABEL: Record<OgData["status"], string> = {
  pending: "WAITING FOR FILL",
  open: "OPEN",
  expired: "FOLLOW WINDOW OVER",
  closed: "CLOSED",
  failed: "FAILED",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const LOGO = `<g transform="translate(72 58) scale(1.5)">
    <rect width="32" height="32" rx="8" fill="#f5a524"/>
    <rect x="6.5" y="7" width="13" height="2.6" rx="1.3" fill="#1a1100" opacity="0.5"/>
    <rect x="6.5" y="12" width="8" height="2.6" rx="1.3" fill="#1a1100" opacity="0.5"/>
    <path d="M8 21.5 13.2 26 25.5 11.5" fill="none" stroke="#1a1100" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;

/** The card for a premium call nobody has subscribed for: who posted it, and that it is subscribers-only. */
function lockedSvg(d: OgData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter">
  <rect width="1200" height="630" fill="#0b0d10"/>
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="#14181d" stroke="#232a32" stroke-width="2"/>
  ${LOGO}
  <text x="134" y="98" font-size="34" font-weight="700" fill="#e8ecf1">Tape<tspan font-weight="500" fill="#8b96a3">Verify</tspan></text>
  <text x="72" y="270" font-size="84" font-weight="700" fill="#e8ecf1">Premium call</text>
  <text x="72" y="350" font-size="40" fill="#8b96a3">${xmlEscape(clip(d.trader, 28))} posted a trade for subscribers.</text>
  <rect x="72" y="410" width="520" height="72" rx="36" fill="#f5a524"/>
  <text x="332" y="458" font-size="32" font-weight="700" fill="#1a1100" text-anchor="middle">Subscribe to see it</text>
  <line x1="72" y1="520" x2="1128" y2="520" stroke="#232a32" stroke-width="2"/>
  <text x="72" y="572" font-size="24" fill="#8b96a3">Becomes public with its result once it closes</text>
</svg>`;
}

export function ogSvg(d: OgData): string {
  if (d.locked) return lockedSvg(d);
  const long = d.side === "long";
  const sideColor = long ? "#3ecf8e" : "#ff6b6b";
  const result =
    d.resultPct === null ? "" : `${d.resultPct >= 0 ? "+" : ""}${d.resultPct.toFixed(2)}%`;
  const resultColor = d.resultPct === null ? "#8b96a3" : d.resultPct >= 0 ? "#3ecf8e" : "#ff6b6b";
  const stat = (x: number, label: string, value: string, color = "#e8ecf1") =>
    `<text x="${x}" y="420" font-size="24" fill="#8b96a3">${xmlEscape(label)}</text>` +
    `<text x="${x}" y="468" font-size="44" font-weight="700" fill="${color}">${xmlEscape(value)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter">
  <rect width="1200" height="630" fill="#0b0d10"/>
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="#14181d" stroke="#232a32" stroke-width="2"/>
  <g transform="translate(72 58) scale(1.5)">
    <rect width="32" height="32" rx="8" fill="#f5a524"/>
    <rect x="6.5" y="7" width="13" height="2.6" rx="1.3" fill="#1a1100" opacity="0.5"/>
    <rect x="6.5" y="12" width="8" height="2.6" rx="1.3" fill="#1a1100" opacity="0.5"/>
    <path d="M8 21.5 13.2 26 25.5 11.5" fill="none" stroke="#1a1100" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="134" y="98" font-size="34" font-weight="700" fill="#e8ecf1">Tape<tspan font-weight="500" fill="#8b96a3">Verify</tspan></text>
  <text x="344" y="97" font-size="22" fill="#8b96a3">verified from Strike fills</text>
  <rect x="${1128 - 360}" y="62" width="360" height="48" rx="24" fill="#1b2128"/>
  <text x="${1128 - 180}" y="95" font-size="22" font-weight="700" fill="#e8ecf1" text-anchor="middle">${xmlEscape(STATUS_LABEL[d.status])}</text>
  <text x="72" y="236" font-size="96" font-weight="700" fill="#e8ecf1">${xmlEscape(d.symbol)}</text>
  <rect x="72" y="262" width="${long ? 150 : 170}" height="56" rx="14" fill="${sideColor}"/>
  <text x="${72 + (long ? 75 : 85)}" y="302" font-size="32" font-weight="700" fill="#0b0d10" text-anchor="middle">${long ? "LONG" : "SHORT"}</text>
  <text x="${long ? 246 : 266}" y="302" font-size="36" font-weight="700" fill="#e8ecf1">${d.leverage}x</text>
  <text x="1128" y="236" font-size="96" font-weight="700" fill="${resultColor}" text-anchor="end">${xmlEscape(result)}</text>
  ${stat(72, "ENTRY", price(d.entry))}
  ${stat(380, d.nowLabel.toUpperCase(), price(d.now))}
  ${stat(688, "TAKE-PROFIT", price(d.tp), "#3ecf8e")}
  ${stat(930, "STOP-LOSS", price(d.sl), "#ff6b6b")}
  <line x1="72" y1="520" x2="1128" y2="520" stroke="#232a32" stroke-width="2"/>
  <text x="72" y="572" font-size="26" fill="#e8ecf1">${xmlEscape(clip(d.trader, 36))}</text>
  <text x="1128" y="572" font-size="24" fill="#8b96a3" text-anchor="end">${xmlEscape(clip(d.footer, 48))}</text>
</svg>`;
}

/** 1200x630 PNG: the size X, Telegram and Discord use for large link previews. */
export function ogPng(d: OgData): Buffer {
  const r = new Resvg(ogSvg(d), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: 1200 },
  });
  return r.render().asPng();
}

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
