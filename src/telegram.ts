import type { AnalysisResult, Env, RiskStatus } from "./types.ts";

export async function sendTelegram(env: Env, message: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }),
  });
  return response.ok;
}

export function formatAnalysis(result: AnalysisResult): string {
  if (result.verdict === "NO_TRADE") {
    const blockers = result.blockers.slice(0, 5).map((item) => `• ${item}`).join("\n");
    return ["XAU AI SUPERVISOR — بدون معامله", `امتیاز شواهد: ${result.score}/100 (احتمال آماری نیست)`, `بازبینی AI: ${result.aiReviewStatus ?? "NOT_RUN"}`, blockers || "شرایط ورود تأیید نشد", "هیچ سفارشی اجرا نشده است."].join("\n");
  }
  return [
    `XAU AI SUPERVISOR — ${result.verdict}`,
    `ورود پیشنهادی: ${result.entry}`,
    `حد ضرر: ${result.stopLoss}`,
    `حد سود: ${result.takeProfit}`,
    `نسبت سود به زیان: 1:${result.riskReward?.toFixed(2)}`,
    `امتیاز شواهد: ${result.score}/100 (احتمال آماری نیست)`,
    `بازبینی AI: ${result.aiReviewStatus ?? "NOT_RUN"}`,
    "دلایل:",
    ...result.reasons.slice(0, 5).map((item) => `• ${item}`),
    "این فقط هشدار تحلیلی است؛ سفارش معاملاتی اجرا نشده است.",
  ].join("\n");
}

export function formatStatus(risk: RiskStatus, lastVerdict?: string): string {
  return [
    "وضعیت XAU AI SUPERVISOR",
    `وضعیت ریسک: ${risk.verified ? "دریافت شده" : "تأیید نشده"}`,
    `افت روزانه: ${risk.lossPercent.toFixed(2)}% / ${risk.maxDailyLossPercent.toFixed(2)}%`,
    `قفل روزانه: ${risk.locked ? "فعال" : "غیرفعال"}`,
    `آخرین نتیجه: ${lastVerdict ?? "هنوز تحلیلی ثبت نشده"}`,
    "حالت سیستم: فقط تحلیل و هشدار؛ بدون اجرای سفارش",
  ].join("\n");
}

export function parseRiskCommand(message: string): { dayStartEquity: number; currentEquity: number } | null {
  const parts = message.trim().split(/\s+/);
  if (parts.length !== 3 || !/^\/risk(?:@[^\s]+)?$/i.test(parts[0])) return null;
  const parseAmount = (raw: string): number | null => {
    const normalized = raw.replace(/,/g, "");
    if (!/^\d+(?:\\.\d{1,4})?$/.test(normalized)) return null;
    const value = Number(normalized);
    return Number.isFinite(value) && value > 0 && value <= 1_000_000_000 ? value : null;
  };
  const dayStartEquity = parseAmount(parts[1]);
  const currentEquity = parseAmount(parts[2]);
  return dayStartEquity === null || currentEquity === null ? null : { dayStartEquity, currentEquity };
}
