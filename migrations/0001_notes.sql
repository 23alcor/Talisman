-- The read mirror: a copy of the owner's Markdown vault, pushed by the sync client (PUT /api/sync/notes) and read
-- by the connector's tools. The vault itself stays the source of truth; this table can always be rebuilt from it.
CREATE TABLE IF NOT EXISTS notes (
  path       TEXT PRIMARY KEY,          -- 'Folder/Sub/Note.md', relative to the vault root
  title      TEXT NOT NULL,
  folder     TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',  -- space-separated
  updated_at TEXT,                      -- local wall-clock 'YYYY-MM-DDTHH:MM'
  hash       TEXT,                      -- content hash from the sync client, so it only resends changed notes
  body       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notes_updated ON notes (updated_at);

-- Small key/value store (last sync time and similar).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Wrong passwords on the login page, per IP, for a short lockout.
CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_ip ON auth_failures (ip, at);
