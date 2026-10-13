-- cross_settle (programs/cross_settle): the events of the adapters that open venues from a cleared cross, and the partner, locked-continuation,
-- batch-opened and greenshoe paths of ADR-0480 to ADR-0487. An append-only log plus the state a reader scans. Idempotent.

CREATE TABLE IF NOT EXISTS settle_events (
  signature     TEXT        NOT NULL,
  seq           INTEGER     NOT NULL,
  slot          BIGINT      NOT NULL,
  block_time    TIMESTAMPTZ,
  name          TEXT        NOT NULL,
  cross_address TEXT,                        -- resolved for the greenshoe events through `settle_greenshoes`
  payload       JSONB       NOT NULL,
  PRIMARY KEY (signature, seq)
);
CREATE INDEX IF NOT EXISTS settle_events_cross ON settle_events (cross_address, slot DESC);

-- One row per greenshoe (created once per cross); the level columns follow GreenshoeBidPlaced / GreenshoeLevelSettled / GreenshoeFinished.
CREATE TABLE IF NOT EXISTS settle_greenshoes (
  greenshoe      TEXT PRIMARY KEY,
  cross_address  TEXT    NOT NULL UNIQUE,
  budget         NUMERIC NOT NULL,
  start_ts       BIGINT  NOT NULL,
  expires_ts     BIGINT  NOT NULL,
  bids           JSONB   NOT NULL DEFAULT '[]',     -- [{ level, binId, amount, limitOrder }]
  settled_levels JSONB   NOT NULL DEFAULT '[]',     -- [level]
  finished       BOOLEAN NOT NULL DEFAULT false,
  burned         NUMERIC,
  returned       NUMERIC,
  created_slot   BIGINT  NOT NULL
);

-- Venues a cross opened: one row per cross (the first adapter event wins; DBC continuation also has a mint bind).
CREATE TABLE IF NOT EXISTS settle_venues (
  cross_address  TEXT PRIMARY KEY,
  venue          TEXT    NOT NULL,   -- dbc | damm_v2 | dlmm | raydium_cpmm
  pool           TEXT    NOT NULL,
  clearing_price NUMERIC NOT NULL,
  detail         JSONB   NOT NULL,
  slot           BIGINT  NOT NULL
);

-- Partner payouts of a DBC continuation, summed per cross (PartnerFeeClaimed, PartnerSurplusWithdrawn, PartnerMigrationFeeWithdrawn,
-- PartnerPoolCreationFeeClaimed, PolFeesClaimed).
CREATE TABLE IF NOT EXISTS settle_partner (
  cross_address       TEXT PRIMARY KEY,
  fee_base            NUMERIC NOT NULL DEFAULT 0,
  fee_quote           NUMERIC NOT NULL DEFAULT 0,
  fee_claims          INTEGER NOT NULL DEFAULT 0,
  surplus_withdrawn   NUMERIC NOT NULL DEFAULT 0,
  migration_fee       NUMERIC NOT NULL DEFAULT 0,
  pool_creation_lamports NUMERIC NOT NULL DEFAULT 0,
  pol_token_a         NUMERIC NOT NULL DEFAULT 0,
  pol_token_b         NUMERIC NOT NULL DEFAULT 0,
  pol_claims          INTEGER NOT NULL DEFAULT 0,
  updated_slot        BIGINT  NOT NULL
);
