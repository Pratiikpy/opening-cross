-- Premium observations: one row per quote attempt of the premium monitor (ADR-0017), including the ones that
-- could not be priced, so exclusions are counted rather than dropped. Append-only.

CREATE TABLE IF NOT EXISTS premium_observations (
  id                    BIGSERIAL PRIMARY KEY,
  at                    BIGINT   NOT NULL,       -- unix seconds of the round
  cluster               TEXT     NOT NULL,
  ticker                TEXT     NOT NULL,
  symbol                TEXT     NOT NULL,
  mint                  TEXT     NOT NULL,
  leg                   TEXT     NOT NULL CHECK (leg IN ('buy', 'sell')),
  size_usd              INTEGER  NOT NULL,
  session               TEXT     NOT NULL CHECK (session IN ('regular', 'pre', 'post', 'overnight', 'closed')),
  reference_kind        TEXT     NOT NULL,
  status                TEXT     NOT NULL,
  reference_e6          NUMERIC,                 -- micro-USD per share
  per_share_e6          NUMERIC,
  premium_bps_x100      NUMERIC,                 -- signed, basis points x 100
  price_impact_bps_x100 NUMERIC,
  route                 TEXT,
  multiplier            TEXT
);
CREATE INDEX IF NOT EXISTS premium_obs_time ON premium_observations (cluster, at);
CREATE INDEX IF NOT EXISTS premium_obs_ticker ON premium_observations (cluster, ticker, at);
