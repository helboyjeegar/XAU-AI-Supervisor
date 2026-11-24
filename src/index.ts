import { analyzeMarket } from "./analysis.ts";
import { challengeCandidate } from "./ai-challenger.ts";
import { loadCandles, readRiskStatus, saveAnalysis, saveRiskSnapshot, storeCandles, tradingDayKey, deleteOldCandles, deleteOldAnalyses, latestAnalysis, latestMacroContext, claimSignalNotification, releaseSignalNotification } from "./storage.ts";
import { formatAnalysis, formatStatus, sendTelegram } from "./telegram.ts";
import type { AnalysisResult, Candle, Env, MacroContext, RiskStatus, Timeframe } from "./types.ts";

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const setting = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const asObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function authorized(request: Request, env: Env): boolean {
  const provided = request.headers.get("x-ingest-secret") ?? "";
  return Boolean(env.INGEST_SECRET && provided.length === env.INGEST_SECRET.length && provided === env.INGEST_SECRET);
}

function normalizeSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/[\s/_-]/g, "");
  return ["XAUUSD", "GOLD"].includes(normalized) ? "XAUUSD" : null;
}

function validateCandles(value: unknown): { candles?: Candle[]; error?: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) return { error: "candles must contain 1 to 200 items" };
  const candles: Candle[] = [];
  let previousTime = 0;
  for (const item of value) {
    if (!asObject(item)) return { error: "each candle must be an object" };
    const time = typeof item.time === "string" ? Date.parse(item.time) : item.time;
    const numbers = [time, item.open, item.high, item.low, item.close, item.volume ?? 0];
    if (numbers.some((n) => typeof n !== "number" || !Number.isFinite(n))) return { error: "candle fields must be finite numbers or an ISO timestamp" };
    const [ts, open, high, low, close, volume] = numbers as number[];
    if (ts <= previousTime || ts <= 0) return { error: "candles must be in ascending time order without duplicates" };
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) return { error: "invalid OHLCV relationship or value" };
    candles.push({ time: ts, open, high, low, close, volume });
    previousTime = ts;
  }
  return { candles };
}

async function readRisk(env: Env): Promise<RiskStatus> {
  const dayKey = tradingDayKey(env.RISK_TIMEZONE ?? "UTC");
  if (!env.DB) return { verified: false, locked: false, lossPercent: 0, maxDailyLossPercent: setting(env.MAX_DAILY_LOSS_PERCENT, 5), dayKey };
  return readRiskStatus(env.DB, dayKey, setting(env.MAX_DAILY_LOSS_PERCENT, 5), Date.now(), setting(env.RISK_MAX_AGE_MINUTES, 2) * 60_000);
}

async function runAnalysis(env: Env, notify = true): Promise<AnalysisResult> {
  if (!env.DB) throw new Error("D1 database is not configured");
  const [one, five, thirty, risk, storedMacro] = await Promise.all([
    loadCandles(env.DB, "XAUUSD", "1m", 300),
    loadCandles(env.DB, "XAUUSD", "5m", 300),
    loadCandles(env.DB, "XAUUSD", "30m", 300),
    readRisk(env),
    latestMacroContext(env.DB),
  ]);
  let result = analyzeMarket({
    oneMinute: one,
    fiveMinute: five,
    thirtyMinute: thirty,
    macro: storedMacro,
    risk,
    now: Date.now(),
    minRiskReward: setting(env.MIN_RISK_REWARD, 1.5),
    stopAtrMultiplier: setting(env.STOP_ATR_MULTIPLIER, 1.2),
    minScore: setting(env.MIN_SIGNAL_SCORE, 75),
    highImpactBlockMinutes: setting(env.HIGH_IMPACT_BLOCK_MINUTES, 15),
    macroMaxAgeMinutes: setting(env.MACRO_MAX_AGE_MINUTES, 30),
  });

  if (result.verdict !== "NO_TRADE") {
    const review = await challengeCandidate(env, result);
    if (!review.enabled) {
      result = { ...result, aiReviewStatus: "DISABLED" };
    } else if (!review.available || review.veto) {
      result = {
        ...result,
        aiReviewStatus: review.available ? "VETOED" : "UNAVAILABLE",
        verdict: "NO_TRADE",
        side: "NEUTRAL",
        entry: null,
        stopLoss: null,
        takeProfit: null,
        riskReward: null,
        blockers: [...result.blockers, ...review.reasons],
      };
    } else {
      result = { ...result, aiReviewStatus: "PASSED" };
    }
  } else {
    result = { ...result, aiReviewStatus: env.ENABLE_AI_REVIEW === "true" ? "NOT_RUN" : "DISABLED" };
  }

  await saveAnalysis(env.DB, result);
  if (notify && result.verdict !== "NO_TRADE") {
    const cooldownMs = setting(env.ALERT_COOLDOWN_MINUTES, 15) * 60_000;
    if (await claimSignalNotification(env.DB, result.verdict, result.generatedAt, cooldownMs)) {
      const sent = await sendTelegram(env, formatAnalysis(result));
      if (!sent) await releaseSignalNotification(env.DB, result.generatedAt);
    }
  }
  return result;
}


