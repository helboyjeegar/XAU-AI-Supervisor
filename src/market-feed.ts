import { loadCandles, storeCandles } from "./storage.ts";
import type { Candle, Timeframe } from "./types.ts";

const API_BASE = "https://api.sifting.io/v1/hist/commodities/XAUUSD/bars";
const PROVIDER = "siftingio";
const FETCH_INTERVAL_MS = 4 * 60_000;
const MAX_AS_OF_AGE_MS = 5 * 60_000;
const MAX_BAR_AGE_MS = 3 * 60_000;
const M1_MS = 60_000;
const REQUEST_BAR_LIMIT = 2_000;

interface SiftingBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface SiftingPayload {
  data?: unknown;
  meta?: {
    symbol?: unknown;
    interval?: unknown;
    as_of?: unknown;
  };
}

export interface ParsedSiftingBars {
  candles: Candle[];
  asOf: number;
}

export interface MarketFeedResult {
  configured: boolean;
  skipped: boolean;
  received: number;
  stored: number;
  latestBarAt?: number;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSiftingBars(payload: unknown, now = Date.now()): ParsedSiftingBars {
  if (!isRecord(payload) || !isRecord(payload.meta) || !Array.isArray(payload.data)) {
    throw new Error("SiftingIO response has an invalid JSON envelope");
  }

  if (payload.meta.symbol !== "XAUUSD" || payload.meta.interval !== "1m") {
    throw new Error("SiftingIO returned a different symbol or timeframe");
  }

  const asOf = typeof payload.meta.as_of === "string" ? Date.parse(payload.meta.as_of) : NaN;
  if (
    !Number.isFinite(asOf) ||
    asOf > now + 60_000 ||
    now - asOf > MAX_AS_OF_AGE_MS
  ) {
    throw new Error("SiftingIO historical response timestamp is missing or stale");
  }

  const byTime = new Map<number, Candle>();
  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    const row = item as unknown as SiftingBar;
    const values = [row.t, row.o, row.h, row.l, row.c, row.v];
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) continue;
    if (!Number.isInteger(row.t) || row.t <= 0) continue;
    if (row.t + M1_MS > now) continue; // Only fully closed one-minute candles.
    if (
      row.o <= 0 || row.h <= 0 || row.l <= 0 || row.c <= 0 || row.v < 0 ||
      row.h < Math.max(row.o, row.c, row.l) ||
      row.l > Math.min(row.o, row.c, row.h)
    ) continue;

    byTime.set(row.t, {
      time: row.t,
      open: row.o,
      high: row.h,
      low: row.l,
      close: row.c,
      volume: row.v,
    });
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (candles.length === 0) {
    throw new Error("SiftingIO returned no completed XAUUSD one-minute candles");
  }

  const newest = candles[candles.length - 1]!;
  if (now - newest.time > MAX_BAR_AGE_MS) {
    throw new Error("Latest SiftingIO XAUUSD one-minute candle is stale");
  }

  return { candles, asOf };
}

export function resampleCandles(oneMinute: Candle[], timeframe: "5m" | "30m"): Candle[] {
  const periodMinutes = timeframe === "5m" ? 5 : 30;
  const periodMs = periodMinutes * M1_MS;
  const sorted = [...oneMinute].sort((a, b) => a.time - b.time);
  const groups = new Map<number, Candle[]>();

  for (const candle of sorted) {
    const bucketStart = Math.floor(candle.time / periodMs) * periodMs;
    const group = groups.get(bucketStart) ?? [];
    group.push(candle);
    groups.set(bucketStart, group);
  }

  const result: Candle[] = [];
  for (const [bucketStart, group] of groups) {
    group.sort((a, b) => a.time - b.time);
    if (group.length !== periodMinutes) continue;

    const complete = group.every((candle, index) => candle.time === bucketStart + index * M1_MS);
    if (!complete) continue;

    const first = group[0]!;
    const last = group[group.length - 1]!;
    result.push({
      time: bucketStart,
      open: first.open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: last.close,
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
    });
  }

  return result.sort((a, b) => a.time - b.time);
}

