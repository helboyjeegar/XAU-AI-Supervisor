import test from "node:test";
import assert from "node:assert/strict";
import { runTradingAgentsResearch } from "../src/tradingagents-engine.ts";

const now = 1_800_000_000_000;
function makeCandles(timeframeMs, count = 80) {
  const result = [];
  const start = now - timeframeMs * count;
  for (let i = 0; i < count; i++) {
    const open = 2600 + i * 0.15;
    const close = open + 0.08;
    result.push({ time: start + i * timeframeMs, open, high: close + 0.04, low: open - 0.04, close, volume: 100 + i });
  }
  return result;
}
function input(overrides = {}) {
  return {
    oneMinute: makeCandles(60_000), fiveMinute: makeCandles(300_000), thirtyMinute: makeCandles(1_800_000),
    macro: { source: "test-calendar", asOf: now - 60_000, calendarCoverageMinutes: 180,
      highImpactEventWithinMinutes: null },
    risk: { verified: true, locked: false, lossPercent: 0.2, maxDailyLossPercent: 5,
      updatedAt: now - 30_000, dayKey: "2026-11-25" },
    now, modelName: "@cf/google/gemma-4-26b-a4b-it", minRiskReward: 1.5,
    stopAtrMultiplier: 1.2, macroMaxAgeMinutes: 30, highImpactBlockMinutes: 15,
    riskMaxAgeMs: 120_000, marketDataSource: "test-candle-feed", ...overrides,
  };
}
function mockAi(options = {}) {
  const calls = [];
  const ai = {
    async run(model, request) {
      const user = JSON.parse(request.messages[1].content);
      const data = user.suppliedEvidence;
      calls.push({ model, role: user.role, system: request.messages[0].content });
      const ev = Array.isArray(data.evidence) ? data.evidence : Array.isArray(data.riskFacts?.evidence) ? data.riskFacts.evidence : [];
      const ids = (tool) => ev.filter((item) => item.tool === tool).map((item) => item.id);
      const response = (body) => ({ response: JSON.stringify(body) });
      if (user.role === "macro") return response({
        direction: options.macroDirection ?? "NEUTRAL", summary: "The supplied calendar shows no near-term high-impact event.",
        findings: [{ claim: "Calendar snapshot is available", evidenceIds: ids("macro_calendar") }],
        blockers: [], warnings: [], unknowns: ["DXY and US10Y are not connected"], veto: false,
      });
      if (user.role === "quant") {
        const marketIds = ev.filter((item) => item.tool === "market_candles" || item.tool === "compute_indicators").map((item) => item.id);
        return response({
          direction: "BULLISH", summary: "The supplied 5m and 30m metrics align upward.",
          findings: [{ claim: "Timeframe structure is aligned", evidenceIds: marketIds.slice(0, 5) }],
          blockers: [], warnings: [], unknowns: [], veto: false,
        });
      }
      if (user.role === "risk") return response({
        direction: "NEUTRAL", summary: "The proposed geometry meets the configured risk checks.",
        findings: [{ claim: "Risk snapshot and proposed geometry reviewed", evidenceIds: ids("risk_snapshot").concat(ids("risk_geometry")) }],
        blockers: [], warnings: [], unknowns: [], veto: Boolean(options.riskVeto),
      });
      if (user.role === "main_coordinator") {
        const allIds = data.evidence.map((item) => item.id);
        return response({
          side: options.coordinatorSide ?? "BUY",
          summary: "Macro, Quant and Risk reports were reconciled against the supplied evidence.",
          reasons: [{ claim: "The Quant candidate is supported by the supplied timeframe evidence.", evidenceIds: allIds.slice(0, 3) }],
        });
      }
      throw new Error("Unexpected role " + user.role);
    },
  };
  return { ai, calls };
}

test("runs isolated Macro, Quant, Risk and coordinator stages with traceable evidence", async () => {
  const { ai, calls } = mockAi();
  const run = await runTradingAgentsResearch(input(), ai, true, async () => true);
  assert.equal(run.result.verdict, "BUY", JSON.stringify({ blockers: run.result.blockers, warnings: run.result.warnings, calls: calls.map((item) => item.role), reports: run.reports }));
  assert.equal(run.result.researchStatus, "COMPLETED");
  assert.equal(run.result.side, "BUY");
  assert.equal(run.result.score, 100);
  assert.deepEqual(calls.map((item) => item.role), ["macro", "quant", "risk", "main_coordinator"]);
  assert.equal(run.reports.length, 3);
  assert.ok(run.evidence.length >= 9);
  assert.ok(run.result.evidenceIds.length === run.evidence.length);
  assert.ok(run.result.stopLoss < run.result.entry);
  assert.ok(run.result.takeProfit > run.result.entry);
});

test("does not call inference when the TradingAgents engine is disabled", async () => {
  let calls = 0;
  const ai = { async run() { calls++; throw new Error("must not be called"); } };
  const run = await runTradingAgentsResearch(input(), ai, false);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "DISABLED");
  assert.equal(calls, 0);
});

