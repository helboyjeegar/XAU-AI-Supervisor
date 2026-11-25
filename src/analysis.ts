import { runAgents, type AgentInput } from "./agents.ts";
import type { AnalysisResult } from "./types.ts";

export function analyzeMarket(input: AgentInput): AnalysisResult {
  const output = runAgents(input);
  const chosenSide = output.buyScore > output.sellScore ? "BUY" : output.sellScore > output.buyScore ? "SELL" : "NEUTRAL";
  const score = chosenSide === "BUY" ? output.buyScore : chosenSide === "SELL" ? output.sellScore : 0;
  const canSignal = chosenSide !== "NEUTRAL" && score >= input.minScore && output.blockers.length === 0 && output.entry !== null && output.stopLoss !== null && output.takeProfit !== null;
  return {
    id: crypto.randomUUID(),
    symbol: "XAUUSD",
    generatedAt: input.now,
    verdict: canSignal ? chosenSide : "NO_TRADE",
    side: canSignal ? chosenSide : "NEUTRAL",
    score,
    scoreMeaning: "EVIDENCE_SCORE_NOT_PROBABILITY",
    entry: canSignal ? output.entry : null,
    stopLoss: canSignal ? output.stopLoss : null,
    takeProfit: canSignal ? output.takeProfit : null,
    riskReward: canSignal ? output.riskReward : null,
    reasons: output.reasons,
    blockers: output.blockers,
    warnings: output.warnings,
    agents: output.agents,
    timeframes: output.snapshots,
  };
}