async function latestCandleTime(
  db: D1Database,
  timeframe: Timeframe,
): Promise<number | null> {
  const candles = await loadCandles(db, "XAUUSD", timeframe, 1);
  return candles.at(-1)?.time ?? null;
}

async function reservePoll(db: D1Database, now: number): Promise<boolean> {
  await db.prepare(
    "INSERT OR IGNORE INTO market_feed_state (provider, last_attempt_at, last_success_at, last_bar_at, last_error) VALUES (?, 0, NULL, NULL, NULL)",
  ).bind(PROVIDER).run();

  const result = await db.prepare(
    "UPDATE market_feed_state SET last_attempt_at = ? WHERE provider = ? AND last_attempt_at <= ?",
  ).bind(now, PROVIDER, now - FETCH_INTERVAL_MS).run();

  return (result.meta?.changes ?? 0) > 0;
}

async function recordFailure(db: D1Database, message: string): Promise<void> {
  const safeMessage = message.slice(0, 400);
  await db.prepare(
    "UPDATE market_feed_state SET last_error = ? WHERE provider = ?",
  ).bind(safeMessage, PROVIDER).run();
}

export async function refreshSiftingMarketData(
  db: D1Database,
  apiKey: string | undefined,
  now = Date.now(),
): Promise<MarketFeedResult> {
  if (!apiKey) {
    return { configured: false, skipped: true, received: 0, stored: 0, reason: "SIFTING_API_KEY is not configured" };
  }

  const reserved = await reservePoll(db, now);
  if (!reserved) {
    return { configured: true, skipped: true, received: 0, stored: 0, reason: "Polling interval has not elapsed" };
  }

  try {
    const [lastM1, lastM5, lastM30] = await Promise.all([
      latestCandleTime(db, "1m"),
      latestCandleTime(db, "5m"),
      latestCandleTime(db, "30m"),
    ]);

    const endMs = Math.floor(now / M1_MS) * M1_MS - 1;
    const initialStartMs = endMs - (REQUEST_BAR_LIMIT - 1) * M1_MS;
    const startMs = lastM1 === null
      ? initialStartMs
      : Math.max(initialStartMs, lastM1 - M1_MS);

    const url = new URL(API_BASE);
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(endMs).toISOString());
    url.searchParams.set("interval", "1m");
    url.searchParams.set("order", "desc");
    url.searchParams.set("limit", String(REQUEST_BAR_LIMIT));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new Error("SiftingIO rejected the API key (HTTP 401)");
      if (status === 403) throw new Error("SiftingIO key does not have the commodities market entitlement (HTTP 403)");
      if (status === 429) throw new Error("SiftingIO monthly or per-minute API quota was reached (HTTP 429)");
      throw new Error("SiftingIO market data request failed (HTTP " + status + ")");
    }

    const payload: unknown = await response.json();
    const parsed = parseSiftingBars(payload, now);
    const writtenM1 = await storeCandles(db, "XAUUSD", "1m", parsed.candles);

    const history = await loadCandles(db, "XAUUSD", "1m", REQUEST_BAR_LIMIT);
    const fiveMinute = resampleCandles(history, "5m").filter((candle) => lastM5 === null || candle.time > lastM5);
    const thirtyMinute = resampleCandles(history, "30m").filter((candle) => lastM30 === null || candle.time > lastM30);

    const [writtenM5, writtenM30] = await Promise.all([
      storeCandles(db, "XAUUSD", "5m", fiveMinute),
      storeCandles(db, "XAUUSD", "30m", thirtyMinute),
    ]);

    const latestBarAt = parsed.candles.at(-1)!.time;
    await db.prepare(
      "UPDATE market_feed_state SET last_success_at = ?, last_bar_at = ?, last_error = NULL WHERE provider = ?",
    ).bind(now, latestBarAt, PROVIDER).run();

    return {
      configured: true,
      skipped: false,
      received: parsed.candles.length,
      stored: writtenM1 + writtenM5 + writtenM30,
      latestBarAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SiftingIO market data error";
    try { await recordFailure(db, message); } catch { /* preserve original provider error */ }
    console.error("SiftingIO market data refresh failed:", message);
    return { configured: true, skipped: false, received: 0, stored: 0, reason: message };
  }
}
