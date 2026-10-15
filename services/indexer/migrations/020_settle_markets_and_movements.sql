-- Two market openings of cross_settle that had no projection, and the treasury movement read model. Additive and idempotent.
--
-- settle_futarchy_daos: FutarchyDaoSeeded (programs/cross_settle seed_futarchy_dao, ADR-0657). One row per DAO. A cross can open more than one (the DAO address
--   comes from the creator and a nonce, and the program keeps no per-cross marker), so the key is the DAO and the cross is an index.
-- settle_presales: FixedPricePresaleOpened (open_fixed_price_presale, ADR-0663). One row per presale, keyed by the presale for the same reason (the `base` keypair).
-- treasury_movements: every treasury event that moves value across the treasury's boundary, one row per event, in the order the indexer ingested it. It is what
--   the insider, team and treasury movement alerts of row F5 read (ADR-0930). It is derived from treasury_events and treasury_proposals / treasury_grants, so it
--   can be rebuilt (backfillTreasuryMovements in src/treasury-movements.ts).

CREATE TABLE IF NOT EXISTS settle_futarchy_daos (
  dao            TEXT PRIMARY KEY,
  cross_address  TEXT    NOT NULL,
  clearing_price NUMERIC NOT NULL,
  base_amount    NUMERIC NOT NULL,           -- base tokens put into the DAO's spot pool
  quote_amount   NUMERIC NOT NULL,           -- quote tokens put in with them, priced at the clearing price
  signature      TEXT    NOT NULL,
  slot           BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS settle_futarchy_daos_cross ON settle_futarchy_daos (cross_address, slot);

CREATE TABLE IF NOT EXISTS settle_presales (
  presale        TEXT PRIMARY KEY,
  cross_address  TEXT    NOT NULL,
  clearing_price NUMERIC NOT NULL,
  q_price        NUMERIC NOT NULL,           -- the price in Meteora's Q64.64 form, as the program wrote it (fits a u128)
  signature      TEXT    NOT NULL,
  slot           BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS settle_presales_cross ON settle_presales (cross_address, slot);

CREATE TABLE IF NOT EXISTS treasury_movements (
  id            BIGSERIAL PRIMARY KEY,       -- ingestion order: a reader that remembers the last id it saw misses nothing
  signature     TEXT        NOT NULL,
  seq           INTEGER     NOT NULL,        -- the event's position in its transaction, the same as treasury_events.seq
  slot          BIGINT      NOT NULL,
  block_time    TIMESTAMPTZ,
  treasury      TEXT        NOT NULL,
  kind          TEXT        NOT NULL,        -- spend | proposal_spend | tranche_release | grant_release | sweep | redemption | nav_redemption | distribution_deposit | revenue_share
  direction     TEXT        NOT NULL,        -- out | in, from the treasury's side
  asset         TEXT        NOT NULL,        -- quote (the treasury's quote mint) | coin (the ownership coin)
  amount        NUMERIC     NOT NULL,        -- token atoms of `asset`
  counterparty  TEXT,                        -- who received (out) or paid (in); null when the event does not say (tranche_release)
  reference     TEXT,                        -- the proposal, grant or round the movement belongs to
  team_outflow  BOOLEAN     NOT NULL,        -- one of the three outflows the program's guard_team_outflow covers: spend, proposal_spend, tranche_release
  detail        JSONB       NOT NULL DEFAULT '{}',
  UNIQUE (signature, seq)
);
CREATE INDEX IF NOT EXISTS treasury_movements_treasury ON treasury_movements (treasury, id DESC);
CREATE INDEX IF NOT EXISTS treasury_movements_kind ON treasury_movements (kind, id DESC);
