CREATE TABLE IF NOT EXISTS paper_backtest_monthly (
  month TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  result_json TEXT NOT NULL
);
