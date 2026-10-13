-- Off-chain liquidity: the market-maker registry, signed maker quotes and signed intents (PRODUCT_FEATURES W7, W9, Z7).
-- Everything here is a signed document stored with its signature, so a row can be re-verified by anyone who reads it.
-- Nothing in these tables is authoritative for money: orders, escrow and fills are on chain.

CREATE TABLE IF NOT EXISTS liquidity_makers (
  maker           TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  min_quantity    NUMERIC     NOT NULL,
  max_spread_bps  INTEGER     NOT NULL,
  registration    JSONB       NOT NULL,          -- the signed registration document, verbatim
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS liquidity_quotes (
  id            TEXT PRIMARY KEY,                -- the quote id (hash of the canonical body)
  cross_address TEXT        NOT NULL,
  maker         TEXT        NOT NULL,
  side          TEXT        NOT NULL,
  price         NUMERIC     NOT NULL,
  quantity      NUMERIC     NOT NULL,
  order_nonce   NUMERIC     NOT NULL,
  expires_at    BIGINT      NOT NULL,
  quote         JSONB       NOT NULL,            -- the signed quote document, verbatim
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS liquidity_quotes_cross ON liquidity_quotes (cross_address, expires_at);
CREATE INDEX IF NOT EXISTS liquidity_quotes_maker ON liquidity_quotes (maker);

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT PRIMARY KEY,                  -- the intent id (hash of the canonical body)
  owner       TEXT        NOT NULL,
  base_mint   TEXT        NOT NULL,
  quote_mint  TEXT        NOT NULL,
  expires_at  BIGINT      NOT NULL,
  intent      JSONB       NOT NULL,              -- the signed intent document, verbatim
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intents_owner ON intents (owner, expires_at);
CREATE INDEX IF NOT EXISTS intents_pair ON intents (base_mint, quote_mint, expires_at);
