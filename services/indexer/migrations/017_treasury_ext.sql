-- The treasury extension (programs/treasury, ADR-0470 to ADR-0476): what its events project onto. Additive and optional: a treasury that
-- was never extended has no rows here and its columns in `treasuries` keep their defaults. Idempotent.

ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS extended            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS governance          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS nav_enabled         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS revenue_enabled     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS disclosure_enabled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS assignment_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS wind_down_enabled   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS assigned            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS proposals_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS grants_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS staked_total        NUMERIC NOT NULL DEFAULT 0;   -- coins staked now (last Staked / Unstaked event)
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS distributed_total   NUMERIC NOT NULL DEFAULT 0;   -- quote deposited for stakers, ever
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS distribution_claimed NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS nav_burned          NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS nav_paid            NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS nav_open            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS rounds_paid         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS rounds_missed       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS tranche_released    NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS disclosures         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS last_disclosure_at  BIGINT;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS disclosure_request_since BIGINT;
ALTER TABLE treasuries ADD COLUMN IF NOT EXISTS swept               NUMERIC;                      -- null until the wind-down sweep

CREATE TABLE IF NOT EXISTS treasury_proposals (
  proposal      TEXT PRIMARY KEY,
  treasury      TEXT    NOT NULL,
  id            NUMERIC NOT NULL,
  proposer      TEXT    NOT NULL,
  kind          SMALLINT NOT NULL,           -- 0 Spend, 1 OpenNav, 2 CloseNav
  amount        NUMERIC NOT NULL,
  destination   TEXT    NOT NULL,
  vote_end_ts   BIGINT  NOT NULL,
  yes           NUMERIC NOT NULL DEFAULT 0,
  no            NUMERIC NOT NULL DEFAULT 0,
  executed      BOOLEAN NOT NULL DEFAULT false,
  created_slot  BIGINT  NOT NULL,
  executed_slot BIGINT,
  UNIQUE (treasury, id)
);

-- Coins a voter has locked behind a proposal (Voted adds, VoteReclaimed releases).
CREATE TABLE IF NOT EXISTS treasury_votes (
  proposal  TEXT NOT NULL,
  voter     TEXT NOT NULL,
  yes       NUMERIC NOT NULL DEFAULT 0,
  no        NUMERIC NOT NULL DEFAULT 0,
  reclaimed BOOLEAN NOT NULL DEFAULT false,
  last_slot BIGINT NOT NULL,
  PRIMARY KEY (proposal, voter)
);

-- Stakers: what each owner has staked now and has claimed in all.
CREATE TABLE IF NOT EXISTS treasury_stakers (
  treasury  TEXT NOT NULL,
  owner     TEXT NOT NULL,
  staked    NUMERIC NOT NULL DEFAULT 0,
  claimed   NUMERIC NOT NULL DEFAULT 0,
  last_slot BIGINT NOT NULL,
  PRIMARY KEY (treasury, owner)
);

CREATE TABLE IF NOT EXISTS treasury_grants (
  grant_address TEXT PRIMARY KEY,
  treasury      TEXT    NOT NULL,
  id            NUMERIC NOT NULL,
  beneficiary   TEXT    NOT NULL,
  total         NUMERIC NOT NULL,
  lockup_end    BIGINT  NOT NULL,
  expiry_ts     BIGINT  NOT NULL,
  released      NUMERIC NOT NULL DEFAULT 0,
  burned        NUMERIC,                      -- null until the grant expires
  created_slot  BIGINT  NOT NULL,
  UNIQUE (treasury, id)
);

CREATE TABLE IF NOT EXISTS treasury_rounds (
  treasury  TEXT    NOT NULL,
  round     NUMERIC NOT NULL,
  status    TEXT    NOT NULL,                 -- paid | missed
  revenue   NUMERIC,
  due       NUMERIC,
  payer     TEXT,
  tranche   NUMERIC,
  slot      BIGINT  NOT NULL,
  PRIMARY KEY (treasury, round)
);
