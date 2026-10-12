-- Pay-per-call ledger. `x402_attempts` is the state machine of one payment while a request is served; `x402_payments`
-- is the append-only record of payments that settled on chain, which the billing service reads.

CREATE TABLE x402_attempts (
  -- Names one payment: sha256 of the transaction message, hex, for both protocols (the same message cannot be paid twice,
  -- however its signatures are encoded).
  payment_key   text PRIMARY KEY,
  protocol      text NOT NULL CHECK (protocol IN ('x402', 'mpp')),
  payer         text NOT NULL,
  route         text NOT NULL,
  amount        numeric(20, 0) NOT NULL CHECK (amount > 0),
  mint          text NOT NULL,
  pay_to        text NOT NULL,
  network       text NOT NULL,
  request_hash  text NOT NULL,
  -- pending: a request owns it and is verifying, serving and settling. unconfirmed: the owner sent the transfer and gave
  -- up waiting; any request may check the chain. settled: the transfer is on chain. delivered: the response was written
  -- to the buyer. failed: refused or not settled; the payment_key cannot be used again.
  -- aborted: the request failed before settlement, nothing was charged, the same payment may be presented again.
  status        text NOT NULL CHECK (status IN ('pending', 'unconfirmed', 'settled', 'delivered', 'failed', 'aborted')),
  reason        text,
  -- The settlement transaction's signature, recorded before it is broadcast so a crash can be reconciled against chain.
  signature     text UNIQUE,
  redelivered   integer NOT NULL DEFAULT 0,
  -- true when settlement was found by looking at the chain, not by the request that sent it: that request never answered.
  recovered     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  delivered_at  timestamptz
);
CREATE INDEX x402_attempts_pending ON x402_attempts (created_at) WHERE status = 'pending';

CREATE TABLE x402_payments (
  id            bigserial PRIMARY KEY,
  signature     text NOT NULL UNIQUE,
  payment_key   text NOT NULL UNIQUE REFERENCES x402_attempts (payment_key),
  protocol      text NOT NULL,
  payer         text NOT NULL,
  route         text NOT NULL,
  amount        numeric(20, 0) NOT NULL CHECK (amount > 0),
  mint          text NOT NULL,
  pay_to        text NOT NULL,
  network       text NOT NULL,
  request_hash  text NOT NULL,
  settled_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX x402_payments_settled_at ON x402_payments (settled_at);
CREATE INDEX x402_payments_payer ON x402_payments (payer);
CREATE INDEX x402_payments_route ON x402_payments (route);
