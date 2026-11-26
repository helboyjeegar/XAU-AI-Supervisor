CREATE TABLE IF NOT EXISTS paper_backfill_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  cursor TEXT,
  last_request_at INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  last_error TEXT
);
