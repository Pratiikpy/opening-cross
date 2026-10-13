-- A total order over the event log that matches the order events were ingested in, for readers that resume from a position
-- (the typed gRPC stream, services/stream). (slot, signature, seq) identifies an event but is not an ingestion order: a reader
-- that resumes after one position could miss an event ingested later with a smaller key. The indexer is the only writer and
-- commits one transaction at a time, so `ingest_id` grows in commit order; gaps are possible (a rolled-back transaction uses ids).
--
-- Existing rows are numbered in (slot, signature, seq) order, which is chronological order on chain.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'ingest_id') THEN
    ALTER TABLE events ADD COLUMN ingest_id BIGINT;
    WITH numbered AS (SELECT signature, seq, row_number() OVER (ORDER BY slot, signature, seq) AS n FROM events)
      UPDATE events e SET ingest_id = numbered.n FROM numbered WHERE e.signature = numbered.signature AND e.seq = numbered.seq;
    CREATE SEQUENCE events_ingest_id_seq OWNED BY events.ingest_id;
    PERFORM setval('events_ingest_id_seq', COALESCE((SELECT max(ingest_id) FROM events), 0) + 1, false);
    ALTER TABLE events ALTER COLUMN ingest_id SET DEFAULT nextval('events_ingest_id_seq');
    ALTER TABLE events ALTER COLUMN ingest_id SET NOT NULL;
    CREATE UNIQUE INDEX events_ingest_id ON events (ingest_id);
  END IF;
END $$;
