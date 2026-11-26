import test from "node:test";
import assert from "node:assert/strict";
import { formatAnalysis, formatStatus, parseRiskCommand } from "../src/telegram.ts";

test("parses a manual risk snapshot", () => {
  assert.deepEqual(parseRiskCommand("/risk 10000 9950"), {
    dayStartEquity: 10000,
    currentEquity: 9950,
  });
});

test("parses grouped and bot-addressed amounts", () => {
  assert.deepEqual(parseRiskCommand("/risk@XAU_AI_Supervisor_Test_bot 10,000 9,950.25"), {
    dayStartEquity: 10000,
    currentEquity: 9950.25,
  });
});

test("rejects malformed, missing, zero and excessive values", () => {
  for (const value of [
    "/risk",
    "/risk 10000",
    "/risk 10000 -5",
    "/risk 0 9000",
    "/risk 10000 9e3",
    "/risk 10000 9000 extra",
    "/status 10000 9000",
    "/risk 10000.12345 9000",
    "/risk 1000000001 9000",
  ]) assert.equal(parseRiskCommand(value), null, value);
});

test("status distinguishes stale risk snapshots from fresh manual snapshots", () => {
  const stale = formatStatus({
    verified: false, locked: false, lossPercent: 0, maxDailyLossPercent: 5,
    updatedAt: Date.now() - 5 * 60_000,
  });
  assert.match(stale, /snapshot قدیمی یا نامعتبر است/);

  const fresh = formatStatus({
    verified: true, locked: false, lossPercent: 0, maxDailyLossPercent: 5,
    updatedAt: Date.now(),
  });
  assert.match(fresh, /بدون تأیید مستقل بروکر/);
});

test("unknown prop reset timezone is visibly fail-closed", () => {
  const status = formatStatus({
    verified: false, locked: true, lossPercent: 0, maxDailyLossPercent: 5,
    timezoneConfigured: false,
  });
  assert.match(status, /منطقه زمانی ریست روزانه مشخص نشده/);
  assert.match(status, /قفل روزانه: فعال/);
});

test("signal messages identify the reference candle, source and non-executable price", () => {
  const at = Date.UTC(2026, 10, 26, 16, 19, 0);
  const message = formatAnalysis({
    id: "test-run", researchRunId: "test-run", researchStatus: "COMPLETED",
    evidenceIds: ["e1"], symbol: "XAUUSD", generatedAt: at,
    marketDataSource: "SiftingIO XAUUSD reference feed", entryReferenceAt: at,
    verdict: "BUY", side: "BUY", score: 100, scoreMeaning: "EVIDENCE_SCORE_NOT_PROBABILITY",
    entry: 3576.95, stopLoss: 3575.31, takeProfit: 3579.41, riskReward: 1.5,
    reasons: ["Evidence supports an upward candidate"], blockers: [], warnings: [],
    agents: [], timeframes: {},
  });
  assert.match(message, /قیمت مرجع ورود \(بسته‌شدن آخرین کندل 1m\)/);
  assert.match(message, /SiftingIO XAUUSD reference feed/);
  assert.match(message, /2026-11-26T16:19:00.000Z/);
  assert.match(message, /قیمت قابل تضمین اجرای بروکر نیست/);
  assert.match(message, /سفارش معاملاتی اجرا نشده است/);
});
