import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { type CallRow, callWithTrader, publicCall, type Trader } from "../calls/model.js";
import { OG_HEIGHT, OG_WIDTH, type OgData, ogPng, price, xmlEscape } from "../calls/og.js";
import { lockedNow } from "../lock.js";

const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const CODE = z.string().regex(/^[A-Za-z0-9]{4,16}$/);

export function ogData(row: CallRow & Trader, mark: string | null, now = Date.now()): OgData {
  const closed = row.status === "closed" && row.exit_price;
  // Only a finished trade gets a headline result: link previews are cached by X and Telegram, so a
  // live PnL frozen at crawl time would be a stale claim.
  let resultPct: number | null = null;
  if (closed && row.entry_price) {
    const dir = row.side === "long" ? 1 : -1;
    resultPct =
      ((Number(row.exit_price) - Number(row.entry_price)) / Number(row.entry_price)) *
      100 *
      dir *
      row.leverage;
  }
  const footer =
    row.status === "pending"
      ? "Waiting for the fill"
      : row.status === "failed"
        ? "Order not filled"
        : row.status === "closed"
          ? `Closed${row.exit_reason ? ` · ${row.exit_reason.toUpperCase()}` : ""}`
          : Date.now() >= Number(row.expires_at) || row.status === "expired"
            ? "Follow window over"
            : `Follow until ${new Date(Number(row.expires_at)).toISOString().slice(11, 16)} UTC`;
  return {
    symbol: row.symbol,
    side: row.side,
    leverage: row.leverage,
    status: row.status === "open" && now >= Number(row.expires_at) ? "expired" : row.status,
    trader: row.handle ?? shortAddr(row.address),
    entry: row.entry_price,
    now: closed ? row.exit_price : mark,
    nowLabel: closed ? "Exit" : "Price now",
    tp: row.tp_price,
    sl: row.sl_price,
    resultPct,
    footer,
  };
}

export const escapeHtml = xmlEscape;

export function shareHtml(opts: {
  title: string;
  description: string;
  shareUrl: string;
  imageUrl: string;
  webUrl: string;
}) {
  const t = escapeHtml(opts.title);
  const dsc = escapeHtml(opts.description);
  const img = escapeHtml(opts.imageUrl);
  const share = escapeHtml(opts.shareUrl);
  const web = escapeHtml(opts.webUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${dsc}">
<link rel="canonical" href="${share}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="TapeVerify">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${dsc}">
<meta property="og:url" content="${share}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="${OG_WIDTH}">
<meta property="og:image:height" content="${OG_HEIGHT}">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${dsc}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0; url=${web}">
</head><body><p><a href="${web}">Open this call on TapeVerify</a></p>
<script>location.replace(${JSON.stringify(opts.webUrl).replace(/</g, "\\u003c")})</script>
</body></html>`;
}

export function shareRoutes(app: FastifyInstance, d: AppDeps) {
  const cache = new Map<string, { at: number; png: Buffer }>();
  const base = d.api.publicShareUrl.replace(/\/$/, "");
  const web = d.api.publicWebUrl.replace(/\/$/, "");

  async function markFor(symbol: string): Promise<string | null> {
    try {
      return (await d.gateway.marketRules())[symbol]?.mark_price ?? null;
    } catch {
      return null; // a card without a live price is better than no card
    }
  }

  // Server-rendered preview card (what X, Telegram and Discord fetch for the link).
  app.get(
    "/og/:file",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const m = /^([A-Za-z0-9]{4,16})\.png$/.exec((req.params as { file: string }).file);
      if (!m) return reply.code(404).send({ error: "Not found" });
      const [row] = await callWithTrader(d.pool, "c.short_code = $1", [m[1]]);
      if (!row) return reply.code(404).send({ error: "Call not found" });

      const key = `${row.short_code}:${row.status}:${row.updated_at.getTime()}:${Math.floor(Date.now() / 30_000)}`;
      let hit = cache.get(key);
      if (!hit) {
        const card = lockedNow(row)
          ? { ...ogData(row, null), locked: true }
          : ogData(row, await markFor(row.symbol));
        hit = { at: Date.now(), png: ogPng(card) };
        cache.set(key, hit);
        if (cache.size > 300) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
      }
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=30")
        .send(hit.png);
    },
  );

  // The link people post: crawlers read the meta tags, people get sent on to the app.
  app.get(
    "/c/:code",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = CODE.safeParse((req.params as { code: string }).code);
      const [row] = parsed.success
        ? await callWithTrader(d.pool, "c.short_code = $1", [parsed.data])
        : [];
      if (!row) {
        return reply
          .code(404)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(
            shareHtml({
              title: "Call not found · TapeVerify",
              description: "This call doesn't exist.",
              shareUrl: base,
              imageUrl: `${base}/og/none.png`,
              webUrl: web,
            }),
          );
      }
      const pub = publicCall(row, row, base);
      // Link previews are public and cached, so a locked call never reveals its trade there.
      if (lockedNow(row)) {
        const who = row.handle ?? shortAddr(row.address);
        return reply
          .header("Content-Type", "text/html; charset=utf-8")
          .header("Cache-Control", "public, max-age=30")
          .send(
            shareHtml({
              title: `Premium call from ${who} · TapeVerify`,
              description: `${who} posted a trade for subscribers. It becomes public with its result once it closes.`,
              shareUrl: pub.url,
              imageUrl: `${base}/og/${row.short_code}.png?v=locked-${row.updated_at.getTime()}`,
              webUrl: `${web}/call/${row.short_code}`,
            }),
          );
      }
      const og = ogData(row, await markFor(row.symbol));
      const move =
        og.resultPct === null
          ? ""
          : ` · ${og.resultPct >= 0 ? "+" : ""}${og.resultPct.toFixed(2)}%`;
      const title = `${row.symbol} ${row.side} ${row.leverage}x${row.entry_price ? ` · entry ${price(row.entry_price)}` : ""}${move}`;
      const description = `${og.trader}'s call on TapeVerify: entry recorded from the fill on Strike. ${og.footer}.`;
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "public, max-age=30")
        .send(
          shareHtml({
            title,
            description,
            shareUrl: pub.url,
            imageUrl: `${base}/og/${row.short_code}.png?v=${row.status}-${row.updated_at.getTime()}`,
            webUrl: `${web}/call/${row.short_code}`,
          }),
        );
    },
  );
}
