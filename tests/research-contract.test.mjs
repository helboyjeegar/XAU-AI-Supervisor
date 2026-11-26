import test from "node:test";
import assert from "node:assert/strict";
import { assessResearchBundle } from "../src/research-contract.ts";

const now = 1_800_000_000_000;
const evidence = [
  { id: "e1", tool: "market_candles", source: "siftingio", asOf: now - 10_000, summary: "Completed XAUUSD candles" },
  { id: "e2", tool: "macro_calendar", source: "calendar-feed", asOf: now - 20_000, summary: "USD event calendar" },
  { id: "e3", tool: "risk_snapshot", source: "account-snapshot", asOf: now - 5_000, summary: "Verified daily risk state" },
];
const reports = () => [
  {
    agent: "macro", generatedAt: now, direction: "NEUTRAL", summary: "No imminent high-impact event",
    findings: [{ claim: "Calendar coverage is current", evidenceIds: ["e2"] }],
    blockers: [], warnings: [], unknowns: [], veto: false,
    macroQuality: { calendarFresh: true, coverageMinutes: 180 },
  },
  {
    agent: "quant", generatedAt: now, direction: "BULLISH", summary: "5m and 30m are bullish",
    findings: [{ claim: "Trend alignment", evidenceIds: ["e1"] }],
    blockers: [], warnings: [], unknowns: [], veto: false,
    dataQuality: { candlesComplete: true, candlesFresh: true, timeframesAligned: true },
  },
  {
    agent: "risk", generatedAt: now, direction: "NEUTRAL", summary: "Risk checks pass",
    findings: [{ claim: "Risk snapshot verified", evidenceIds: ["e3"] }],
    blockers: [], warnings: [], unknowns: [], veto: false,
    riskChecks: {
      snapshotVerified: true, snapshotAgeMs: 5_000, dailyLossPercent: 0.2,
      maxDailyLossPercent: 5, dailyLockActive: false, stopValid: true,
      rewardRisk: 1.8, minimumRewardRisk: 1.5, evidenceIds: ["e3"],
    },
  },
];

test("accepts a complete evidence-linked bundle for coordinator synthesis only", () => {
  const result = assessResearchBundle({ reports: reports(), evidence, evidenceScore: 80, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, true);
  assert.equal(result.candidateSide, "BUY");
  assert.deepEqual(result.blockers, []);
});

test("fails closed when a specialist report is missing", () => {
  const result = assessResearchBundle({ reports: reports().slice(0, 2), evidence, evidenceScore: 90, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.ok(result.blockers.some((item) => item.includes("risk")));
});

test("fails closed on an unknown evidence reference", () => {
  const input = reports();
  input[1].findings[0].evidenceIds = ["e404"];
  const result = assessResearchBundle({ reports: input, evidence, evidenceScore: 90, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.ok(result.blockers.some((item) => item.includes("unknown evidence id")));
});

test("risk veto, expired snapshot and daily lock all block coordinator synthesis", () => {
  const input = reports();
  input[2].veto = true;
  input[2].riskChecks.snapshotAgeMs = 180_000;
  input[2].riskChecks.dailyLockActive = true;
  const result = assessResearchBundle({ reports: input, evidence, evidenceScore: 90, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.ok(result.blockers.some((item) => item.includes("vetoed")));
  assert.ok(result.blockers.some((item) => item.includes("stale")));
  assert.ok(result.blockers.some((item) => item.includes("lock")));
});

test("timeframe disagreement and evidence score below 75 block", () => {
  const input = reports();
  input[1].dataQuality.timeframesAligned = false;
  const result = assessResearchBundle({ reports: input, evidence, evidenceScore: 74, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.ok(result.blockers.some((item) => item.includes("5m and 30m")));
  assert.ok(result.blockers.some((item) => item.includes("minimum of 75")));
});

test("stale specialist reports and unreferenced findings block", () => {
  const input = reports();
  input[0].generatedAt = now - 5 * 60_000;
  input[1].findings[0].evidenceIds = [];
  const result = assessResearchBundle({ reports: input, evidence, evidenceScore: 90, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.ok(result.blockers.some((item) => item.includes("stale")));
  assert.ok(result.blockers.some((item) => item.includes("without evidence")));
});

test("fails closed outside London and New York sessions", () => {
  const result = assessResearchBundle({ reports: reports(), evidence, evidenceScore: 90, now, sessionAllowed: false });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.ok(result.blockers.some((item) => item.includes("Outside the allowed London/New York")));
});

test("opposing non-neutral Macro and Quant conclusions block coordinator synthesis", () => {
  const input = reports();
  input[0].direction = "BEARISH";
  input[1].direction = "BULLISH";
  const result = assessResearchBundle({ reports: input, evidence, evidenceScore: 100, now, sessionAllowed: true });
  assert.equal(result.eligibleForCoordinatorDecision, false);
  assert.equal(result.candidateSide, null);
  assert.ok(result.blockers.some((item) => item.includes("Macro and Quant specialists have opposing")));
});
