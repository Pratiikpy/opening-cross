-- The open preset registry (PRODUCT_FEATURES L2, X15): signed presets, and which crosses used which.

CREATE TABLE IF NOT EXISTS presets (
  author     TEXT        NOT NULL,
  preset_id  TEXT        NOT NULL,
  version    INTEGER     NOT NULL,
  doc_id     TEXT        NOT NULL UNIQUE,     -- the signed document's own id
  doc        JSONB       NOT NULL,            -- the signed document, verbatim
  created_at BIGINT      NOT NULL,            -- the author's own date inside the document
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (author, preset_id, version)
);

-- A cross whose creation transaction was read: the preset its memo named, or none. Read once; the memo never changes.
CREATE TABLE IF NOT EXISTS preset_uses (
  cross_address TEXT PRIMARY KEY,
  author        TEXT,
  preset_id     TEXT,
  version       INTEGER,
  signature     TEXT        NOT NULL,         -- the creation transaction
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS preset_uses_preset ON preset_uses (author, preset_id, version);
