-- The operations console (PRODUCT_FEATURES R11): listing decisions, incidents, compliance cases, and the audit log that records them.

-- Append-only and hash-chained: each row's hash covers the previous row's hash, so removing or editing any row breaks every hash after it.
CREATE TABLE IF NOT EXISTS ops_log (
  seq        BIGSERIAL PRIMARY KEY,
  at         BIGINT      NOT NULL,
  actor      TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  subject    TEXT        NOT NULL,
  detail     JSONB       NOT NULL,
  prev_hash  TEXT        NOT NULL,
  hash       TEXT        NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ops_listings (
  id           TEXT PRIMARY KEY,
  mint         TEXT,
  cross_address TEXT,
  requested_by TEXT        NOT NULL,
  note         TEXT        NOT NULL,
  status       TEXT        NOT NULL,          -- pending | approved | rejected | needs-info
  reason       TEXT,
  evidence     JSONB       NOT NULL,          -- what the console gathered at the time of the request
  created_at   BIGINT      NOT NULL,
  decided_at   BIGINT,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS ops_listings_status ON ops_listings (status, created_at);

CREATE TABLE IF NOT EXISTS ops_incidents (
  id          TEXT PRIMARY KEY,
  dedupe_key  TEXT,                            -- one open incident per key
  severity    TEXT        NOT NULL,            -- critical | warning | info
  title       TEXT        NOT NULL,
  source      TEXT        NOT NULL,            -- monitor | manual
  state       TEXT        NOT NULL,            -- open | acknowledged | resolved
  detail      JSONB       NOT NULL,
  opened_at   BIGINT      NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at BIGINT,
  resolved_by TEXT,
  resolved_at BIGINT,
  resolution  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_incidents_open_key ON ops_incidents (dedupe_key) WHERE state <> 'resolved' AND dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops_cases (
  id          TEXT PRIMARY KEY,
  kind        TEXT        NOT NULL,            -- sanctions | fraud | support | other
  subject     TEXT        NOT NULL,            -- a wallet, cross or mint
  summary     TEXT        NOT NULL,
  status      TEXT        NOT NULL,            -- open | closed
  assignee    TEXT,
  opened_by   TEXT        NOT NULL,
  opened_at   BIGINT      NOT NULL,
  closed_by   TEXT,
  closed_at   BIGINT,
  resolution  TEXT
);
CREATE INDEX IF NOT EXISTS ops_cases_status ON ops_cases (status, opened_at);

CREATE TABLE IF NOT EXISTS ops_case_notes (
  id      BIGSERIAL PRIMARY KEY,
  case_id TEXT   NOT NULL REFERENCES ops_cases(id),
  at      BIGINT NOT NULL,
  author  TEXT   NOT NULL,
  text    TEXT   NOT NULL
);
