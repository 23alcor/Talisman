-- Captured chats from coding agents: one row per chat, updated as the chat grows, summarized once it goes quiet.
CREATE TABLE captures (
  id TEXT PRIMARY KEY,                        -- capture_id from the hook, stable for one chat
  source TEXT,                                -- claude-code, codex…
  cwd TEXT,                                   -- where the agent was working
  transcript TEXT NOT NULL,                   -- cleaned text: user and assistant words only
  started_at TEXT,
  ended_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,        -- +1 each time the transcript grows
  summarized_rev INTEGER NOT NULL DEFAULT 0,  -- the revision the last summary covered
  final INTEGER NOT NULL DEFAULT 0,           -- the agent said the chat ended
  quiet_until INTEGER,                        -- summarize after this (ms)
  status TEXT NOT NULL DEFAULT 'waiting',     -- waiting | summarizing | done | error
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX captures_due ON captures (status, quiet_until);
