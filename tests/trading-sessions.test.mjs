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

test("session opening is inclusive and closing is exclusive", () => {
  const londonOpen = getTradingSessionStatus(Date.parse("2026-01-05T08:00:00Z"));
  const londonClose = getTradingSessionStatus(Date.parse("2026-01-05T17:00:00Z"));
  const newYorkOpen = getTradingSessionStatus(Date.parse("2026-01-05T13:00:00Z"));
  const newYorkClose = getTradingSessionStatus(Date.parse("2026-01-05T22:00:00Z"));
  assert.ok(londonOpen.sessions.includes("LONDON"));
  assert.ok(!londonClose.sessions.includes("LONDON"));
  assert.ok(newYorkOpen.sessions.includes("NEW_YORK"));
  assert.ok(!newYorkClose.sessions.includes("NEW_YORK"));
});

test("reports both sessions during their overlap", () => {
  const status = getTradingSessionStatus(Date.parse("2026-01-05T14:00:00Z"));
  assert.equal(status.allowed, true);
  assert.deepEqual(status.sessions, ["LONDON", "NEW_YORK"]);
});

test("does not treat a non-finite timestamp as an open session", () => {
  assert.equal(getTradingSessionStatus(Number.POSITIVE_INFINITY).allowed, false);
});


test("uses one-minute feed polling only during the London/New York overlap", async () => {
  const { getFeedPollIntervalMs } = await import("../src/trading-sessions.ts");
  assert.equal(getFeedPollIntervalMs(Date.parse("2026-01-05T14:00:00Z"), false), 60_000);
  assert.equal(getFeedPollIntervalMs(Date.parse("2026-01-05T09:00:00Z"), false), 4 * 60_000);
  assert.equal(getFeedPollIntervalMs(Date.parse("2026-01-05T23:00:00Z"), false), null);
  assert.equal(getFeedPollIntervalMs(Date.parse("2026-01-05T18:00:00Z"), true), 6 * 60_000);
});
