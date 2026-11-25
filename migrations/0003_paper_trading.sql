CREATE TABLE IF NOT EXISTS paper_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance REAL NOT NULL,
  equity REAL NOT NULL,
  peak_equity REAL NOT NULL,
  daily_start_equity REAL NOT NULL,
  day_key TEXT NOT NULL,
  daily_locked INTEGER NOT NULL DEFAULT 0,
  last_processed_bar INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO paper_state
  (id, balance, equity, peak_equity, daily_start_equity, day_key, daily_locked, last_processed_bar, updated_at)
VALUES (1, 10000, 10000, 10000, 10000, strftime('%Y-%m-%d','now'), 0, 0, unixepoch('now') * 1000);

CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  lots REAL NOT NULL,
  units REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  closed_at INTEGER,
  exit_price REAL,
  gross_pnl REAL,
  costs REAL,
  net_pnl REAL,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_paper_positions_closed ON paper_positions(closed_at);
CREATE TABLE IF NOT EXISTS paper_daily_reports (
  day_key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
