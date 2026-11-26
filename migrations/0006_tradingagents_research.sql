CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DISABLED', 'BLOCKED', 'COMPLETED', 'FAILED')),
  verdict TEXT NOT NULL CHECK (verdict IN ('BUY', 'SELL', 'NO_TRADE')),
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_runs_recent ON research_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS research_evidence (
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of INTEGER NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, evidence_id),
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_research_evidence_run ON research_evidence (run_id, as_of);

CREATE TABLE IF NOT EXISTS specialist_reports (
  run_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('macro', 'quant', 'risk')),
  generated_at INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
  veto INTEGER NOT NULL CHECK (veto IN (0, 1)),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, agent),
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);
