PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1m', '5m', '30m')),
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, timeframe, ts)
);

CREATE INDEX IF NOT EXISTS idx_market_candles_recent
  ON market_candles (symbol, timeframe, ts DESC);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('BUY', 'SELL', 'NO_TRADE')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL', 'NEUTRAL')),
  score REAL NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analyses_recent ON analyses (created_at DESC);

CREATE TABLE IF NOT EXISTS daily_risk (
  day_key TEXT PRIMARY KEY,
  day_start_equity REAL NOT NULL,
  current_equity REAL NOT NULL,
  loss_percent REAL NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  updated_at INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS macro_context (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  as_of INTEGER NOT NULL,
  source TEXT NOT NULL,
  calendar_coverage_minutes INTEGER NOT NULL,
  high_impact_event_within_minutes REAL,
  dxy_trend TEXT,
  us10y_trend TEXT,
  note TEXT
);


CREATE TABLE IF NOT EXISTS signal_alert_state (
  symbol TEXT PRIMARY KEY,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  sent_at INTEGER NOT NULL
);
