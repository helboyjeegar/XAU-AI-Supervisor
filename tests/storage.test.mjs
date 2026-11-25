import test from "node:test";
import assert from "node:assert/strict";
import { tradingDayKey } from "../src/storage.ts";

test("daily risk key follows the configured prop timezone rather than assuming UTC", () => {
  assert.equal(tradingDayKey("America/New_York", new Date("2026-11-26T04:30:00.000Z")), "2026-11-25");
  assert.equal(tradingDayKey("America/New_York", new Date("2026-11-26T05:30:00.000Z")), "2026-11-26");
});

test("daily risk key rejects missing or invalid timezones", () => {
  assert.throws(() => tradingDayKey(""), /IANA timezone/);
  assert.throws(() => tradingDayKey("Not/A_Real_Zone"));
});
