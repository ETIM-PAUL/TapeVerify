import { loadInfraConfig } from "@pit/shared";
import pg from "pg";

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: loadInfraConfig().databaseUrl });
}
