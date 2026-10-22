import { createPool, runMigrations } from "@tapeverify/shared";

const pool = createPool();
try {
  const applied = await runMigrations(pool);
  for (const f of applied) console.log(`applied ${f}`);
  console.log("migrations up to date");
} finally {
  await pool.end();
}
