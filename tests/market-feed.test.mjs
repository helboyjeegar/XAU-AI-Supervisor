import test from "node:test";
import assert from "node:assert/strict";
import { parseSiftingBars, resampleCandles } from "../src/market-feed.ts";

const now = Date.parse("2026-11-25T12:05:30.000Z");

test("SiftingIO parser validates XAUUSD 1m bars, sorts them and excludes an open minute", () => {
  const payload = {
    meta: {
      symbol: "XAUUSD",
      interval: "1m",
      as_of: "2026-11-25T12:05:20.000Z",
      next_cursor: "opaque",
    },
    data: [
      { t: Date.parse("2026-11-25T12:04:00.000Z"), o: 2650.2, h: 2651.0, l: 2649.8, c: 2650.7, v: 18 },
      { t: Date.parse("2026-11-25T12:03:00.000Z"), o: 2649.7, h: 2650.6, l: 2649.3, c: 2650.2, v: 14 },
      { t: Date.parse("2026-11-25T12:05:00.000Z"), o: 2650.7, h: 2651.2, l: 2650.5, c: 2651.0, v: 3 },
    ],
  };

  const parsed = parseSiftingBars(payload, now);
  assert.equal(parsed.candles.length, 2);
  assert.equal(parsed.candles[0].time, Date.parse("2026-11-25T12:03:00.000Z"));
  assert.equal(parsed.candles[1].time, Date.parse("2026-11-25T12:04:00.000Z"));
  assert.equal(parsed.asOf, Date.parse("2026-11-25T12:05:20.000Z"));
});

test("SiftingIO parser rejects wrong symbol, stale response, stale bars and bad OHLC", () => {
  const base = {
    meta: { symbol: "XAUUSD", interval: "1m", as_of: "2026-11-25T12:05:20.000Z" },
    data: [
      { t: Date.parse("2026-11-25T12:04:00.000Z"), o: 2650, h: 2652, l: 2649, c: 2651, v: 10 },
    ],
  };

  assert.throws(
    () => parseSiftingBars({ ...base, meta: { ...base.meta, symbol: "EURUSD" } }, now),
    /different symbol or timeframe/,
  );
  assert.throws(
    () => parseSiftingBars({ ...base, meta: { ...base.meta, as_of: "2026-11-25T11:50:00.000Z" } }, now),
    /response timestamp is missing or stale/,
  );
  assert.throws(
    () => parseSiftingBars({ ...base, meta: { ...base.meta, as_of: "2026-11-25T12:11:50.000Z" } }, Date.parse("2026-11-25T12:12:00.000Z")),
    /Latest SiftingIO XAUUSD one-minute candle is stale/,
  );
  assert.throws(
    () => parseSiftingBars({
      ...base,
      data: [{ t: Date.parse("2026-11-25T12:04:00.000Z"), o: 2650, h: 2648, l: 2649, c: 2651, v: 10 }],
    }, now),
    /no completed XAUUSD one-minute candles/,
  );
});

test("SiftingIO parser rejects missing response metadata and incomplete-only payloads", () => {
  assert.throws(() => parseSiftingBars({ data: [] }, now), /invalid JSON envelope/);
  assert.throws(() => parseSiftingBars({
    meta: { symbol: "XAUUSD", interval: "1m", as_of: "2026-11-25T12:05:20.000Z" },
    data: [{ t: Date.parse("2026-11-25T12:05:00.000Z"), o: 1, h: 2, l: 1, c: 2, v: 1 }],
  }, now), /no completed XAUUSD one-minute candles/);
});


test("SiftingIO parser accepts a completed bar delayed by the four-minute polling cadence", () => {
  const payload = {
    meta: { symbol: "XAUUSD", interval: "1m", as_of: "2026-11-25T12:10:20.000Z" },
    data: [
      { t: Date.parse("2026-11-25T12:04:00.000Z"), o: 2650, h: 2652, l: 2649, c: 2651, v: 10 },
    ],
  };
  const parsed = parseSiftingBars(payload, Date.parse("2026-11-25T12:10:30.000Z"));
  assert.equal(parsed.candles.length, 1);
  assert.equal(parsed.candles[0].time, Date.parse("2026-11-25T12:04:00.000Z"));
});

test("resampler creates accurate complete 5m and 30m OHLCV candles", () => {
  const start = Date.parse("2026-11-25T12:00:00.000Z");
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: start + index * 60_000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: index + 1,
  }));

  const five = resampleCandles(candles, "5m");
  assert.equal(five.length, 6);
  assert.equal(five[0].time, start);
  assert.equal(five[0].open, 100);
  assert.equal(five[0].high, 106);
  assert.equal(five[0].low, 99);
  assert.equal(five[0].close, 105);
  assert.equal(five[0].volume, 15);

  const thirty = resampleCandles(candles, "30m");
  assert.equal(thirty.length, 1);
  assert.equal(thirty[0].open, 100);
  assert.equal(thirty[0].high, 131);
  assert.equal(thirty[0].low, 99);
  assert.equal(thirty[0].close, 130);
  assert.equal(thirty[0].volume, 465);
});

test("resampler ignores buckets with missing minutes or incomplete groups", () => {
  const start = Date.parse("2026-11-25T12:00:00.000Z");
  const candles = Array.from({ length: 10 }, (_, index) => ({
    time: start + index * 60_000,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1,
  })).filter((candle) => candle.time !== start + 2 * 60_000);

  const five = resampleCandles(candles, "5m");
  assert.equal(five.length, 1);
  assert.equal(five[0].time, start + 5 * 60_000);
  assert.equal(five[0].volume, 5);

  assert.equal(resampleCandles(candles.slice(0, 9), "30m").length, 0);
});
