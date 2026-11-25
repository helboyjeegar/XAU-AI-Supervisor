import test from "node:test";
import assert from "node:assert/strict";
import { formatStatus, parseRiskCommand } from "../src/telegram.ts";

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
