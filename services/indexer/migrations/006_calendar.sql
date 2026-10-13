-- cross_calendar (ROADMAP C6, ADR-0011). `calendars` is a projection of the Calendar account, refreshed from chain every
-- time a calendar transaction is ingested and rebuilt by the calendar reconciler; `calendar_events` is the append-only record
-- of the program's events. A cross records its calendar only in the Cross account (CrossCreated does not carry it), so
-- `cross_calendar_binding` holds what the indexer read there: one row per indexed cross, `calendar` null when it has none.

CREATE TABLE IF NOT EXISTS calendars (
  address        TEXT PRIMARY KEY,
  admin          TEXT     NOT NULL,
  calendar_id    NUMERIC  NOT NULL,
  timelock_secs  BIGINT   NOT NULL,
  sessions       JSONB    NOT NULL,            -- [{ "startTs": "<unix s>", "endTs": "<unix s>" }], increasing, as on chain
  feeds          JSONB    NOT NULL,            -- approved Pyth feed ids, hex
  pending        JSONB,                       -- { "sessions": [...], "feeds": [...], "eta": "<unix s>" } or null
  pending_admin  JSONB,                       -- { "admin": "<address>", "eta": "<unix s>" } or null
  first_slot     BIGINT   NOT NULL,           -- slot of the first transaction that touched it (or of the read, if found by the scan)
  read_slot      BIGINT   NOT NULL,           -- finalized slot the account was last read at
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendars_admin ON calendars (admin);

CREATE TABLE IF NOT EXISTS calendar_events (
  signature        TEXT        NOT NULL,
  seq              INTEGER     NOT NULL,
  slot             BIGINT      NOT NULL,
  block_time       TIMESTAMPTZ,
  name             TEXT        NOT NULL,
  calendar_address TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  PRIMARY KEY (signature, seq)
);
CREATE INDEX IF NOT EXISTS calendar_events_calendar_slot ON calendar_events (calendar_address, slot);

CREATE TABLE IF NOT EXISTS cross_calendar_binding (
  cross_address TEXT PRIMARY KEY,
  calendar      TEXT,
  read_slot     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS cross_calendar_binding_calendar ON cross_calendar_binding (calendar) WHERE calendar IS NOT NULL;

CREATE TABLE IF NOT EXISTS calendar_reconciliation_alerts (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  calendar TEXT NOT NULL,
  field    TEXT NOT NULL,
  indexed  TEXT,
  onchain  TEXT
);
