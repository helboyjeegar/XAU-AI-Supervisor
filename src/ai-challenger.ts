import type { AnalysisResult, Env } from "./types.ts";

export interface AiReview {
  enabled: boolean;
  veto: boolean;
  available: boolean;
  reasons: string[];
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  const choices = record.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as Record<string, unknown>).message;
    if (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string") {
      return (message as Record<string, string>).content;
    }
  }
  return null;
}

export function parseAiReview(value: unknown): { veto: boolean; reasons: string[] } | null {
  const text = extractText(value);
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.veto !== "boolean" || !Array.isArray(parsed.reasons)) return null;
    const reasons = parsed.reasons.filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/[\r\n]+/g, " ").trim().slice(0, 180)).filter(Boolean).slice(0, 3);
    return { veto: parsed.veto, reasons };
  } catch {
    return null;
  }
}

/** The model is a challenger only: it may veto a candidate, never create or upgrade one. */
export async function challengeCandidate(env: Env, result: AnalysisResult): Promise<AiReview> {
  if (env.ENABLE_AI_REVIEW !== "true") return { enabled: false, veto: false, available: false, reasons: [] };
  if (!env.AI) return { enabled: true, veto: true, available: false, reasons: ["بازبین هوش مصنوعی فعال اعلام شده، اما binding آن در Cloudflare متصل نیست"] };
  const evidence = {
    symbol: result.symbol,
    candidate: result.verdict,
    evidenceScore: result.score,
    scoreMeaning: result.scoreMeaning,
    proposedEntry: result.entry,
    proposedStopLoss: result.stopLoss,
    proposedTakeProfit: result.takeProfit,
    riskReward: result.riskReward,
    reasons: result.reasons,
    blockers: result.blockers,
    warnings: result.warnings,
    agents: result.agents,
    timeframes: result.timeframes,
  };
  try {
    const response = await env.AI.run(env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it", {
      temperature: 0,
      max_tokens: 240,
      messages: [
        {
          role: "system",
          content: "You are an adversarial risk reviewer for an XAUUSD trading alert. You are NOT a signal generator. Inspect only the supplied evidence. Do not invent prices, news, or data. Return JSON only: {\"veto\": boolean, \"reasons\": string[]}. Set veto=true only when the supplied evidence contains a concrete contradiction, invalid risk geometry, conflicting timeframe logic, or material missing information. You may never approve a trade; veto=false only means no additional objection was found. Keep reasons short.",
        },
        { role: "user", content: JSON.stringify(evidence) },
      ],
    });
    const parsed = parseAiReview(response);
    if (!parsed) return { enabled: true, veto: true, available: false, reasons: ["پاسخ بازبین هوش مصنوعی قابل اعتبارسنجی نبود؛ به‌صورت ایمن رد شد"] };
    return { enabled: true, veto: parsed.veto, available: true, reasons: parsed.reasons };
  } catch {
    return { enabled: true, veto: true, available: false, reasons: ["بازبین هوش مصنوعی در دسترس نبود؛ به‌صورت ایمن سیگنال متوقف شد"] };
  }
}
