ALTER TABLE paper_positions ADD COLUMN balance_at_entry REAL NOT NULL DEFAULT 10000;
ALTER TABLE paper_positions ADD COLUMN close_notified_at INTEGER;
