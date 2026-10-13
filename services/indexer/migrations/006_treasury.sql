-- Ownership-coin treasuries (programs/treasury, ADR-0014): the program's events as an append-only log, a projection of them per
-- treasury, and the owner's signed disclosure updates with the Memo transaction that anchors each one in chain time.
-- Mutable on-chain state (period spend, the recorded lapse, balances) is not stored here: the API reads it from the chain.

CREATE TABLE IF NOT EXISTS treasury_events (
  signature   TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  slot        BIGINT      NOT NULL,
  block_time  TIMESTAMPTZ,
  name        TEXT        NOT NULL,   -- TreasuryCreated | Spent | AttestationLapsed | LiquidationStarted | Redeemed
  treasury    TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  PRIMARY KEY (signature, seq)
);
CREATE INDEX IF NOT EXISTS treasury_events_treasury_slot ON treasury_events (treasury, slot DESC);

CREATE TABLE IF NOT EXISTS treasuries (
  address            TEXT PRIMARY KEY,
  coin_mint          TEXT    NOT NULL,
  authority          TEXT    NOT NULL,
  allowance          NUMERIC NOT NULL,
  period_secs        BIGINT  NOT NULL,
  created_signature  TEXT    NOT NULL,
  created_slot       BIGINT  NOT NULL,
  created_at         BIGINT,                      -- cluster seconds of the creating block
  state              TEXT    NOT NULL,            -- Active | Liquidating
  spent_total        NUMERIC NOT NULL DEFAULT 0,
  spend_count        INTEGER NOT NULL DEFAULT 0,
  lapse_count        INTEGER NOT NULL DEFAULT 0,
  last_lapse_at      BIGINT,
  liquidation_vault  NUMERIC,
  liquidation_supply NUMERIC,
  liquidated_at      BIGINT,
  redeemed_burned    NUMERIC NOT NULL DEFAULT 0,
  redeemed_paid      NUMERIC NOT NULL DEFAULT 0,
  redemption_count   INTEGER NOT NULL DEFAULT 0,
  updated_slot       BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS treasuries_created ON treasuries (created_slot DESC);

-- A disclosure update: the body is canonical JSON signed by the treasury authority; id is the sha-256 of the body. The Memo
-- transaction carries the id and was signed by the same key, so chain time bounds the update from above.
CREATE TABLE IF NOT EXISTS treasury_updates (
  id               TEXT PRIMARY KEY,
  treasury         TEXT    NOT NULL,
  sequence         INTEGER NOT NULL,
  previous_id      TEXT,
  signer           TEXT    NOT NULL,
  signature        TEXT    NOT NULL,
  body             JSONB   NOT NULL,
  memo_signature   TEXT    NOT NULL UNIQUE,
  memo_slot        BIGINT  NOT NULL,
  memo_block_time  BIGINT  NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (treasury, sequence)
);
