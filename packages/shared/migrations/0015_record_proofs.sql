-- A record's Merkle proof is stored with it when its batch is sealed, so removing another account's
-- snapshot (a deleted user) can never invalidate anyone else's proof.
ALTER TABLE record_snapshots ADD COLUMN proof jsonb;
