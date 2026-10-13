-- The immutable fields of a cross that the measured metrics need and the index does not carry (price scale, decimals, proceeds,
-- integrator, fee recipient, gate mint, sealed). A cross's fields never change, so each is read from chain once and kept here; a
-- restarted API process, or one on a rate-limited endpoint, no longer re-reads every cross before it can answer.

CREATE TABLE IF NOT EXISTS cross_statics (
  address       TEXT PRIMARY KEY,
  price_scale   NUMERIC NOT NULL,
  quote_decimals SMALLINT NOT NULL,
  base_decimals SMALLINT NOT NULL,
  creator       TEXT NOT NULL,
  proceeds_to   TEXT NOT NULL,
  integrator    TEXT NOT NULL,
  fee_recipient TEXT NOT NULL,
  gate_mint     TEXT,
  sealed        BOOLEAN NOT NULL
);
