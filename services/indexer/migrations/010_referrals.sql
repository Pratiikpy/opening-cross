-- Signed referral documents (PRODUCT_FEATURES W6: an optional 10% referrer). A referral is the referred wallet's own signed
-- statement that a referrer should be credited for its orders from a time on. cross_core has no referrer field (ADR-0010), so
-- the share is accounting and a transfer from the protocol fee wallet, not an on-chain rule; these rows are that accounting's input.

CREATE TABLE IF NOT EXISTS referrals (
  id             TEXT PRIMARY KEY,                -- the document id (hash of the canonical body)
  owner          TEXT        NOT NULL,            -- the referred wallet; it signed
  referrer       TEXT,                            -- null revokes
  effective_from BIGINT      NOT NULL,
  nonce          TEXT        NOT NULL,
  doc            JSONB       NOT NULL,            -- the signed document, verbatim
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, nonce)
);
CREATE INDEX IF NOT EXISTS referrals_owner ON referrals (owner, effective_from);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer);