test("disabled engine reports deterministic preflight blockers without inference", async () => {
  let calls = 0;
  const ai = { async run() { calls++; throw new Error("must not be called"); } };
  const run = await runTradingAgentsResearch(input({
    risk: { verified: false, locked: false, lossPercent: 0, maxDailyLossPercent: 5, updatedAt: now - 300_000 },
    macro: { source: "old-calendar", asOf: now - 60 * 60_000, calendarCoverageMinutes: 180,
      highImpactEventWithinMinutes: null },
  }), ai, false);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "DISABLED");
  assert.ok(run.result.blockers.some((item) => item.includes("تقویم اقتصادی")));
  assert.ok(run.result.blockers.some((item) => item.includes("snapshot ریسک")));
  assert.ok(run.result.blockers.some((item) => item.includes("موتور TradingAgents غیرفعال")));
  assert.equal(calls, 0);
});

test("stale risk or macro preflight blocks the run before any inference", async () => {
  const { ai, calls } = mockAi();
  const run = await runTradingAgentsResearch(input({
    risk: { verified: false, locked: false, lossPercent: 0, maxDailyLossPercent: 5, updatedAt: now - 300_000 },
  }), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "BLOCKED");
  assert.equal(calls.length, 0);
});

test("risk specialist veto prevents coordinator approval", async () => {
  const { ai, calls } = mockAi({ riskVeto: true });
  const run = await runTradingAgentsResearch(input(), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.ok(run.result.blockers.some((item) => item.includes("vetoed")));
  assert.equal(calls.some((item) => item.role === "main_coordinator"), false);
});

test("coordinator cannot reverse the Quant candidate direction", async () => {
  const { ai } = mockAi({ coordinatorSide: "SELL" });
  const run = await runTradingAgentsResearch(input(), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "FAILED", JSON.stringify({ blockers: run.result.blockers, calls: run.result.agents }));
  assert.ok(run.result.blockers.some((item) => item.includes("تعارض")));
});

test("invalid specialist output fails closed before the coordinator stage", async () => {
  let calls = 0;
  const ai = { async run(model, request) {
    calls++;
    const user = JSON.parse(request.messages[1].content);
    return { response: user.role === "macro" ? "not-json" : JSON.stringify({
      direction: "BULLISH", summary: "Quant result", findings: [{ claim: "claim", evidenceIds: ["unknown"] }],
      blockers: [], warnings: [], unknowns: [], veto: false,
    }) };
  }};
  const run = await runTradingAgentsResearch(input(), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "FAILED");
  assert.equal(calls, 2);
});

test("model outage fails closed and never creates an alert candidate", async () => {
  const ai = { async run() { throw new Error("provider unavailable"); } };
  const run = await runTradingAgentsResearch(input(), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "FAILED");
  assert.equal(run.result.entry, null);
});


test("daily budget denial blocks all model calls", async () => {
  const { ai, calls } = mockAi();
  let reservations = 0;
  const run = await runTradingAgentsResearch(input(), ai, true, async () => { reservations++; return false; });
  assert.equal(reservations, 1);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "BLOCKED");
  assert.equal(calls.length, 0);
});

test("enabled engine fails closed when no daily budget guard is supplied", async () => {
  const { ai, calls } = mockAi();
  const run = await runTradingAgentsResearch(input(), ai, true);
  assert.equal(run.result.researchStatus, "BLOCKED");
  assert.equal(calls.length, 0);
});

test("oversized AI input is rejected before inference", async () => {
  const { ai, calls } = mockAi();
  const run = await runTradingAgentsResearch(input({
    macro: {
      source: "test-calendar", asOf: now - 60_000,
      calendarCoverageMinutes: 180, highImpactEventWithinMinutes: null,
      note: "x".repeat(21_000),
    },
  }), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "FAILED");
  assert.equal(calls.length, 0);
  assert.ok(run.result.blockers.some((item) => item.includes("کامل نشد")));
});

test("opposing Macro and Quant conclusions block before coordinator approval", async () => {
  const { ai, calls } = mockAi({ macroDirection: "BEARISH" });
  const run = await runTradingAgentsResearch(input({
    macro: { ...input().macro, dxyTrend: "BEARISH" },
  }), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "BLOCKED");
  assert.ok(run.result.blockers.some((item) => item.includes("متخصصان Macro و Quant")));
  assert.deepEqual(calls.map((item) => item.role), ["macro", "quant"]);
});

test("unverified candle provenance blocks before any model inference", async () => {
  const { ai, calls } = mockAi();
  const run = await runTradingAgentsResearch(input({
    marketDataSource: "D1 candle store; market-data source attribution unverified",
  }), ai, true, async () => true);
  assert.equal(run.result.verdict, "NO_TRADE");
  assert.equal(run.result.researchStatus, "BLOCKED");
  assert.ok(run.result.blockers.some((item) => item.includes("منبع داده کندل‌ها")));
  assert.equal(calls.length, 0);
});

test("calendar-only Macro output cannot create a directional gold thesis", async () => {
  const { ai, calls } = mockAi({ macroDirection: "BEARISH" });
  const run = await runTradingAgentsResearch(input(), ai, true, async () => true);
  assert.equal(run.result.verdict, "BUY");
  assert.equal(run.reports[0].direction, "NEUTRAL");
  assert.ok(run.reports[0].warnings.some((item) => item.includes("فقط تقویم رویدادها")));
  assert.ok(calls.some((item) => item.role === "main_coordinator"));
});
