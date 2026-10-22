import { KeyVault, LocalKekProvider, loadStrikeConfig } from "@pit/shared";
import { buildApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { StrikeGateway } from "./gateway.js";

const api = loadApiConfig();
const strike = loadStrikeConfig();
const pool = createPool();
const vault = new KeyVault(LocalKekProvider.fromEnv());
const app = await buildApp(
  { pool, vault, api, gateway: new StrikeGateway(pool, vault, strike) },
  true,
);
await app.listen({ port: api.port, host: "0.0.0.0" });
