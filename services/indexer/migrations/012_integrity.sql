-- Integrity analysis (PRODUCT_FEATURES F2, F3, F6, F8, F9, V5): what was looked up once and what third parties signed.

-- The wallet that first sent a wallet SOL, found by reading its oldest transactions. A wallet's first funder never changes, so a
-- result is kept for good; a wallet whose funder could not be found keeps the reason so it is not asked again every request.
CREATE TABLE IF NOT EXISTS funding_cache (
  wallet      TEXT PRIMARY KEY,
  funder      TEXT,
  lamports    NUMERIC,
  signature   TEXT,
  block_time  BIGINT,
  unknown     TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funding_cache_funder ON funding_cache (funder);

-- Signed documents about a token: the issuer's supply declaration and team list, and an attester's backing attestation. The whole
-- document is kept so a reader can verify it themselves; the columns are for lookup.
CREATE TABLE IF NOT EXISTS integrity_documents (
  id          TEXT PRIMARY KEY,                 -- the document's own sha-256 id
  schema      TEXT        NOT NULL,
  mint        TEXT        NOT NULL,
  signer      TEXT        NOT NULL,
  as_of       BIGINT      NOT NULL,
  doc         JSONB       NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrity_documents_lookup ON integrity_documents (mint, schema, as_of DESC);

-- Each rating computed for a finished cross, kept as it was computed, so that its record can be scored against what happened.
CREATE TABLE IF NOT EXISTS rating_snapshots (
  cross_address TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  score         SMALLINT,
  status        TEXT        NOT NULL,
  body          JSONB       NOT NULL,
  rated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cross_address, version)
);

-- What happened afterwards, with where the number came from. Nothing writes here without a price source; an empty table is the
-- honest state until one exists.
CREATE TABLE IF NOT EXISTS rating_outcomes (
  cross_address TEXT        PRIMARY KEY,
  outcome_bps   INTEGER     NOT NULL,
  horizon_secs  INTEGER     NOT NULL,
  source        TEXT        NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
