/**
 * Worker-side research contracts adapted from TauricResearch/TradingAgents v1.0.1.
 *
 * This module validates evidence-linked specialist reports and the coordinator hand-off.
 * It does not generate a trade, call a model, or execute an order.
 */

export type SpecialistName = "macro" | "quant" | "risk";
export type ResearchDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface ResearchEvidence {
  id: string;
  tool: string;
  source: string;
  asOf: number;
  summary: string;
}

export interface ResearchFinding {
  claim: string;
  evidenceIds: string[];
}

export interface SpecialistReport {
  agent: SpecialistName;
  generatedAt: number;
  direction: ResearchDirection;
  summary: string;
  findings: ResearchFinding[];
  blockers: string[];
  warnings: string[];
  unknowns: string[];
  veto: boolean;
  /** Required on Quant reports. */
  dataQuality?: {
    candlesComplete: boolean;
    candlesFresh: boolean;
    timeframesAligned: boolean;
  };
  /** Required on Macro reports. */
  macroQuality?: {
    calendarFresh: boolean;
    coverageMinutes: number;
  };
  /** Required on Risk reports. Values must come from the risk tool, not model inference. */
  riskChecks?: {
    snapshotVerified: boolean;
    snapshotAgeMs: number;
    dailyLossPercent: number;
    maxDailyLossPercent: number;
    dailyLockActive: boolean;
    stopValid: boolean;
    rewardRisk: number;
    minimumRewardRisk: number;
    evidenceIds: string[];
  };
}

export interface ResearchBundleAssessment {
  eligibleForCoordinatorDecision: boolean;
  candidateSide: "BUY" | "SELL" | null;
  blockers: string[];
  warnings: string[];
  reportCount: number;
  evidenceCount: number;
}

const REQUIRED_AGENTS: SpecialistName[] = ["macro", "quant", "risk"];
const MAX_FUTURE_SKEW_MS = 60_000;
const DEFAULT_MAX_REPORT_AGE_MS = 2 * 60_000;
const DEFAULT_MAX_RISK_SNAPSHOT_AGE_MS = 2 * 60_000;

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Validate the three independent specialist reports before the main coordinator synthesizes them.
 * A successful result only means the evidence bundle may be considered by the coordinator; it is
 * not a BUY/SELL verdict and cannot bypass the existing analysis/risk gates.
 */
