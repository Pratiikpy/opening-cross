-- The indexer's own heartbeat. cursors.last_slot only moves when a transaction is ingested, so a quiet protocol and a dead
-- indexer look the same from it. This row is written after every poll that finished: head_slot is the finalized slot read
-- just before that poll, so "polled_at is recent" means the indexer is running and had caught up to head_slot.

CREATE TABLE IF NOT EXISTS indexer_heartbeat (
  id        SMALLINT PRIMARY KEY CHECK (id = 1),
  head_slot BIGINT NOT NULL,
  polled_at TIMESTAMPTZ NOT NULL
);
