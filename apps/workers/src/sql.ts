import type pg from "pg";

/** Multi-row INSERT in chunks that stay under Postgres' 65535-parameter limit. */
export async function insertRows(
  db: pg.Pool | pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  tail = "",
  chunk = Math.floor(60000 / columns.length),
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part
      .map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(",")})`)
      .join(",");
    const r = await db.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values} ${tail}`,
      params,
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
