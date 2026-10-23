import { createPool, KeyVault, LocalKekProvider, loadStrikeConfig } from "@tapeverify/shared";
import { createDrafter, loadAiConfig } from "./ai/translate.js";
import { buildApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { StrikeGateway } from "./gateway.js";
import { serveWeb } from "./web.js";

const api = loadApiConfig();
const strike = loadStrikeConfig();
const pool = createPool();
const vault = new KeyVault(LocalKekProvider.fromEnv());
const aiConfig = loadAiConfig();
const app = await buildApp(
  {
    pool,
    vault,
    api,
    gateway: new StrikeGateway(pool, vault, strike),
    draft: aiConfig ? createDrafter(aiConfig) : null,
  },
  true,
);
// In production the API also serves the built web app (WEB_DIST, defaulting to apps/web/dist).
const webDist = process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;
if (serveWeb(app, webDist)) app.log.info({ webDist }, "serving the web app");
await app.listen({ port: api.port, host: "0.0.0.0" });
