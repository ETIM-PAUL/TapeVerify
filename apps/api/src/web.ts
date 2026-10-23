import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Serves the built web app from the API, so the app, the API and the share links live on one address in production
 * (sign-in cookies and /c/ previews need that). Unknown paths fall back to index.html for the app's own router.
 */
export function serveWeb(app: FastifyInstance, dist: string): boolean {
  const root = normalize(dist);
  const index = join(root, "index.html");
  if (!existsSync(index)) return false;
  app.setNotFoundHandler(async (req, reply) => {
    const path = decodeURIComponent((req.url.split("?")[0] ?? "/").replace(/^\/+/, ""));
    if (req.method !== "GET" && req.method !== "HEAD")
      return reply.code(404).send({ error: "Not found" });
    if (/^(v1|og)\//.test(path)) return reply.code(404).send({ error: "Not found" });
    const file = normalize(join(root, path));
    if (file.startsWith(root + sep) && extname(file)) {
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) {
        // Vite fingerprints everything under assets/, so those can be cached for good.
        if (path.startsWith("assets/"))
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        return reply
          .type(TYPES[extname(file)] ?? "application/octet-stream")
          .send(await readFile(file));
      }
      return reply.code(404).send({ error: "Not found" });
    }
    return reply
      .type(TYPES[".html"] as string)
      .header("Cache-Control", "no-cache")
      .send(await readFile(index));
  });
  return true;
}
