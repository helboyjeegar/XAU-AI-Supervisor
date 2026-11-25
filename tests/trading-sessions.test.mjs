import test from "node:test";
import assert from "node:assert/strict";
import { getTradingSessionStatus } from "../src/trading-sessions.ts";

test("allows the London session using London local time", () => {
  // 2026-01-05 08:30 Europe/London = 08:30 UTC.
  const status = getTradingSessionStatus(Date.parse("2026-01-05T08:30:00Z"));
  assert.equal(status.allowed, true);
  assert.ok(status.sessions.includes("LONDON"));
});

test("allows the New York session using New York local time", () => {
  // 2026-01-05 08:30 America/New_York = 13:30 UTC.
  const status = getTradingSessionStatus(Date.parse("2026-01-05T13:30:00Z"));
  assert.equal(status.allowed, true);
  assert.ok(status.sessions.includes("NEW_YORK"));
});

test("blocks time before both session opens", () => {
  const status = getTradingSessionStatus(Date.parse("2026-01-05T07:00:00Z"));
  assert.equal(status.allowed, false);
  assert.deepEqual(status.sessions, []);
});

test("blocks time after both session closes", () => {
  const status = getTradingSessionStatus(Date.parse("2026-01-05T23:00:00Z"));
  assert.equal(status.allowed, false);
});

test("blocks weekends even when local clock is inside session hours", () => {
  const status = getTradingSessionStatus(Date.parse("2026-01-10T13:30:00Z"));
  assert.equal(status.allowed, false);
});

test("handles daylight-saving changes through IANA time zones", () => {
  // 2026-07-06 08:30 London = 07:30 UTC during British Summer Time.
  const london = getTradingSessionStatus(Date.parse("2026-07-06T07:30:00Z"));
  assert.ok(london.sessions.includes("LONDON"));
  // 2026-07-06 08:30 New York = 12:30 UTC during US daylight time.
  const newYork = getTradingSessionStatus(Date.parse("2026-07-06T12:30:00Z"));
  assert.ok(newYork.sessions.includes("NEW_YORK"));
});

test("fails closed for invalid timestamps", () => {
  assert.equal(getTradingSessionStatus(Number.NaN).allowed, false);
});
