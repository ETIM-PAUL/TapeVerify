-- Phase 8: AI Strategy Studio. A strategy is validated, declarative data; nothing here places orders.
CREATE TABLE strategies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  spec        jsonb NOT NULL,
  source      text NOT NULL CHECK (source IN ('ai', 'template', 'manual')),
  -- The plain-English request an AI draft came from (kept so the draft can be audited).
  prompt      text,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strategies_user_idx ON strategies (user_id, updated_at DESC);

-- Cost control: every model call is counted per user.
CREATE TABLE ai_usage (
  id                bigserial PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model             text NOT NULL,
  attempts          integer NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  ok                boolean NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_time_idx ON ai_usage (user_id, created_at DESC);
