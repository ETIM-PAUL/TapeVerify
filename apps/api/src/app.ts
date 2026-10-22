import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { KeyVault } from "@pit/shared";
import { StrikeApiError } from "@pit/strike-sdk";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import { ReconnectRequiredError, type StrikeGateway } from "./gateway.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { callsRoutes } from "./routes/calls.js";
import { followsRoutes } from "./routes/follows.js";
import { fundsRoutes } from "./routes/funds.js";
import { shareRoutes } from "./routes/share.js";
import { type SessionUser, userForSession } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export interface AppDeps {
  pool: pg.Pool;
  vault: KeyVault;
  gateway: StrikeGateway;
  api: ApiConfig;
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** The signed-in user if there is a valid session, else null. Never rejects. */
  optionalUser: (req: FastifyRequest) => Promise<SessionUser | null>;
}

export async function buildApp(
  base: Omit<AppDeps, "requireUser" | "optionalUser">,
  logger = false,
) {
  const app = Fastify({
    logger: logger ? { redact: ["req.headers.cookie", "req.headers.authorization"] } : false,
    bodyLimit: 256 * 1024,
  });
  await app.register(cors, { origin: base.api.webOrigin, credentials: true });
  await app.register(cookie);
  if (base.api.rateLimitEnabled)
    await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  const d: AppDeps = {
    ...base,
    optionalUser: async (req) => {
      const token = req.cookies.pit_session;
      return token ? await userForSession(base.pool, token) : null;
    },
    requireUser: async (req, reply) => {
      const token = req.cookies.pit_session;
      const user = token ? await userForSession(base.pool, token) : null;
      if (!user) return reply.code(401).send({ error: "Not signed in" });
      req.user = user;
    },
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err instanceof ReconnectRequiredError) {
      return reply
        .code(401)
        .send({ error: "Wallet session expired, reconnect", code: "reconnect_required" });
    }
    if (err instanceof StrikeApiError) {
      // Pass Strike's validation messages through; never its auth failures as-is.
      const status =
        err.status >= 500 ? 502 : err.status === 401 || err.status === 403 ? 502 : err.status;
      return reply.code(status).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err: { message: (err as Error).message } }, "unhandled error");
    return reply.code(500).send({ error: "Internal error" });
  });

  app.get("/health", async () => ({ ok: true }));
  authRoutes(app, d);
  accountRoutes(app, d);
  fundsRoutes(app, d);
  callsRoutes(app, d);
  followsRoutes(app, d);
  shareRoutes(app, d);
  return app;
}
