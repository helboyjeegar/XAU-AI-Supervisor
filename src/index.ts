import { getTradingSessionStatus } from "./trading-sessions.ts";
import { runTradingAgentsResearch } from "./tradingagents-engine.ts";
import { saveResearchRun, latestResearchRun, deleteOldResearchRuns } from "./research-storage.ts";
import { syncOfficialMacroCalendar } from "./macro-calendar.ts";
import { refreshSiftingMarketData } from "./market-feed.ts";
import { loadCandles, readRiskStatus, saveAnalysis, saveRiskSnapshot, storeCandles, tradingDayKey, reserveAiRunBudget, deleteOldCandles, deleteOldAnalyses, latestAnalysis, latestMacroContext, claimSignalNotification, releaseSignalNotification } from "./storage.ts";
import { formatAnalysis, formatStatus, parseRiskCommand, sendTelegram } from "./telegram.ts";
import { processPaperTrading, sendPaperDailyReport } from "./paper-trading.ts";
import type { AnalysisResult, Candle, Env, MacroContext, RiskStatus, Timeframe } from "./types.ts";

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const setting = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function configuredRiskTimezone(env: Env): string | null {
  const timezone = env.RISK_TIMEZONE?.trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}
const asObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function authorized(request: Request, env: Env): boolean {
  const provided = request.headers.get("x-ingest-secret") ?? "";
  return Boolean(env.INGEST_SECRET && provided.length === env.INGEST_SECRET.length && provided === env.INGEST_SECRET);
}

async function telegramWebhookToken(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const timezone = configuredRiskTimezone(env);
  const maxDailyLossPercent = setting(env.MAX_DAILY_LOSS_PERCENT, 5);
  if (!timezone) return {
    verified: false, locked: true, lossPercent: 0, maxDailyLossPercent,
    timezoneConfigured: false,
  };
  const dayKey = tradingDayKey(timezone);
  if (!env.DB) return {
    verified: false, locked: true, lossPercent: 0, maxDailyLossPercent,
    dayKey, timezoneConfigured: true,
  };
  return {
    ...await readRiskStatus(env.DB, dayKey, maxDailyLossPercent, Date.now(),
      setting(env.RISK_MAX_AGE_MINUTES, 2) * 60_000),
    timezoneConfigured: true,
  };
}

async function refreshMarketData(env: Env): Promise<void> {
  if (!env.DB || !env.SIFTING_API_KEY) return;
  await refreshSiftingMarketData(env.DB, env.SIFTING_API_KEY, Date.now());
}

async function formatMarketFeedStatus(env: Env): Promise<string> {
  if (!env.SIFTING_API_KEY) return "داده طلا: کلید SiftingIO هنوز در Cloudflare تنظیم نشده است.";
  if (!env.DB) return "داده طلا: پایگاه داده در دسترس نیست.";

  try {
    const [feed, candleRows, macro] = await Promise.all([
      env.DB.prepare(
        "SELECT last_attempt_at, last_success_at, last_bar_at, last_error FROM market_feed_state WHERE provider = 'siftingio'",
      ).first<{
        last_attempt_at: number;
        last_success_at: number | null;
        last_bar_at: number | null;
        last_error: string | null;
      }>(),
      env.DB.prepare(
        "SELECT timeframe, COUNT(*) AS candle_count, MAX(ts) AS latest_candle_ms FROM market_candles WHERE symbol = 'XAUUSD' GROUP BY timeframe",
      ).all<{ timeframe: string; candle_count: number; latest_candle_ms: number }>(),
      env.DB.prepare(
        "SELECT source, as_of, note FROM macro_context WHERE id = 1",
      ).first<{ source: string; as_of: number; note: string | null }>(),
    ]);

    const counts = new Map((candleRows.results ?? []).map((row) => [row.timeframe, row.candle_count]));
    const latest = new Map((candleRows.results ?? []).map((row) => [row.timeframe, row.latest_candle_ms]));
    const now = Date.now();
    const m1 = latest.get("1m");
    const m5 = latest.get("5m");
    const m30 = latest.get("30m");
    const age = (time: number | undefined, durationMs: number) =>
      time === undefined ? "ندارد" : Math.max(0, Math.floor((now - time - durationMs) / 60_000)) + " دقیقه";
    const lines = [
      "وضعیت داده بازار (SiftingIO)",
      "کندل‌ها — 1m: " + (counts.get("1m") ?? 0) + " | 5m: " + (counts.get("5m") ?? 0) + " | 30m: " + (counts.get("30m") ?? 0),
      "سن آخرین کندل بسته‌شده — 1m: " + age(m1, 60_000) + " | 5m: " + age(m5, 5 * 60_000) + " | 30m: " + age(m30, 30 * 60_000),
      feed?.last_success_at ? "آخرین دریافت موفق: " + new Date(feed.last_success_at).toISOString() : "آخرین دریافت موفق: هنوز ثبت نشده",
    ];

    if (feed?.last_error) lines.push("خطای آخر فید: " + feed.last_error.slice(0, 250));
    if (macro?.source && macro.as_of) {
      const macroAge = Math.max(0, Math.floor((now - macro.as_of) / 60_000));
      lines.push("تقویم اقتصادی: " + macro.source + "، " + macroAge + " دقیقه قبل");
    } else {
      lines.push("تقویم اقتصادی: هنوز ثبت نشده");
    }
    return lines.join("\n");
  } catch (error) {
    return "وضعیت داده بازار قابل خواندن نیست: " + (error instanceof Error ? error.message : "خطای پایگاه داده");
  }
}

