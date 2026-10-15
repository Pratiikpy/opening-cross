-- The seven Wave 3D programs (programs/cross_mandate, cross_conviction, cross_basket, cross_listing, cross_bounty, cross_backing, cross_graduate;
-- ADR-0650 to ADR-0656): an append-only event log and the state a reader scans. Additive and idempotent. None of these programs is on devnet until the
-- operations key is funded (docs/HUMAN_TASKS.md H27, H43), so on that cluster every table here stays empty and every reader says so.

-- One log for all seven programs. `subject` is the account the event is about (the mandate, lock, basket, listing, bounty, policy or round), so the
-- history of any of them is one indexed read; `cross_address` is set when the event names a cross.
CREATE TABLE IF NOT EXISTS program_events (
  signature     TEXT        NOT NULL,
  seq           INTEGER     NOT NULL,
  slot          BIGINT      NOT NULL,
  block_time    TIMESTAMPTZ,
  program       TEXT        NOT NULL,   -- cross_mandate | cross_conviction | cross_basket | cross_listing | cross_bounty | cross_backing | cross_graduate
  name          TEXT        NOT NULL,
  subject       TEXT,
  cross_address TEXT,
  payload       JSONB       NOT NULL,
  PRIMARY KEY (signature, seq)
);
CREATE INDEX IF NOT EXISTS program_events_subject ON program_events (subject, slot DESC);
CREATE INDEX IF NOT EXISTS program_events_cross ON program_events (cross_address, slot DESC) WHERE cross_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS program_events_program ON program_events (program, name, slot DESC);

