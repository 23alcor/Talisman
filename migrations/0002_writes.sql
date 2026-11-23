-- The write queue: every AI write waits here until the applier on the vault machine writes it into the vault.
CREATE TABLE writes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- apply order
  id TEXT NOT NULL UNIQUE,                -- write_id given to the AI
  kind TEXT NOT NULL,                     -- 'session' (log_session) or 'note' (create_note)
  key TEXT NOT NULL,                      -- what it writes: 'session:<session_id>' or 'note:<lowercased path>'
  revision INTEGER NOT NULL DEFAULT 1,    -- sessions: 1, 2, 3… as the AI updates the same session
  payload TEXT NOT NULL,                  -- JSON the applier turns into Markdown
  source TEXT,                            -- which AI or app sent it
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | applying | saved | failed | superseded
  lease_until INTEGER,                    -- while applying: when the claim expires (ms)
  attempts INTEGER NOT NULL DEFAULT 0,
  path TEXT,                              -- where it landed in the vault
  error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX writes_status ON writes (status, seq);
CREATE UNIQUE INDEX writes_key ON writes (key, revision);
