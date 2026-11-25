import type { ResearchEvidence, SpecialistReport } from "./research-contract.ts";
import type { AnalysisResult } from "./types.ts";

export interface ResearchRunRecord {
  runId: string;
  createdAt: number;
  status: "DISABLED" | "BLOCKED" | "COMPLETED" | "FAILED";
  result: AnalysisResult;
  evidence: ResearchEvidence[];
  reports: SpecialistReport[];
}

export async function saveResearchRun(db: D1Database, run: ResearchRunRecord): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO research_runs (id, created_at, status, verdict, payload_json) VALUES (?, ?, ?, ?, ?)")
      .bind(run.runId, run.createdAt, run.status, run.result.verdict, JSON.stringify(run.result)),
    ...run.evidence.map((item) => db.prepare(
      "INSERT INTO research_evidence (run_id, evidence_id, tool, source, as_of, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(run.runId, item.id, item.tool, item.source, item.asOf, item.summary, JSON.stringify(item))),
    ...run.reports.map((item) => db.prepare(
      "INSERT INTO specialist_reports (run_id, agent, generated_at, direction, veto, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(run.runId, item.agent, item.generatedAt, item.direction, item.veto ? 1 : 0, JSON.stringify(item))),
  ];
  await db.batch(statements);
}

export async function latestResearchRun(db: D1Database): Promise<{
  id: string; created_at: number; status: string; verdict: string; payload_json: string;
} | null> {
  return db.prepare("SELECT id, created_at, status, verdict, payload_json FROM research_runs ORDER BY created_at DESC LIMIT 1").first();
}

export async function deleteOldResearchRuns(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare("DELETE FROM research_runs WHERE created_at < ?").bind(olderThan).run();
}
