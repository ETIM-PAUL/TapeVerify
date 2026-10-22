import pg from "pg";
import { runMigrations } from "../src/db/migrations.js";

/** Creates (if needed) and migrates a throwaway `pit_test` database next to the dev one. */
export default async function setup() {
  const base = process.env.DATABASE_URL ?? "postgres://pit:pit@localhost:5432/pit";
  const url = new URL(base);
  const admin = new pg.Pool({ connectionString: base });
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'pit_test'");
  if (exists.rowCount === 0) await admin.query("CREATE DATABASE pit_test");
  await admin.end();
  url.pathname = "/pit_test";
  process.env.TEST_DATABASE_URL = url.toString();
  const pool = new pg.Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  await pool.end();
}
