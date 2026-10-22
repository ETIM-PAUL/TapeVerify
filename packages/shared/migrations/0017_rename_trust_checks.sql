-- The trust checks were renamed: tables, indexes, constraints and sequences move from argus_* to verify_*.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname LIKE 'argus\_%' AND c.relkind IN ('r', 'S', 'i')
            ORDER BY (c.relkind = 'r') DESC LOOP
    IF r.relkind = 'r' THEN EXECUTE format('ALTER TABLE %I RENAME TO %I', r.relname, 'verify_' || substr(r.relname, 7));
    ELSIF r.relkind = 'S' THEN EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', r.relname, 'verify_' || substr(r.relname, 7));
    END IF;
  END LOOP;
  -- constraint-backed indexes are renamed through their constraint, the rest directly
  FOR r IN SELECT con.conname, c.relname AS tbl FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND con.conname LIKE 'argus\_%' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, 'verify_' || substr(r.conname, 7));
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relkind = 'i' AND c.relname LIKE 'argus\_%' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, 'verify_' || substr(r.relname, 7));
  END LOOP;
END $$;