async function handleTelegramSetup(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Telegram bot token or webhook secret is not configured" }, 503);
  }
  const url = new URL(request.url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev")) {
    return json({ ok: false, error: "Webhook setup must be called on the deployed HTTPS workers.dev URL" }, 400);
  }
  const webhookUrl = `${url.origin}/telegram/webhook`;
  const apiBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const setResponse = await fetch(`${apiBase}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
  });
  const setResult: unknown = await setResponse.json().catch(() => null);
  if (!setResponse.ok || !asObject(setResult) || setResult.ok !== true) {
    return json({ ok: false, step: "setWebhook", telegram: setResult }, 502);
  }
  const infoResponse = await fetch(`${apiBase}/getWebhookInfo`);
  const infoResult: unknown = await infoResponse.json().catch(() => null);
  if (!infoResponse.ok || !asObject(infoResult) || infoResult.ok !== true || !asObject(infoResult.result)) {
    return json({ ok: false, step: "getWebhookInfo", telegram: infoResult }, 502);
  }
  const info = infoResult.result;
  return json({
    ok: info.url === webhookUrl,
    webhookConfigured: info.url === webhookUrl,
    pendingUpdateCount: info.pending_update_count,
    lastErrorDate: info.last_error_date ?? null,
    lastErrorMessage: info.last_error_message ?? null,
  }, info.url === webhookUrl ? 200 : 502);
}

async function handleTelegramWebhookInfo(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Telegram bot token is not configured" }, 503);
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || !asObject(result) || result.ok !== true || !asObject(result.result)) {
    return json({ ok: false, error: "Telegram getWebhookInfo failed" }, 502);
  }
  const info = result.result;
  return json({
    ok: true,
    webhookConfigured: typeof info.url === "string" && info.url.endsWith("/telegram/webhook"),
    pendingUpdateCount: info.pending_update_count,
    lastErrorDate: info.last_error_date ?? null,
    lastErrorMessage: info.last_error_message ?? null,
  });
}

async function handleTelegram(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false }, 401);
  let update: unknown;
  try { update = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!asObject(update) || !asObject(update.message) || !asObject(update.message.chat)) return json({ ok: true, ignored: true });
  const chatId = String(update.message.chat.id ?? "");
  const text = typeof update.message.text === "string" ? update.message.text.trim().split(" ")[0] : "";
  if (!env.TELEGRAM_CHAT_ID || chatId !== env.TELEGRAM_CHAT_ID) return json({ ok: true, ignored: true });
  if (text === "/help" || text === "/start") {
    await sendTelegram(env, "دستورات:\n/status — وضعیت ریسک و سیستم\n/analyze — اجرای تحلیل جدید\n/help — راهنما\n\nاین ربات فقط تحلیل و هشدار ارائه می‌کند و سفارش ثبت نمی‌کند.");
  } else if (text === "/status") {
    const risk = await readRisk(env);
    const latest = env.DB ? await latestAnalysis(env.DB) : null;
    let verdict: string | undefined;
    try { verdict = latest ? (JSON.parse(latest.payload_json) as AnalysisResult).verdict : undefined; } catch { verdict = "خطا در خواندن آخرین تحلیل"; }
    await sendTelegram(env, formatStatus(risk, verdict));
  } else if (text === "/analyze") {
    try { const result = await runAnalysis(env, false); await sendTelegram(env, formatAnalysis(result)); }
    catch (error) { await sendTelegram(env, `تحلیل انجام نشد: ${error instanceof Error ? error.message : "خطای نامشخص"}`); }
  } else {
    await sendTelegram(env, "دستور شناخته نشد. /help را بفرست.");
  }
  return json({ ok: true });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return json({ service: "XAU AI Supervisor", version: "0.3.0", mode: "analysis-and-alerts-only", endpoints: ["GET /health", "POST /market/candles", "POST /macro/context", "POST /risk/snapshot", "POST /analysis/run", "GET /analysis/latest", "POST /telegram/webhook"] });
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, databaseConfigured: Boolean(env.DB), telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.TELEGRAM_WEBHOOK_SECRET), ingestSecretConfigured: Boolean(env.INGEST_SECRET), aiReviewEnabled: env.ENABLE_AI_REVIEW === "true", aiBindingConfigured: Boolean(env.AI), executionEnabled: false });
  if (request.method === "POST" && url.pathname === "/telegram/setup-webhook") return handleTelegramSetup(request, env);
  if (request.method === "GET" && url.pathname === "/telegram/webhook-info") return handleTelegramWebhookInfo(request, env);
  if (request.method === "POST" && url.pathname === "/telegram/webhook") return handleTelegram(request, env);
  if (["/market/candles", "/macro/context", "/risk/snapshot", "/analysis/run"].includes(url.pathname) && request.method === "POST" && !authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  if (request.method === "POST" && url.pathname === "/market/candles") {
    if (!env.DB) return json({ ok: false, error: "D1 database is not configured" }, 503);
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Request body must be JSON" }, 400); }
    if (!asObject(body)) return json({ ok: false, error: "Invalid payload" }, 400);
    const symbol = normalizeSymbol(body.symbol);
    const timeframe = body.timeframe;
    if (!symbol || !["1m", "5m", "30m"].includes(String(timeframe))) return json({ ok: false, error: "Only XAUUSD and timeframes 1m, 5m, 30m are supported" }, 422);
    const checked = validateCandles(body.candles);
    if (!checked.candles) return json({ ok: false, error: checked.error }, 422);
    const written = await storeCandles(env.DB, symbol, timeframe as Timeframe, checked.candles);
    return json({ ok: true, symbol, timeframe, received: written });
  }
  if (request.method === "POST" && url.pathname === "/macro/context") {
    if (!env.DB) return json({ ok: false, error: "D1 database is not configured" }, 503);
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Request body must be JSON" }, 400); }
    if (!asObject(body) || typeof body.source !== "string" || !body.source.trim() || typeof body.asOf !== "number" || !Number.isFinite(body.asOf) || Date.now() - body.asOf > setting(env.MACRO_MAX_AGE_MINUTES, 30) * 60_000 || body.asOf > Date.now() + 60_000 || typeof body.calendarCoverageMinutes !== "number" || !Number.isFinite(body.calendarCoverageMinutes) || body.calendarCoverageMinutes < setting(env.HIGH_IMPACT_BLOCK_MINUTES, 15)) return json({ ok: false, error: "source, a fresh asOf timestamp and sufficient calendarCoverageMinutes are required" }, 422);
    if (body.highImpactEventWithinMinutes !== null && (typeof body.highImpactEventWithinMinutes !== "number" || body.highImpactEventWithinMinutes < 0 || body.highImpactEventWithinMinutes > body.calendarCoverageMinutes)) return json({ ok: false, error: "highImpactEventWithinMinutes must be null or within the declared calendar coverage" }, 422);
    const allowedTrends = ["BULLISH", "BEARISH", "NEUTRAL"];
    if ((body.dxyTrend !== undefined && !allowedTrends.includes(String(body.dxyTrend))) || (body.us10yTrend !== undefined && !allowedTrends.includes(String(body.us10yTrend)))) return json({ ok: false, error: "Macro trends must be BULLISH, BEARISH or NEUTRAL" }, 422);
    const context: MacroContext = { source: body.source, asOf: body.asOf, calendarCoverageMinutes: body.calendarCoverageMinutes, highImpactEventWithinMinutes: body.highImpactEventWithinMinutes as number | null, dxyTrend: body.dxyTrend as MacroContext["dxyTrend"], us10yTrend: body.us10yTrend as MacroContext["us10yTrend"], note: typeof body.note === "string" ? body.note : undefined };
    await env.DB.prepare(`INSERT INTO macro_context (id, as_of, source, calendar_coverage_minutes, high_impact_event_within_minutes, dxy_trend, us10y_trend, note) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET as_of=excluded.as_of, source=excluded.source, calendar_coverage_minutes=excluded.calendar_coverage_minutes, high_impact_event_within_minutes=excluded.high_impact_event_within_minutes, dxy_trend=excluded.dxy_trend, us10y_trend=excluded.us10y_trend, note=excluded.note`).bind(context.asOf, context.source, context.calendarCoverageMinutes, context.highImpactEventWithinMinutes, context.dxyTrend ?? null, context.us10yTrend ?? null, context.note ?? null).run();
    return json({ ok: true, macroContextStored: true, asOf: context.asOf, source: context.source });
  }
  if (request.method === "POST" && url.pathname === "/risk/snapshot") {
    if (!env.DB) return json({ ok: false, error: "D1 database is not configured" }, 503);
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Request body must be JSON" }, 400); }
    if (!asObject(body) || typeof body.dayStartEquity !== "number" || typeof body.currentEquity !== "number" || !Number.isFinite(body.dayStartEquity) || !Number.isFinite(body.currentEquity) || body.dayStartEquity <= 0 || body.currentEquity <= 0 || typeof body.observedAt !== "number" || !Number.isFinite(body.observedAt) || (body.observedAt > Date.now() + 5_000 || Date.now() - body.observedAt > 120_000)) return json({ ok: false, error: "dayStartEquity, currentEquity and a fresh observedAt timestamp (Unix milliseconds) are required" }, 422);
    const dayKey = tradingDayKey(env.RISK_TIMEZONE ?? "UTC");
    const risk = await saveRiskSnapshot(env.DB, dayKey, body.dayStartEquity, body.currentEquity, setting(env.MAX_DAILY_LOSS_PERCENT, 5), body.observedAt, setting(env.RISK_MAX_AGE_MINUTES, 2) * 60_000);
    return json({ ok: true, risk });
  }
  if (request.method === "POST" && url.pathname === "/analysis/run") {
    try { return json({ ok: true, analysis: await runAnalysis(env) }); }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Analysis failed" }, 503); }
  }
  if (request.method === "GET" && url.pathname === "/analysis/latest") {
    if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
    if (!env.DB) return json({ ok: false, error: "D1 database is not configured" }, 503);
    const latest = await latestAnalysis(env.DB);
    return latest ? new Response(latest.payload_json, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : json({ ok: true, analysis: null });
  }
  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handleRequest(request, env); }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Internal error" }, 500); }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      try {
        if (controller.cron === "0 2 * * *") {
          const retention = Date.now() - 45 * 24 * 60 * 60 * 1000;
          await deleteOldCandles(env.DB!, retention);
          await deleteOldAnalyses(env.DB!, Date.now() - 90 * 24 * 60 * 60 * 1000);
        } else {
          await runAnalysis(env);
        }
      } catch (error) {
        console.error("Scheduled XAU supervisor task failed", error);
      }
    })());
  },
};
