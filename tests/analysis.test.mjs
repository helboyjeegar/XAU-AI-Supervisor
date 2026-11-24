import test from "node:test";
import assert from "node:assert/strict";
import { ema, rsiSeries, snapshot } from "../src/indicators.ts";
import { analyzeMarket } from "../src/analysis.ts";

function makeCandles(count, stepMs, start = 1_800_000_000_000, startPrice = 2000, drift = 0.15) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice + i * drift + Math.sin(i / 3) * 0.15;
    const open = close - drift * 0.45;
    rows.push({ time: start + i * stepMs, open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume: 100 + (i % 7) * 10 });
  }
  return rows;
}

test("EMA returns null until enough observations exist", () => {
  assert.equal(ema([1, 2], 3), null);
  assert.equal(ema([1, 2, 3], 3), 2);
});

test("Wilder RSI produces bounded readings after warm-up", () => {
  const result = rsiSeries(Array.from({ length: 40 }, (_, i) => 100 + i));
  assert.equal(result.length, 40);
  assert.equal(result[13], null);
  assert.equal(result[39], 100);
});

test("snapshot requires enough bars and returns a valid trend", () => {
  assert.equal(snapshot(makeCandles(30, 60_000), "1m"), null);
  const result = snapshot(makeCandles(80, 60_000), "1m");
  assert.ok(result);
  assert.equal(result.trend, "BULLISH");
});

test("analysis fails closed when risk is not verified", () => {
  const now = 1_800_000_000_000 + 80 * 60_000;
  const result = analyzeMarket({
    oneMinute: makeCandles(100, 60_000, now - 99 * 60_000),
    fiveMinute: makeCandles(100, 5 * 60_000, now - 99 * 5 * 60_000),
    thirtyMinute: makeCandles(100, 30 * 60_000, now - 99 * 30 * 60_000),
    risk: { verified: false, locked: false, lossPercent: 0, maxDailyLossPercent: 5 },
    now,
    minRiskReward: 1.5,
    stopAtrMultiplier: 1.2,
    minScore: 75,
    highImpactBlockMinutes: 15,
  });
  assert.equal(result.verdict, "NO_TRADE");
  assert.ok(result.blockers.some((item) => item.includes("تأیید نشده")));
  assert.equal(result.entry, null);
});

test("all three timeframe snapshots are included when data is sufficient", () => {
  const now = 1_800_000_000_000 + 80 * 60_000;
  const result = analyzeMarket({
    oneMinute: makeCandles(100, 60_000, now - 99 * 60_000),
    fiveMinute: makeCandles(100, 5 * 60_000, now - 99 * 5 * 60_000),
    thirtyMinute: makeCandles(100, 30 * 60_000, now - 99 * 30 * 60_000),
    risk: { verified: true, locked: false, lossPercent: 0, maxDailyLossPercent: 5 },
    now,
    minRiskReward: 1.5,
    stopAtrMultiplier: 1.2,
    minScore: 75,
    highImpactBlockMinutes: 15,
  });
  assert.ok(result.timeframes["1m"]);
  assert.ok(result.timeframes["5m"]);
  assert.ok(result.timeframes["30m"]);
  assert.equal(result.scoreMeaning, "EVIDENCE_SCORE_NOT_PROBABILITY");
});


test("fresh macro context with an imminent high-impact event vetoes analysis", () => {
  const now = 1_800_000_000_000 + 80 * 60_000;
  const result = analyzeMarket({
    oneMinute: makeCandles(100, 60_000, now - 99 * 60_000),
    fiveMinute: makeCandles(100, 5 * 60_000, now - 99 * 5 * 60_000),
    thirtyMinute: makeCandles(100, 30 * 60_000, now - 99 * 30 * 60_000),
    macro: { source: "test-calendar", asOf: now, calendarCoverageMinutes: 180, highImpactEventWithinMinutes: 5, dxyTrend: "NEUTRAL" },
    risk: { verified: true, locked: false, lossPercent: 0, maxDailyLossPercent: 5 },
    now, minRiskReward: 1.5, stopAtrMultiplier: 1.2, minScore: 75, highImpactBlockMinutes: 15, macroMaxAgeMinutes: 30,
  });
  assert.equal(result.verdict, "NO_TRADE");
  assert.ok(result.blockers.some((item) => item.includes("خبر مهم")));
});

test("stale macro context vetoes analysis", () => {
  const now = 1_800_000_000_000 + 80 * 60_000;
  const result = analyzeMarket({
    oneMinute: makeCandles(100, 60_000, now - 99 * 60_000),
    fiveMinute: makeCandles(100, 5 * 60_000, now - 99 * 5 * 60_000),
    thirtyMinute: makeCandles(100, 30 * 60_000, now - 99 * 30 * 60_000),
    macro: { source: "test-calendar", asOf: now - 60 * 60_000, calendarCoverageMinutes: 180, highImpactEventWithinMinutes: null },
    risk: { verified: true, locked: false, lossPercent: 0, maxDailyLossPercent: 5 },
    now, minRiskReward: 1.5, stopAtrMultiplier: 1.2, minScore: 75, highImpactBlockMinutes: 15, macroMaxAgeMinutes: 30,
  });
  assert.equal(result.verdict, "NO_TRADE");
  assert.ok(result.blockers.some((item) => item.includes("زمینه کلان")));
});