export function assessResearchBundle(input: {
  reports: SpecialistReport[];
  evidence: ResearchEvidence[];
  evidenceScore: number;
  now: number;
  /** Must be computed by the DST-aware London/New York session gate. */
  sessionAllowed: boolean;
  minimumEvidenceScore?: number;
  maxReportAgeMs?: number;
  maxRiskSnapshotAgeMs?: number;
}): ResearchBundleAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const minimumEvidenceScore = input.minimumEvidenceScore ?? 75;
  const maxReportAgeMs = input.maxReportAgeMs ?? DEFAULT_MAX_REPORT_AGE_MS;
  const maxRiskSnapshotAgeMs = input.maxRiskSnapshotAgeMs ?? DEFAULT_MAX_RISK_SNAPSHOT_AGE_MS;

  if (!Number.isFinite(input.now)) blockers.push("Coordinator clock is invalid");
  if (input.sessionAllowed !== true) blockers.push("Outside the allowed London/New York trading sessions");
  if (!Number.isFinite(input.evidenceScore) || input.evidenceScore < minimumEvidenceScore) {
    blockers.push(`Evidence score is below the required minimum of ${minimumEvidenceScore}`);
  }

  const evidenceById = new Map<string, ResearchEvidence>();
  for (const item of input.evidence) {
    if (!validText(item.id) || !validText(item.tool) || !validText(item.source) || !validText(item.summary) || !Number.isFinite(item.asOf)) {
      blockers.push("An evidence record is malformed");
      continue;
    }
    if (evidenceById.has(item.id)) blockers.push(`Duplicate evidence id: ${item.id}`);
    evidenceById.set(item.id, item);
  }

  const reportsByAgent = new Map<SpecialistName, SpecialistReport>();
  for (const report of input.reports) {
    if (reportsByAgent.has(report.agent)) blockers.push(`Duplicate specialist report: ${report.agent}`);
    reportsByAgent.set(report.agent, report);
    if (!Number.isFinite(report.generatedAt) || report.generatedAt > input.now + MAX_FUTURE_SKEW_MS || input.now - report.generatedAt > maxReportAgeMs) {
      blockers.push(`${report.agent} report is missing, future-dated or stale`);
    }
    if (!validText(report.summary)) blockers.push(`${report.agent} report has no conclusion`);
    if (report.veto) blockers.push(`${report.agent} specialist vetoed the setup`);
    blockers.push(...report.blockers.map((item) => `${report.agent}: ${item}`));
    warnings.push(...report.warnings.map((item) => `${report.agent}: ${item}`));
    if (!Array.isArray(report.findings)) {
      blockers.push(`${report.agent} report has no findings list`);
      continue;
    }
    for (const finding of report.findings) {
      if (!validText(finding.claim) || !Array.isArray(finding.evidenceIds) || finding.evidenceIds.length === 0) {
        blockers.push(`${report.agent} contains a finding without evidence references`);
        continue;
      }
      for (const id of finding.evidenceIds) {
        if (!evidenceById.has(id)) blockers.push(`${report.agent} cites unknown evidence id: ${id}`);
      }
    }
  }

  for (const agent of REQUIRED_AGENTS) {
    if (!reportsByAgent.has(agent)) blockers.push(`Required specialist report is missing: ${agent}`);
  }

  const quant = reportsByAgent.get("quant");
  if (quant) {
    if (!quant.dataQuality) blockers.push("Quant data-quality assessment is missing");
    else {
      if (!quant.dataQuality.candlesComplete) blockers.push("Quant reports incomplete candle coverage");
      if (!quant.dataQuality.candlesFresh) blockers.push("Quant reports stale candles");
      if (!quant.dataQuality.timeframesAligned) blockers.push("5m and 30m trends are not aligned");
    }
    if (quant.direction === "NEUTRAL") blockers.push("Quant has no supported directional conclusion");
  }

  const macro = reportsByAgent.get("macro");
  if (macro) {
    if (!macro.macroQuality) blockers.push("Macro data-quality assessment is missing");
    else {
      if (!macro.macroQuality.calendarFresh) blockers.push("Macro calendar is stale or unavailable");
      if (!Number.isFinite(macro.macroQuality.coverageMinutes) || macro.macroQuality.coverageMinutes <= 0) {
        blockers.push("Macro calendar coverage is invalid");
      }
    }
  }

  // A directional disagreement between independent Macro and Quant specialists is a hard
  // pre-coordinator blocker. Do not leave this safety decision to the LLM coordinator.
  if (macro && quant &&
      macro.direction !== "NEUTRAL" &&
      quant.direction !== "NEUTRAL" &&
      macro.direction !== quant.direction) {
    blockers.push("Macro and Quant specialists have opposing directional conclusions");
  }

  const risk = reportsByAgent.get("risk");
  if (risk) {
    const checks = risk.riskChecks;
    if (!checks) blockers.push("Risk checks are missing");
    else {
      if (!checks.snapshotVerified) blockers.push("Daily risk snapshot is not verified");
      if (!Number.isFinite(checks.snapshotAgeMs) || checks.snapshotAgeMs < 0 || checks.snapshotAgeMs > maxRiskSnapshotAgeMs) {
        blockers.push("Daily risk snapshot is stale or invalid");
      }
      if (!Number.isFinite(checks.dailyLossPercent) || !Number.isFinite(checks.maxDailyLossPercent) ||
          checks.dailyLossPercent >= checks.maxDailyLossPercent) {
        blockers.push("Daily loss limit has been reached or risk values are invalid");
      }
      if (checks.dailyLockActive) blockers.push("Daily loss lock is active");
      if (!checks.stopValid) blockers.push("Stop-loss geometry is invalid");
      if (!Number.isFinite(checks.rewardRisk) || !Number.isFinite(checks.minimumRewardRisk) ||
          checks.rewardRisk < checks.minimumRewardRisk) {
        blockers.push("Reward-to-risk is below the configured minimum");
      }
      if (!Array.isArray(checks.evidenceIds) || checks.evidenceIds.length === 0) {
        blockers.push("Risk checks have no evidence references");
      } else {
        for (const id of checks.evidenceIds) {
          if (!evidenceById.has(id)) blockers.push(`Risk checks cite unknown evidence id: ${id}`);
        }
      }
    }
  }

  const candidateSide =
    blockers.length === 0 && quant?.direction === "BULLISH" ? "BUY" :
    blockers.length === 0 && quant?.direction === "BEARISH" ? "SELL" : null;

  return {
    eligibleForCoordinatorDecision: blockers.length === 0 && candidateSide !== null,
    candidateSide,
    blockers: unique(blockers),
    warnings: unique(warnings),
    reportCount: input.reports.length,
    evidenceCount: evidenceById.size,
  };
}
