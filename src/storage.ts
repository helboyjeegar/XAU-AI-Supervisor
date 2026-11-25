import type { Candle, CandleRow, MacroContext, RiskRow, RiskStatus, Timeframe } from "./types.ts";

export async function storeCandles(db: D1Database, symbol: string, timeframe: Timeframe, candles: Candle[]): Promise<number> {
  let written = 0;
  for (let offset = 0; offset < candles.length; offset += 100) {
    const batch = candles.slice(offset, offset + 100).map((c) => db.prepare(
      `INSERT INTO market_candles (symbol, timeframe, ts, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`
    ).bind(symbol, timeframe, c.time, c.open, c.high, c.low, c.close, c.volume));
    if (batch.length) {
      await db.batch(batch);
      written += batch.length;
    }
  }
  return written;
}

export async function loadCandles(db: D1Database, symbol: string, timeframe: Timeframe, limit = 300): Promise<Candle[]> {
  const result = await db.prepare(
    `SELECT ts AS time, open, high, low, close, volume FROM market_candles
     WHERE symbol = ? AND timeframe = ? ORDER BY ts DESC LIMIT ?`
  ).bind(symbol, timeframe, limit).all<CandleRow>();
  return (result.results ?? []).reverse().map((row) => ({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }));
}

export async function saveAnalysis(db: D1Database, result: unknown & { id: string; symbol: string; generatedAt: number; verdict: string; side: string; score: number }): Promise<void> {
  await db.prepare(
    `INSERT INTO analyses (id, symbol, created_at, verdict, side, score, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(result.id, result.symbol, result.generatedAt, result.verdict, result.side, result.score, JSON.stringify(result)).run();
}

export async function latestAnalysis(db: D1Database): Promise<{ payload_json: string; created_at: number } | null> {
  return db.prepare("SELECT payload_json, created_at FROM analyses ORDER BY created_at DESC LIMIT 1").first();
}

export function tradingDayKey(timezone: string, now = new Date()): string {
  const normalizedTimezone = timezone.trim();
  if (!normalizedTimezone) throw new RangeError("An explicit IANA timezone is required for the daily risk boundary");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: normalizedTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function reserveAiRunBudget(db: D1Database, dayKey: string, maxRuns: number, now = Date.now()): Promise<boolean> {
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return false;
  const reservation = await db.prepare(
    `INSERT INTO ai_daily_budget (day_key, run_count, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(day_key) DO UPDATE SET
       run_count = ai_daily_budget.run_count + 1,
       updated_at = excluded.updated_at
     WHERE ai_daily_budget.run_count < ?
     RETURNING run_count`
  ).bind(dayKey, now, maxRuns).first<{ run_count: number }>();
  return Boolean(reservation);
}

export async function saveRiskSnapshot(db: D1Database, dayKey: string, dayStartEquity: number, currentEquity: number, maxDailyLossPercent: number, observedAt = Date.now(), maxAgeMs = 120_000): Promise<RiskStatus> {
  const lossPercent = Math.max(0, (dayStartEquity - currentEquity) / dayStartEquity * 100);
  const lockedNow = lossPercent >= maxDailyLossPercent ? 1 : 0;
  await db.prepare(
    `INSERT INTO daily_risk (day_key, day_start_equity, current_equity, loss_percent, locked, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_key) DO UPDATE SET
       current_equity=excluded.current_equity,
       loss_percent=MAX(daily_risk.loss_percent, excluded.loss_percent),
       locked=MAX(daily_risk.locked, excluded.locked),
       updated_at=excluded.updated_at
     WHERE excluded.updated_at >= daily_risk.updated_at`
  ).bind(dayKey, dayStartEquity, currentEquity, lossPercent, lockedNow, observedAt).run();
  return readRiskStatus(db, dayKey, maxDailyLossPercent, Date.now(), maxAgeMs);
}

export async function readRiskStatus(db: D1Database, dayKey: string, maxDailyLossPercent: number, now = Date.now(), maxAgeMs = 120_000): Promise<RiskStatus> {
  const row = await db.prepare("SELECT * FROM daily_risk WHERE day_key = ?").bind(dayKey).first<RiskRow>();
  if (!row) return { verified: false, locked: false, lossPercent: 0, maxDailyLossPercent, dayKey };
  return {
    verified: now >= row.updated_at && now - row.updated_at <= maxAgeMs,
    locked: row.locked === 1,
    lossPercent: row.loss_percent,
    maxDailyLossPercent,
    dayKey,
    updatedAt: row.updated_at,
  };
}

export async function deleteOldCandles(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare("DELETE FROM market_candles WHERE ts < ?").bind(olderThan).run();
}


export async function latestMacroContext(db: D1Database): Promise<MacroContext | undefined> {
  const row = await db.prepare("SELECT as_of, source, calendar_coverage_minutes, high_impact_event_within_minutes, dxy_trend, us10y_trend, note FROM macro_context WHERE id = 1").first<{
    as_of: number; source: string; calendar_coverage_minutes: number; high_impact_event_within_minutes: number | null; dxy_trend: string | null; us10y_trend: string | null; note: string | null;
  }>();
  if (!row) return undefined;
  return {
    asOf: row.as_of,
    source: row.source,
    calendarCoverageMinutes: row.calendar_coverage_minutes,
    highImpactEventWithinMinutes: row.high_impact_event_within_minutes,
    dxyTrend: row.dxy_trend === "BULLISH" || row.dxy_trend === "BEARISH" || row.dxy_trend === "NEUTRAL" ? row.dxy_trend : undefined,
    us10yTrend: row.us10y_trend === "BULLISH" || row.us10y_trend === "BEARISH" || row.us10y_trend === "NEUTRAL" ? row.us10y_trend : undefined,
    note: row.note ?? undefined,
  };
}


export async function claimSignalNotification(db: D1Database, side: "BUY" | "SELL", now: number, cooldownMs: number): Promise<boolean> {
  const claimed = await db.prepare(`INSERT INTO signal_alert_state (symbol, side, sent_at)
    VALUES ('XAUUSD', ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET side=excluded.side, sent_at=excluded.sent_at
    WHERE signal_alert_state.side != excluded.side OR signal_alert_state.sent_at <= excluded.sent_at - ?
    RETURNING symbol`).bind(side, now, cooldownMs).first<{ symbol: string }>();
  return Boolean(claimed);
}

export async function releaseSignalNotification(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM signal_alert_state WHERE symbol = 'XAUUSD' AND sent_at = ?").bind(now).run();
}

export async function deleteOldAnalyses(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare("DELETE FROM analyses WHERE created_at < ?").bind(olderThan).run();
}
