-- A quiet book emits no updates, so the last update time understates how long a segment was observed.
-- The recorder refreshes this while a segment is open; crash recovery closes the segment at it.
ALTER TABLE l3_segments ADD COLUMN last_seen_ts bigint;
