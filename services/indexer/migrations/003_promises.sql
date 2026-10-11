-- Signed promises, their grades and the on-chain anchors that bound them in time. Promises are
-- append-only; a grade may move from UNRESOLVED to a final status once, never afterwards.

CREATE TABLE IF NOT EXISTS promises (
  id            TEXT PRIMARY KEY,                -- sha-256 of the canonical body
  cluster       TEXT   NOT NULL,
  cross_address TEXT   NOT NULL,
  bucket        SMALLINT NOT NULL,
  issued_at     BIGINT NOT NULL,                 -- cluster seconds
  deadline      BIGINT NOT NULL,
  signer        TEXT   NOT NULL,
  signature     TEXT   NOT NULL,
  body          JSONB  NOT NULL,                 -- the promise including its id
  inputs        JSONB  NOT NULL                  -- the canonical book behind inputsHash
);
CREATE INDEX IF NOT EXISTS promises_cross ON promises (cross_address, issued_at);
CREATE INDEX IF NOT EXISTS promises_cluster_time ON promises (cluster, issued_at);

CREATE TABLE IF NOT EXISTS promise_grades (
  promise_id    TEXT PRIMARY KEY REFERENCES promises(id),
  status        TEXT   NOT NULL,                 -- HIT | MISS | SCORED | VOID | UNRESOLVED
  reason        TEXT,
  outcome_tick  INTEGER,
  error_ticks   INTEGER,
  interval_score NUMERIC,
  graded_at     BIGINT NOT NULL,
  outcome_at    BIGINT                           -- cluster time the outcome became observable
);

CREATE TABLE IF NOT EXISTS promise_anchors (
  id         BIGSERIAL PRIMARY KEY,
  cluster    TEXT   NOT NULL,
  root       TEXT   NOT NULL,
  count      INTEGER NOT NULL,
  signature  TEXT   NOT NULL,                    -- transaction carrying the memo
  slot       BIGINT,
  block_time BIGINT,
  UNIQUE (cluster, root)
);

CREATE TABLE IF NOT EXISTS promise_anchor_members (
  anchor_id  BIGINT NOT NULL REFERENCES promise_anchors(id),
  promise_id TEXT   NOT NULL REFERENCES promises(id),
  PRIMARY KEY (anchor_id, promise_id)
);
CREATE INDEX IF NOT EXISTS promise_anchor_members_promise ON promise_anchor_members (promise_id);
