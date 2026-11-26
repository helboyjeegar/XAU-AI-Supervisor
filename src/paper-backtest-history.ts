import { storeCandles } from "./storage.ts";
import type { Candle } from "./types.ts";

const API_BASE = "https://api.sifting.io/v1/hist/commodities/XAUUSD/bars";
const PAGE_SIZE = 2_000;
const MIN_REQUEST_GAP = 10 * 60_000;
const HISTORY_MONTHS = 6;

export interface BackfillStatus {
  active: boolean;
  complete: boolean;
  pages: number;
  startAt: number;
  endAt: number;
  lastRequestAt: number;
  lastError: string | null;
}

interface BackfillRow {
  id: number;
  start_at: number;
  end_at: number;
  cursor: string | null;
  last_request_at: number;
  pages: number;
  complete: number;
  last_error: string | null;
}

export async function getBackfillStatus(db: D1Database): Promise<BackfillStatus | null> {
  const row = await db.prepare("SELECT * FROM paper_backfill_state WHERE id=1").first<BackfillRow>();
  if (!row) return null;
  return {
    active: row.complete === 0,
    complete: row.complete === 1,
    pages: row.pages,
    startAt: row.start_at,
    endAt: row.end_at,
    lastRequestAt: row.last_request_at,
    lastError: row.last_error,
  };
}

/** Fetches one historical 1m page at most every ten minutes. It never changes live-feed watermarks. */
export async function backfillPaperHistory(db: D1Database, apiKey: string | undefined, now = Date.now()): Promise<BackfillStatus | null> {
  if (!apiKey) return null;
  let state = await db.prepare("SELECT * FROM paper_backfill_state WHERE id=1").first<BackfillRow>();
  if (!state) {
    const endAt = Math.floor(now / 60_000) * 60_000;
    const current = new Date(endAt);\n    const startAt = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - HISTORY_MONTHS, 1);
    await db.prepare(`INSERT OR IGNORE INTO paper_backfill_state
      (id,start_at,end_at,cursor,last_request_at,pages,complete,last_error)
      VALUES(1,?,?,NULL,0,0,0,NULL)`).bind(startAt,endAt).run();
    state = await db.prepare("SELECT * FROM paper_backfill_state WHERE id=1").first<BackfillRow>();
  }
  if (!state) throw new Error("Could not initialize historical backfill state");
  if (state.complete === 1 || now - state.last_request_at < MIN_REQUEST_GAP) return getBackfillStatus(db);

  const reservation = await db.prepare(
    "UPDATE paper_backfill_state SET last_request_at=? WHERE id=1 AND complete=0 AND last_request_at<=?",
  ).bind(now, now - MIN_REQUEST_GAP).run();
  if ((reservation.meta?.changes ?? 0) === 0) return getBackfillStatus(db);

  try {
    const url = new URL(API_BASE);
    url.searchParams.set("start", new Date(state.start_at).toISOString());
    url.searchParams.set("end", new Date(state.end_at).toISOString());
    url.searchParams.set("interval", "1m");
    url.searchParams.set("order", "asc");
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (state.cursor) url.searchParams.set("cursor", state.cursor);

    const response = await fetch(url.toString(), {
      headers: { "X-API-Key": apiKey, "Accept": "application/json", "Accept-Encoding": "gzip" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("SiftingIO historical backfill failed (HTTP " + response.status + ")");
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("meta" in payload) || !("data" in payload)) {
      throw new Error("Invalid SiftingIO historical response envelope");
    }
    const envelope = payload as {
      meta?: { symbol?: unknown; interval?: unknown; next_cursor?: unknown };
      data?: unknown;
    };
    if (envelope.meta?.symbol !== "XAUUSD" || envelope.meta?.interval !== "1m" || !Array.isArray(envelope.data)) {
      throw new Error("SiftingIO returned an unexpected symbol, timeframe, or data shape");
    }

    const byTime = new Map<number, Candle>();
    for (const item of envelope.data) {
      if (typeof item !== "object" || item === null) continue;
      const bar = item as Record<string, unknown>;
      const values = [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v];
      if (values.some(v => typeof v !== "number" || !Number.isFinite(v))) continue;
      const [time, open, high, low, close, volume] = values as number[];
      if (!Number.isSafeInteger(time) || time < state.start_at || time >= state.end_at) continue;
      if (open <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high) || close <= 0 || volume < 0) continue;
      byTime.set(time, { time, open, high, low, close, volume });
    }
    const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (candles.length) await storeCandles(db, "XAUUSD", "1m", candles);

    const next = typeof envelope.meta.next_cursor === "string" && envelope.meta.next_cursor.length
      ? envelope.meta.next_cursor : null;
    await db.prepare(`UPDATE paper_backfill_state SET cursor=?,pages=pages+1,complete=?,last_error=NULL
      WHERE id=1`).bind(next, next === null ? 1 : 0).run();
    return getBackfillStatus(db);
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown historical backfill error").slice(0, 400);
    await db.prepare("UPDATE paper_backfill_state SET last_error=? WHERE id=1").bind(message).run();
    throw error;
  }
}
