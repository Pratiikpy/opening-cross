-- The issuer subscription (PRODUCT_FEATURES Y8). A payment is a transfer the chain proves; the row only remembers that it was read.

CREATE TABLE IF NOT EXISTS billing_payments (
  signature   TEXT PRIMARY KEY,
  issuer      TEXT        NOT NULL,
  plan        TEXT        NOT NULL,
  amount      NUMERIC     NOT NULL,
  paid_at     BIGINT      NOT NULL,        -- the transaction's block time
  slot        BIGINT      NOT NULL,
  mint        TEXT        NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_payments_issuer ON billing_payments (issuer, paid_at);

-- Signed invoices, kept so the same period is never invoiced twice with different numbers. `doc` is the signed document as issued.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id           TEXT PRIMARY KEY,           -- the signed document's own id
  party        TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  period_start BIGINT      NOT NULL,
  period_end   BIGINT      NOT NULL,
  doc          JSONB       NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_invoices_party ON billing_invoices (party, period_start DESC);
