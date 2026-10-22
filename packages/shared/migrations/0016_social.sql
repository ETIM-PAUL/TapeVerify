-- Phase 14: social feed, notifications, posting channels (Telegram, X) and vault graduation.

CREATE TABLE trader_follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trader_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, trader_id),
  CHECK (follower_id <> trader_id)
);
CREATE INDEX trader_follows_trader_idx ON trader_follows (trader_id);

CREATE TABLE call_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_comments_call_idx ON call_comments (call_id, created_at);

-- ref makes every notification idempotent: the same event never notifies the same person twice.
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('new_call', 'liquidation', 'strategy_stop', 'comment', 'new_follower')),
  ref        text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  url        text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (user_id, ref)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Where a trader's calls get posted. target is a Telegram chat id, or 'pit' for Pit's own X account.
CREATE TABLE post_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('telegram', 'x')),
  target     text NOT NULL,
  title      text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, target)
);

-- A Telegram account proves it is a Pit user by sending a one-time code the web app showed them.
CREATE TABLE telegram_links (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user_id  bigint NOT NULL UNIQUE,
  tg_username text,
  linked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_link_codes (
  code       text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_ms bigint NOT NULL
);

-- Posts to send. One row per (call, channel, event), so a call is never posted twice to the same place.
CREATE TABLE outbox (
  id          bigserial PRIMARY KEY,
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES post_channels(id) ON DELETE CASCADE,
  event       text NOT NULL CHECK (event IN ('opened', 'closed')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  error       text,
  external_id text,
  created_ms  bigint NOT NULL,
  sent_ms     bigint,
  UNIQUE (call_id, channel_id, event)
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE status = 'pending';

-- Vault graduation is a guided hand-off to the Strike app: Pit records that the trader was pointed there.
CREATE TABLE vault_handoffs (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  noted_ms   bigint NOT NULL
);
