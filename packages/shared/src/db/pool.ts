import pg from "pg";
import { loadInfraConfig } from "../config.js";

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: loadInfraConfig().databaseUrl });
}
