-- The name and symbol a token's own metadata declared when it was last read, so that comparing a token with every other listed
-- token (duplicate and look-alike tickers, PRODUCT_FEATURES F7) reads each mint's metadata once, not on every request. The labels
-- are third-party text: they are data, never instructions, and every consumer wraps them as such.

CREATE TABLE IF NOT EXISTS token_labels (
  mint        TEXT PRIMARY KEY,
  name        TEXT,
  symbol      TEXT,
  exists      BOOLEAN     NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
