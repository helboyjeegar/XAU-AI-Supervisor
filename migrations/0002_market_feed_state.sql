CREATE TABLE IF NOT EXISTS market_feed_state (
  provider TEXT PRIMARY KEY,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_bar_at INTEGER,
  last_error TEXT
);
