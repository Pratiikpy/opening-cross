-- The rules extension of cross_core (ADR-0450 to ADR-0462): what the new events project onto. Everything here is additive and optional:
-- a cross created by the program deployed before the extension has no row in any of these tables, and every existing column keeps its meaning.
-- Idempotent: the indexer applies every migration on each start.

-- What the commit instruction carried and the event does not: the nonce (the address of a lockup is derived from it), the allocation class
-- and the lockup the buyer accepted. Null for orders indexed before they were captured, and for orders on crosses without rules (class 0).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS nonce     NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS class     SMALLINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lock_secs BIGINT;

-- OrderPlacement: where the chain clock put the order. `bucket` 255 = before the ending period; `epoch` above 0 = after a drawn extension.
CREATE TABLE IF NOT EXISTS order_placements (
  order_address TEXT PRIMARY KEY,
  cross_address TEXT     NOT NULL,
  epoch         SMALLINT NOT NULL,
  bucket        SMALLINT NOT NULL,
  class         SMALLINT NOT NULL,
  flags         SMALLINT NOT NULL,
  lock_cliff    BIGINT   NOT NULL,
  lock_vest     BIGINT   NOT NULL,
  placed_ts     BIGINT   NOT NULL,
  ticket        BIGINT   NOT NULL,
  slot          BIGINT   NOT NULL
);
CREATE INDEX IF NOT EXISTS order_placements_cross ON order_placements (cross_address);

-- RulesSet: the rules a cross was created with (written once, in the slot of its creation). `ext` is the latest CrossExtSnapshot (`log_ext`), which
-- also carries the insiders, the referral and the oracle set; the API reads those from the cross account when it needs them.
CREATE TABLE IF NOT EXISTS cross_rules (
  cross_address      TEXT PRIMARY KEY,
  flags              INTEGER  NOT NULL,
  guards             JSONB    NOT NULL,
  ending             JSONB    NOT NULL,
  identity           JSONB    NOT NULL,
  alloc              JSONB    NOT NULL,
  insiders           SMALLINT NOT NULL,
  bond_quote         NUMERIC  NOT NULL,
  set_slot           BIGINT   NOT NULL,
  ext                JSONB,
  ext_slot           BIGINT,
  -- the draw: a drawn ending, a lottery, a drawn extension
  draw_epoch         SMALLINT NOT NULL DEFAULT 0,
  draw_pending_slot  BIGINT,
  draw_pending_purpose SMALLINT,
  draw_seed          TEXT,
  end_bucket         SMALLINT,
  draw_finished_slot BIGINT,
  extension_pending  BOOLEAN  NOT NULL DEFAULT false,
  extension_reason   SMALLINT
);

-- Insider challenges (id is the cross's challenge count at filing).
CREATE TABLE IF NOT EXISTS cross_challenges (
  cross_address TEXT     NOT NULL,
  id            INTEGER  NOT NULL,
  challenger    TEXT     NOT NULL,
  subject       TEXT     NOT NULL,
  evidence      TEXT     NOT NULL,
  status        TEXT     NOT NULL,   -- Open | Upheld | Rejected | Expired
  slash         NUMERIC,
  filed_slot    BIGINT   NOT NULL,
  resolved_slot BIGINT,
  PRIMARY KEY (cross_address, id)
);
CREATE INDEX IF NOT EXISTS cross_challenges_subject ON cross_challenges (subject);

-- Lockups: one row per locked claim. `order_address` and `nonce` tie the lock to the order whose claim created it, so the lockup account
-- (derived from cross, owner and nonce) can be read to see what has been released. `released` follows the LockReleased events.
CREATE TABLE IF NOT EXISTS cross_locks (
  cross_address TEXT    NOT NULL,
  owner         TEXT    NOT NULL,
  order_address TEXT,
  nonce         NUMERIC,
  amount        NUMERIC NOT NULL,
  start_ts      BIGINT  NOT NULL,
  cliff_secs    BIGINT  NOT NULL,
  vest_secs     BIGINT  NOT NULL,
  released      NUMERIC NOT NULL DEFAULT 0,
  created_slot  BIGINT  NOT NULL,
  signature     TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  PRIMARY KEY (signature, seq)
);
CREATE INDEX IF NOT EXISTS cross_locks_owner ON cross_locks (owner);
CREATE INDEX IF NOT EXISTS cross_locks_cross ON cross_locks (cross_address);

-- Halt states (by base mint) and the lender print feed.
CREATE TABLE IF NOT EXISTS halt_states (
  base_mint    TEXT PRIMARY KEY,
  halted       BOOLEAN  NOT NULL,
  reason       SMALLINT NOT NULL,   -- HaltReason: 0 None, 1 IssuerPause, 2 VenueHalt, 3 CircuitBreaker, 4 CorporateAction
  changed_slot BIGINT   NOT NULL,
  changes      INTEGER  NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS print_feed_prints (
  base_mint     TEXT    NOT NULL,
  cross_address TEXT    NOT NULL,
  price         NUMERIC NOT NULL,
  matched       NUMERIC NOT NULL,
  slot          BIGINT  NOT NULL,
  PRIMARY KEY (base_mint, cross_address)
);

-- Recurring series.
CREATE TABLE IF NOT EXISTS series (
  address      TEXT PRIMARY KEY,
  authority    TEXT   NOT NULL,
  created_slot BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS series_authority ON series (authority);
CREATE TABLE IF NOT EXISTS series_crosses (
  series        TEXT    NOT NULL,
  idx           NUMERIC NOT NULL,
  cross_address TEXT    NOT NULL,
  close_ts      BIGINT  NOT NULL,
  slot          BIGINT  NOT NULL,
  PRIMARY KEY (series, idx)
);
