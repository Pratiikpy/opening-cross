-- Streams every newly ingested event to listeners (the API's WebSocket feed) on channel
-- `opening_cross_events`. The payload carries the key; listeners read the row itself.
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('opening_cross_events', json_build_object('signature', NEW.signature, 'seq', NEW.seq)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_notify ON events;
CREATE TRIGGER events_notify AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION notify_event();
