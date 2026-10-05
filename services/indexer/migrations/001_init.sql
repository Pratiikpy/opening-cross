-- Opening Cross indexer schema. Events are append-only and keyed by (signature, seq); crosses and
-- orders are projections rebuilt deterministically from events and checked against chain state.

CREATE TABLE IF NOT EXISTS events (
  signature   TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  slot        BIGINT      NOT NULL,
  block_time  TIMESTAMPTZ,
  name        TEXT        NOT NULL,
  cross_address       TEXT,
  payload     JSONB       NOT NULL,
  PRIMARY KEY (signature, seq)
);
CREATE INDEX IF NOT EXISTS events_cross_slot ON events (cross_address, slot);

CREATE TABLE IF NOT EXISTS crosses (
  address              TEXT PRIMARY KEY,
  creator              TEXT    NOT NULL,
  kind                 SMALLINT NOT NULL,
  supply_mode          SMALLINT NOT NULL,
  disclosure           SMALLINT NOT NULL,
  base_mint            TEXT    NOT NULL,
  quote_mint           TEXT    NOT NULL,
  open_ts              BIGINT  NOT NULL,
  close_ts             BIGINT  NOT NULL,
  reveal_end_ts        BIGINT  NOT NULL,
  protocol_fee_bps     INTEGER NOT NULL,
  integrator_fee_bps   INTEGER NOT NULL,
  state                TEXT    NOT NULL,          -- Live | Cleared | NoPrint | Finalized
  clearing_price       NUMERIC,
  matched              NUMERIC,
  rationed             SMALLINT,
  no_print_reason      SMALLINT,
  base_bound_mint      TEXT,
  protocol_fee         NUMERIC,
  integrator_fee       NUMERIC,
  proceeds_quote       NUMERIC,
  dust_base            NUMERIC,
  orders_committed     INTEGER NOT NULL DEFAULT 0,
  created_slot         BIGINT  NOT NULL,
  updated_slot         BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  cross_address        TEXT    NOT NULL REFERENCES crosses(address),
  idx          INTEGER NOT NULL,                  -- order index within the cross (never reused)
  address      TEXT    NOT NULL,
  owner        TEXT    NOT NULL,
  side         SMALLINT NOT NULL,                 -- 0 buy, 1 sell
  escrow       NUMERIC NOT NULL,
  sealed       BOOLEAN NOT NULL,
  price        NUMERIC,
  quantity     NUMERIC,
  status       TEXT    NOT NULL,                  -- committed | revealed | cancelled | claimed
  fill         NUMERIC,
  quote_out    NUMERIC,
  base_out     NUMERIC,
  fee          NUMERIC,
  created_slot BIGINT  NOT NULL,
  updated_slot BIGINT  NOT NULL,
  PRIMARY KEY (cross_address, idx)
);
CREATE INDEX IF NOT EXISTS orders_address ON orders (address);
CREATE INDEX IF NOT EXISTS orders_owner ON orders (owner);

CREATE TABLE IF NOT EXISTS cursors (
  source        TEXT PRIMARY KEY,
  last_signature TEXT,
  last_slot     BIGINT
);

CREATE TABLE IF NOT EXISTS reconciliation_alerts (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cross_address       TEXT NOT NULL,
  field       TEXT NOT NULL,
  indexed     TEXT,
  onchain     TEXT
);
