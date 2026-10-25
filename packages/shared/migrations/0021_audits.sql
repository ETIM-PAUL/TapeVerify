-- Fair-execution audits: anyone can ask for any Strike account (id, vault or wallet) to be checked against the recorded
-- order book. A worker does the reading and checking; this table is the queue and the result.
CREATE TABLE audit_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selector    jsonb NOT NULL,
  -- What was asked for, so a repeat request within a few minutes reuses the finished or running job.
  selector_key text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_ms  bigint NOT NULL,
  started_ms  bigint,
  finished_ms bigint,
  error       text,
  report      jsonb
);
CREATE INDEX audit_jobs_queue_idx ON audit_jobs (created_ms) WHERE status = 'queued';
CREATE INDEX audit_jobs_key_idx ON audit_jobs (selector_key, created_ms DESC);

-- Auditing looks fills up in the recorded book by their trade id.
CREATE INDEX IF NOT EXISTS l3_updates_trade_idx ON l3_updates (trade_id) WHERE trade_id IS NOT NULL;
