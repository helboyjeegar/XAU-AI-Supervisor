CREATE TABLE IF NOT EXISTS ai_daily_budget (
  day_key TEXT PRIMARY KEY,
  run_count INTEGER NOT NULL CHECK (run_count >= 0),
  updated_at INTEGER NOT NULL
);
