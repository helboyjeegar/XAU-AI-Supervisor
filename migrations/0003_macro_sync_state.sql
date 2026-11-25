CREATE TABLE IF NOT EXISTS macro_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at INTEGER NOT NULL,
  retry_after_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
