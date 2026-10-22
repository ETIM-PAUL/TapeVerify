-- Phase 12: Argus, the trust engine. Findings are raised by detectors and reviewed by a person.

-- Where an account signs in from, as salted hashes only: a weak signal that helps spot one operator behind many
-- follower accounts. Pruned after 90 days.
CREATE TABLE login_events (
  id       bigserial PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash  text NOT NULL,
  ua_hash  text,
  ts_ms    bigint NOT NULL
);
CREATE INDEX login_events_user_idx ON login_events (user_id);
CREATE INDEX login_events_ip_idx ON login_events (ip_hash);
CREATE INDEX login_events_ts_idx ON login_events (ts_ms);

CREATE TABLE argus_findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('front_running', 'front_running_pattern', 'self_trade', 'collusion_pair', 'sybil_cluster')),
  severity    text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  -- open: raised automatically, costs reputation while it waits. appealed: the trader contests it.
  -- confirmed / dismissed: decided by a reviewer. cleared: an appeal was accepted.
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'appealed', 'confirmed', 'dismissed', 'cleared')),
  base_key    text NOT NULL,
  generation  integer NOT NULL DEFAULT 0,
  summary     text NOT NULL,
  -- Reviewer-only detail: may name other accounts. Never exposed publicly.
  evidence    jsonb NOT NULL,
  review_note text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (base_key, generation)
);
CREATE INDEX argus_findings_subject_idx ON argus_findings (subject_id);
CREATE INDEX argus_findings_queue_idx ON argus_findings (status) WHERE status IN ('open', 'appealed');

CREATE TABLE argus_appeals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id    uuid NOT NULL REFERENCES argus_findings(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message       text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  prior_status  text NOT NULL,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
-- A finding can be appealed once: no repeat appeals after a rejection.
CREATE UNIQUE INDEX argus_appeals_one_per_finding_idx ON argus_appeals (finding_id);

-- Every status change, with who made it.
CREATE TABLE argus_events (
  id          bigserial PRIMARY KEY,
  finding_id  uuid NOT NULL REFERENCES argus_findings(id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  note        text
);
CREATE INDEX argus_events_finding_idx ON argus_events (finding_id, id);

CREATE TABLE trader_reputation (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score         integer NOT NULL,
  performance   integer NOT NULL,
  confidence    numeric NOT NULL,
  penalty       integer NOT NULL,
  clean         boolean NOT NULL,
  clean_reasons jsonb NOT NULL,
  penalties     jsonb NOT NULL,
  trades        integer NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reputation_history (
  id       bigserial PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts_ms    bigint NOT NULL,
  score    integer NOT NULL,
  previous integer,
  reason   text NOT NULL
);
CREATE INDEX reputation_history_user_idx ON reputation_history (user_id, id DESC);