async function refreshMacroCalendar(env: Env): Promise<void> {
  if (!env.DB) return;
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO macro_sync_state (id, last_attempt_at, retry_after_at, last_error) VALUES (1, 0, 0, NULL)",
    ).run();
    const reservation = await env.DB.prepare(
      "UPDATE macro_sync_state SET last_attempt_at = ?, retry_after_at = ? WHERE id = 1 AND retry_after_at <= ?",
    ).bind(now, now + 15 * 60_000, now).run();
    if ((reservation.meta?.changes ?? 0) === 0) return;

    const current = await latestMacroContext(env.DB);
    await syncOfficialMacroCalendar(env.DB, current, now);
    await env.DB.prepare("UPDATE macro_sync_state SET last_error = NULL WHERE id = 1").run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await env.DB.prepare("UPDATE macro_sync_state SET last_error = ? WHERE id = 1").bind(message.slice(0, 500)).run();
    } catch { /* keep the original calendar error */ }
    // Keep the previous valid snapshot; retry is throttled for 15 minutes.
    console.error("Official macro calendar refresh failed:", message);
  }
}

async function runAnalysis(env: Env, notify = true): Promise<AnalysisResult> {
  const session = getTradingSessionStatus(Date.now());
  if (!session.allowed) {
    return {
      id: crypto.randomUUID(), symbol: "XAUUSD", generatedAt: session.checkedAt,
      verdict: "NO_TRADE", side: "NEUTRAL", score: 0,
      scoreMeaning: "EVIDENCE_SCORE_NOT_PROBABILITY", entry: null, stopLoss: null,
      takeProfit: null, riskReward: null, reasons: [],
      blockers: ["خارج از ساعات مجاز؛ تحلیل ورود فقط در سشن لندن یا نیویورک و در روزهای کاری فعال است."],
      warnings: ["ساعت سشن‌ها بر اساس منطقه زمانی IANA و تغییر ساعت تابستانی محاسبه می‌شود."],
      agents: [], timeframes: {},
      researchStatus: env.ENABLE_TRADINGAGENTS === "true" ? "BLOCKED" : "DISABLED",
    };
  }
  if (!env.DB) throw new Error("D1 database is not configured");
  const now = Date.now();
  if (env.ENABLE_TRADINGAGENTS === "true") {
    const latest = await latestResearchRun(env.DB);
    const minimumIntervalMs = setting(env.TRADINGAGENTS_MIN_INTERVAL_MINUTES, 15) * 60_000;
    if (latest && now - latest.created_at >= 0 && now - latest.created_at < minimumIntervalMs) {
      return {
        id: crypto.randomUUID(), symbol: "XAUUSD", generatedAt: now,
        verdict: "NO_TRADE", side: "NEUTRAL", score: 0,
        scoreMeaning: "EVIDENCE_SCORE_NOT_PROBABILITY", entry: null, stopLoss: null,
        takeProfit: null, riskReward: null, reasons: [],
        blockers: ["برای حفظ سهمیه رایگان، فاصله اجرای پژوهش هنوز به حداقل " +
          Math.ceil(minimumIntervalMs / 60_000) + " دقیقه نرسیده است."],
        warnings: ["پژوهش جدید اجرا نشد و هیچ فراخوانی هوش مصنوعی انجام نگرفت."],
        agents: [], timeframes: {}, researchStatus: "BLOCKED",
      };
    }
  }
  const [one, five, thirty, risk, storedMacro] = await Promise.all([
    loadCandles(env.DB, "XAUUSD", "1m", 300),
    loadCandles(env.DB, "XAUUSD", "5m", 300),
    loadCandles(env.DB, "XAUUSD", "30m", 300),
    readRisk(env),
    latestMacroContext(env.DB),
  ]);
  const execution = await runTradingAgentsResearch({
    oneMinute: one, fiveMinute: five, thirtyMinute: thirty, macro: storedMacro,
    risk, now, modelName: env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it",
    minRiskReward: setting(env.MIN_RISK_REWARD, 1.5),
    stopAtrMultiplier: setting(env.STOP_ATR_MULTIPLIER, 1.2),
    macroMaxAgeMinutes: setting(env.MACRO_MAX_AGE_MINUTES, 30),
    highImpactBlockMinutes: setting(env.HIGH_IMPACT_BLOCK_MINUTES, 15),
    riskMaxAgeMs: setting(env.RISK_MAX_AGE_MINUTES, 2) * 60_000,
    marketDataSource: env.SIFTING_API_KEY ? "SiftingIO XAUUSD reference feed" : "D1 candle store; provider not recorded",
  }, env.AI, env.ENABLE_TRADINGAGENTS === "true", () => reserveAiRunBudget(
    env.DB!, tradingDayKey("UTC", new Date(now)),
    setting(env.TRADINGAGENTS_MAX_RUNS_PER_UTC_DAY, 8), now,
  ));
  if (execution.result.researchStatus !== "DISABLED") {
    await saveResearchRun(env.DB, {
      runId: execution.runId, createdAt: execution.result.generatedAt,
      status: execution.result.researchStatus ?? "FAILED", result: execution.result,
      evidence: execution.evidence, reports: execution.reports,
    });
  }
  await saveAnalysis(env.DB, execution.result);
  if (notify && execution.result.verdict !== "NO_TRADE") {
    const cooldownMs = setting(env.ALERT_COOLDOWN_MINUTES, 15) * 60_000;
    if (await claimSignalNotification(env.DB, execution.result.verdict, execution.result.generatedAt, cooldownMs)) {
      const sent = await sendTelegram(env, formatAnalysis(execution.result));
      if (!sent) await releaseSignalNotification(env.DB, execution.result.generatedAt);
    }
  }
  return execution.result;
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
      secret_token: await telegramWebhookToken(env.TELEGRAM_WEBHOOK_SECRET),
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

async function ensureTelegramWebhook(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return;
  const webhookUrl = "https://xau-ai-supervisor.novarw0hnqiw.workers.dev/telegram/webhook";
  const apiBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  try {
    const infoResponse = await fetch(`${apiBase}/getWebhookInfo`);
    const info: unknown = await infoResponse.json().catch(() => null);
    if (infoResponse.ok && asObject(info) && info.ok === true && asObject(info.result) && info.result.url === webhookUrl) return;
    const setResponse = await fetch(`${apiBase}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: await telegramWebhookToken(env.TELEGRAM_WEBHOOK_SECRET),
        allowed_updates: ["message"],
        drop_pending_updates: false,
      }),
    });
    const setResult: unknown = await setResponse.json().catch(() => null);
    if (!setResponse.ok || !asObject(setResult) || setResult.ok !== true) {
      console.error("Telegram webhook auto-setup failed", asObject(setResult) ? setResult.description : "Telegram API error");
      return;
    }
    console.log("Telegram webhook auto-setup completed");
  } catch (error) {
    console.error("Telegram webhook auto-setup request failed", error);
  }
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
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== await telegramWebhookToken(env.TELEGRAM_WEBHOOK_SECRET)) return json({ ok: false }, 401);
  let update: unknown;
  try { update = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!asObject(update) || !asObject(update.message) || !asObject(update.message.chat)) return json({ ok: true, ignored: true });
  const chatId = String(update.message.chat.id ?? "");
  const messageText = typeof update.message.text === "string" ? update.message.text.trim() : "";
  const command = messageText.split(/\s+/, 1)[0].split("@", 1)[0];
  if (!env.TELEGRAM_CHAT_ID || chatId !== env.TELEGRAM_CHAT_ID) return json({ ok: true, ignored: true });
  if (command === "/help" || command === "/start") {
    await sendTelegram(env, "دستورات:\n/status — وضعیت ریسک و موتور پژوهش\n/risk — ثبت دستی ریسک حساب\n/analyze — اجرای تحلیل جدید\n/test — آزمایش پیام رفت‌وبرگشت تلگرام\n/help — راهنما\n\nبرای ثبت ریسک بنویس:\n/risk 10000 9950\nعدد اول: Balance ابتدای روز معاملاتی در ساعت ۰۰:۰۰ UTC؛ عدد دوم: Equity فعلی با احتساب سود/زیان شناور. هر دو باید به یک ارز و مربوط به یک حساب باشند. این اطلاعات دستی است و ربات به بروکر وصل نیست.");
  } else if (command === "/test") {
    const sent = await sendTelegram(env, "آزمایش تلگرام: پیام فرمان دریافت شد و ارسال پاسخ از Worker انجام شد. هیچ تحلیلی یا سفارشی اجرا نشده است.");
    if (!sent) console.error("Telegram test reply could not be sent");
  } else if (command === "/risk") {
    if (!env.DB) {
      await sendTelegram(env, "ثبت ریسک انجام نشد: پایگاه داده در دسترس نیست.");
    } else {
      const values = parseRiskCommand(messageText);
      if (!values) {
        await sendTelegram(env, "فرمت درست نیست.\nنمونه: /risk 10000 9950\nعدد اول: Balance ابتدای روز معاملاتی در ساعت ۰۰:۰۰ UTC؛ عدد دوم: Equity فعلی با احتساب سود/زیان شناور. هر دو را از یک حساب و با یک ارز وارد کن.");
      } else {
        const timezone = configuredRiskTimezone(env);
        if (!timezone) {
          await sendTelegram(env, "ثبت ریسک انجام نشد: منطقه زمانی ریست روزانه در قوانین پراپ مشخص نشده است. تا تعیین منطقه زمانی، قفل ورود فعال می‌ماند و هیچ snapshot بر اساس UTC فرضی ثبت نمی‌شود.");
        } else {
          const dayKey = tradingDayKey(timezone);
          const existing = await env.DB.prepare("SELECT day_start_equity FROM daily_risk WHERE day_key = ?").bind(dayKey).first<{ day_start_equity: number }>();
          if (existing && Math.abs(existing.day_start_equity - values.dayStartEquity) > 0.000001) {
            await sendTelegram(env, "Balance ابتدای روز با مقدار ثبت‌شده امروز یکسان نیست. برای جلوگیری از محاسبه اشتباه، مقدار اول را تغییر ندادم. Balance مبنا: " + existing.day_start_equity);
          } else {
            const observedAt = Date.now();
            const risk = await saveRiskSnapshot(
              env.DB,
              dayKey,
              values.dayStartEquity,
              values.currentEquity,
              setting(env.MAX_DAILY_LOSS_PERCENT, 5),
              observedAt,
              setting(env.RISK_MAX_AGE_MINUTES, 2) * 60_000,
            );
            await sendTelegram(env, [
              "ثبت دستی وضعیت ریسک انجام شد.",
              "Balance ابتدای روز: " + values.dayStartEquity,
              "Equity فعلی: " + values.currentEquity,
              "افت روزانه: " + risk.lossPercent.toFixed(2) + "% / " + risk.maxDailyLossPercent.toFixed(2) + "%",
              "قفل روزانه: " + (risk.locked ? "فعال" : "غیرفعال"),
              "اعتبار زمانی: حداکثر ۲ دقیقه",
              "توجه: اعداد توسط کاربر وارد شده‌اند و مستقلاً از بروکر تأیید نشده‌اند.",
            ].join("\n"));
          }
        }
      }
    }
  } else if (command === "/status") {
    const risk = await readRisk(env);
    const latest = env.DB ? await latestAnalysis(env.DB) : null;
    let verdict: string | undefined;
    try { verdict = latest ? (JSON.parse(latest.payload_json) as AnalysisResult).verdict : undefined; } catch { verdict = "خطا در خواندن آخرین تحلیل"; }
    const feedStatus = await formatMarketFeedStatus(env);
    const session = getTradingSessionStatus(Date.now());
    const engineStatus = env.ENABLE_TRADINGAGENTS === "true" && env.AI && env.DB
      ? "فعال؛ سقف مصرف و کنترل‌های fail-closed روشن‌اند"
      : "غیرفعال؛ پیکربندی یا اتصال AI/D1 کامل نیست";
    await sendTelegram(env, formatStatus(risk, verdict) +
      "\nموتور TradingAgents: " + engineStatus +
      "\nمنطقه زمانی ریست روزانه: " + (configuredRiskTimezone(env) ?? "تعیین نشده؛ قفل ورود فعال است") +
      "\nسشن مجاز: " + (session.allowed ? session.sessions.join(" + ") : "خارج از سشن") +
      "\n\n" + feedStatus);
  } else if (command === "/analyze") {
    try { if (getTradingSessionStatus(Date.now()).allowed) { await refreshMarketData(env); await refreshMacroCalendar(env); } const result = await runAnalysis(env, false); await sendTelegram(env, formatAnalysis(result)); }
    catch (error) { await sendTelegram(env, `تحلیل انجام نشد: ${error instanceof Error ? error.message : "خطای نامشخص"}`); }
  } else {
    await sendTelegram(env, "دستور شناخته نشد. /help را بفرست.");
  }
  return json({ ok: true });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return json({ service: "XAU AI Supervisor", version: "0.3.0", mode: "analysis-and-alerts-only", researchFramework: "TauricResearch/TradingAgents v1.0.1 Worker port", endpoints: ["GET /health", "POST /market/candles", "POST /macro/context", "POST /risk/snapshot", "POST /analysis/run", "GET /analysis/latest", "GET /research/latest", "POST /telegram/webhook"] });
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, databaseConfigured: Boolean(env.DB), telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.TELEGRAM_WEBHOOK_SECRET), ingestSecretConfigured: Boolean(env.INGEST_SECRET), marketDataConfigured: Boolean(env.SIFTING_API_KEY), marketDataProvider: env.SIFTING_API_KEY ? "SiftingIO XAUUSD reference feed" : "not-configured", tradingAgentsEnabled: env.ENABLE_TRADINGAGENTS === "true", tradingAgentsReady: env.ENABLE_TRADINGAGENTS === "true" && Boolean(env.AI) && Boolean(env.DB) && Boolean(configuredRiskTimezone(env)), riskTimezoneConfigured: Boolean(configuredRiskTimezone(env)), aiBindingConfigured: Boolean(env.AI), executionEnabled: false });
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
    const timezone = configuredRiskTimezone(env);
    if (!timezone) return json({ ok: false, error: "RISK_TIMEZONE must be set to the prop firm's confirmed IANA daily-reset timezone" }, 503);
    const dayKey = tradingDayKey(timezone);
    const risk = await saveRiskSnapshot(env.DB, dayKey, body.dayStartEquity, body.currentEquity, setting(env.MAX_DAILY_LOSS_PERCENT, 5), body.observedAt, setting(env.RISK_MAX_AGE_MINUTES, 2) * 60_000);
    return json({ ok: true, risk });
  }
  if (request.method === "POST" && url.pathname === "/analysis/run") {
    try { return json({ ok: true, analysis: await runAnalysis(env) }); }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Analysis failed" }, 503); }
  }
  if (request.method === "GET" && url.pathname === "/research/latest") {
    if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
    if (!env.DB) return json({ ok: false, error: "D1 database is not configured" }, 503);
    const latest = await latestResearchRun(env.DB);
    return latest ? new Response(latest.payload_json, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : json({ ok: true, research: null });
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
    ctx.waitUntil(ensureTelegramWebhook(env));
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      try {
        if (controller.cron === "5 0 * * *") {
          await sendPaperDailyReport(env);
        } else if (controller.cron === "0 2 * * *") {
          const retention = Date.now() - 45 * 24 * 60 * 60 * 1000;
          await deleteOldCandles(env.DB!, retention);
          await deleteOldAnalyses(env.DB!, Date.now() - 90 * 24 * 60 * 60 * 1000);
          await deleteOldResearchRuns(env.DB!, Date.now() - 90 * 24 * 60 * 60 * 1000);
          await env.DB!.prepare("DELETE FROM ai_daily_budget WHERE day_key < date('now', '-30 days')").run();
        } else {
          // Paper Trading runs across the full XAUUSD market week, independent of London/New York sessions.
          // Skip Saturday and Sunday before 20:00 UTC while the gold market is normally closed.
          const now = new Date();
          const utcDay = now.getUTCDay();
          const utcHour = now.getUTCHours();
          if (utcDay === 6 || (utcDay === 0 && utcHour < 20)) return;
          await refreshMarketData(env);
          await processPaperTrading(env);
          // Keep the AI research/alert engine restricted to its configured London/New York sessions.
          if (!getTradingSessionStatus(Date.now()).allowed) return;
          await refreshMacroCalendar(env);
          if (env.ENABLE_TRADINGAGENTS !== "true") return;
          const latest = await latestResearchRun(env.DB!);
          const minIntervalMs = setting(env.TRADINGAGENTS_MIN_INTERVAL_MINUTES, 15) * 60_000;
          if (latest && Date.now() - latest.created_at < minIntervalMs) return;
          await runAnalysis(env);
        }
      } catch (error) {
        console.error("Scheduled XAU supervisor task failed", error);
      }
    })());
  },
};