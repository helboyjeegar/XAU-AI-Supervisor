CREATE TABLE IF NOT EXISTS paper_trade_notifications (
  position_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_trade_notifications_pending
ON paper_trade_notifications(sent_at, created_at);