-- cross_mandate: MandateCreated, MandateFunded, LimitsChanged, MandateRevoked, MandateWithdrawn, MandateLamportsWithdrawn, MandateSwept, MandateOrderPlaced.
CREATE TABLE IF NOT EXISTS mandates (
  address         TEXT PRIMARY KEY,
  owner           TEXT    NOT NULL,
  agent           TEXT    NOT NULL,
  quote_mint      TEXT    NOT NULL,
  max_per_order   NUMERIC NOT NULL,
  total_cap       NUMERIC NOT NULL,
  max_share_bps   INTEGER NOT NULL,
  expires_at      BIGINT  NOT NULL,
  allow           JSONB   NOT NULL,           -- [{ kind: 0 BaseMint | 1 Creator | 2 Cross, key }]
  committed       NUMERIC NOT NULL DEFAULT 0, -- the program's lifetime total (MandateOrderPlaced.committed)
  revoked         BOOLEAN NOT NULL DEFAULT false,
  funded          NUMERIC NOT NULL DEFAULT 0, -- quote tokens funded, ever
  funded_lamports NUMERIC NOT NULL DEFAULT 0,
  withdrawn       NUMERIC NOT NULL DEFAULT 0,
  orders          INTEGER NOT NULL DEFAULT 0,
  created_slot    BIGINT  NOT NULL,
  updated_slot    BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS mandates_owner ON mandates (owner, created_slot DESC);
CREATE INDEX IF NOT EXISTS mandates_agent ON mandates (agent, created_slot DESC);

CREATE TABLE IF NOT EXISTS mandate_orders (
  order_address TEXT PRIMARY KEY,
  mandate       TEXT    NOT NULL,
  cross_address TEXT    NOT NULL,
  escrow        NUMERIC NOT NULL,
  slot          BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS mandate_orders_mandate ON mandate_orders (mandate, slot DESC);
CREATE INDEX IF NOT EXISTS mandate_orders_cross ON mandate_orders (cross_address);

-- cross_conviction: Locked, Unlocked, BadgeCreated, BadgeClaimed.
CREATE TABLE IF NOT EXISTS conviction_locks (
  lock          TEXT PRIMARY KEY,
  holder        TEXT    NOT NULL,
  mint          TEXT    NOT NULL,
  amount        NUMERIC NOT NULL,
  locked_at     BIGINT  NOT NULL,
  unlock_ts     BIGINT  NOT NULL,
  unlocked      BOOLEAN NOT NULL DEFAULT false,
  badge_claimed BOOLEAN NOT NULL DEFAULT false,
  token_days    NUMERIC,                       -- set by BadgeClaimed
  created_slot  BIGINT  NOT NULL,
  updated_slot  BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS conviction_locks_holder ON conviction_locks (holder, created_slot DESC);
CREATE INDEX IF NOT EXISTS conviction_locks_mint ON conviction_locks (mint);

CREATE TABLE IF NOT EXISTS conviction_badges (
  holder     TEXT NOT NULL,
  mint       TEXT NOT NULL,
  badge_mint TEXT NOT NULL,
  slot       BIGINT NOT NULL,
  PRIMARY KEY (holder, mint)
);

-- cross_basket: BasketCreated, SharesMinted, SharesRedeemed.
CREATE TABLE IF NOT EXISTS baskets (
  address       TEXT PRIMARY KEY,
  creator       TEXT    NOT NULL,
  share_mint    TEXT    NOT NULL,
  components    JSONB   NOT NULL,              -- [{ mint, tokenProgram, unitsPerShare }]
  minted        NUMERIC NOT NULL DEFAULT 0,    -- share atoms minted, ever
  redeemed      NUMERIC NOT NULL DEFAULT 0,
  created_slot  BIGINT  NOT NULL,
  updated_slot  BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS baskets_creator ON baskets (creator, created_slot DESC);

-- cross_listing: VenueCreated, BondDeposited, BondWithdrawn, Listed, ListingReleased, ListingSlashed.
CREATE TABLE IF NOT EXISTS listing_venues (
  venue              TEXT PRIMARY KEY,
  creator            TEXT    NOT NULL,
  bond_mint          TEXT    NOT NULL,
  min_bond           NUMERIC NOT NULL,
  release_delay_secs BIGINT  NOT NULL,
  slash_to           TEXT    NOT NULL,
  created_slot       BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS listing_venues_creator ON listing_venues (creator);

-- A bond is keyed by its account (the event names the bond and the lister, not the venue; the venue is filled in by the first listing).
CREATE TABLE IF NOT EXISTS listing_bonds (
  bond         TEXT PRIMARY KEY,
  lister       TEXT    NOT NULL,
  venue        TEXT,
  amount       NUMERIC NOT NULL DEFAULT 0,    -- the bond's total after the last deposit or withdrawal
  updated_slot BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS listing_bonds_lister ON listing_bonds (lister);

CREATE TABLE IF NOT EXISTS listing_listings (
  listing       TEXT PRIMARY KEY,
  venue         TEXT    NOT NULL,
  lister        TEXT    NOT NULL,
  cross_address TEXT    NOT NULL,
  amount        NUMERIC NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open',  -- open | released | slashed
  slashed_to    TEXT,
  created_slot  BIGINT  NOT NULL,
  settled_slot  BIGINT
);
CREATE INDEX IF NOT EXISTS listing_listings_venue ON listing_listings (venue, created_slot DESC);
CREATE INDEX IF NOT EXISTS listing_listings_cross ON listing_listings (cross_address);
CREATE INDEX IF NOT EXISTS listing_listings_open ON listing_listings (status) WHERE status = 'open';

-- cross_bounty: BountyCreated, BountyFunded, InvariantPaid, Awarded, BountyWithdrawn.
CREATE TABLE IF NOT EXISTS bounties (
  address      TEXT PRIMARY KEY,
  sponsor      TEXT    NOT NULL,
  arbiter      TEXT    NOT NULL,
  reward_mint  TEXT    NOT NULL,
  expires_at   BIGINT  NOT NULL,
  rewards      JSONB   NOT NULL,               -- eleven decimal strings, one per invariant
  funded       NUMERIC NOT NULL DEFAULT 0,
  paid         NUMERIC NOT NULL DEFAULT 0,      -- paid for invariants
  awarded      NUMERIC NOT NULL DEFAULT 0,      -- awarded by the arbiter
  withdrawn    NUMERIC NOT NULL DEFAULT 0,
  paid_mask    INTEGER NOT NULL DEFAULT 0,
  created_slot BIGINT  NOT NULL,
  updated_slot BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS bounties_sponsor ON bounties (sponsor);

CREATE TABLE IF NOT EXISTS bounty_payouts (
  bounty        TEXT     NOT NULL,
  seq_key       TEXT     NOT NULL,              -- signature:seq
  kind          TEXT     NOT NULL,              -- invariant | award
  invariant     SMALLINT,
  cross_address TEXT,
  recipient     TEXT     NOT NULL,
  amount        NUMERIC  NOT NULL,
  evidence      TEXT,
  slot          BIGINT   NOT NULL,
  PRIMARY KEY (bounty, seq_key)
);

-- cross_backing: PolicyCreated, Attested, BackingFailed.
CREATE TABLE IF NOT EXISTS backing_policies (
  policy           TEXT PRIMARY KEY,
  mint             TEXT    NOT NULL UNIQUE,
  attester         TEXT    NOT NULL,
  min_coverage_bps INTEGER NOT NULL,
  max_age_secs     BIGINT  NOT NULL,
  created_slot     BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS backing_attestations (
  mint          TEXT PRIMARY KEY,
  attester      TEXT    NOT NULL,
  backing_atoms NUMERIC NOT NULL,
  posted_ts     BIGINT  NOT NULL,
  slot          BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS backing_failures (
  mint       TEXT    NOT NULL,
  checked_ts BIGINT  NOT NULL,
  reason     SMALLINT NOT NULL,                 -- 1 missing, 2 stale, 3 short
  supply     NUMERIC NOT NULL,
  slot       BIGINT  NOT NULL,
  PRIMARY KEY (mint, checked_ts)
);

-- cross_graduate: CharterCreated, RoundStarted, VoteCast, VolumePosted, RoundFinalized, OutcomePublished, VoteWithdrawn.
CREATE TABLE IF NOT EXISTS graduation_charters (
  charter         TEXT PRIMARY KEY,
  cross_address   TEXT    NOT NULL UNIQUE,
  quorum_bps      INTEGER NOT NULL,
  window_secs     BIGINT  NOT NULL,
  min_volume      NUMERIC NOT NULL,
  volume_attester TEXT,
  created_slot    BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS graduation_rounds (
  round         TEXT PRIMARY KEY,
  cross_address TEXT     NOT NULL,
  idx           SMALLINT NOT NULL,
  closes_ts     BIGINT   NOT NULL,
  tallies       JSONB    NOT NULL DEFAULT '["0","0","0","0"]',
  locked_total  NUMERIC  NOT NULL DEFAULT 0,
  volume_quote  NUMERIC,
  finalized     BOOLEAN  NOT NULL DEFAULT false,
  passed        BOOLEAN,
  winner        SMALLINT,
  supply        NUMERIC,                         -- the live supply RoundFinalized measured the quorum against
  created_slot  BIGINT   NOT NULL,
  updated_slot  BIGINT   NOT NULL,
  UNIQUE (cross_address, idx)
);

CREATE TABLE IF NOT EXISTS graduation_votes (
  round     TEXT    NOT NULL,
  voter     TEXT    NOT NULL,
  venue     SMALLINT NOT NULL,
  amount    NUMERIC NOT NULL,                    -- locked now (zero after VoteWithdrawn)
  withdrawn BOOLEAN NOT NULL DEFAULT false,
  slot      BIGINT  NOT NULL,
  PRIMARY KEY (round, voter)
);
CREATE INDEX IF NOT EXISTS graduation_votes_voter ON graduation_votes (voter);

CREATE TABLE IF NOT EXISTS graduation_outcomes (
  outcome       TEXT PRIMARY KEY,
  cross_address TEXT     NOT NULL UNIQUE,
  venue         SMALLINT NOT NULL,
  slot          BIGINT   NOT NULL
);
