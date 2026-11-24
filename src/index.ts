export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
  MIN_CONFIDENCE?: string;
  MIN_RISK_REWARD?: string;
  MAX_DAILY_LOSS_PERCENT?: string;
  SUPERVISOR_KV?: KVNamespace;
}

type Side = "BUY" | "SELL";
interface Signal {
  id?: string;
  symbol: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  strategy?: string;
  secret?: string;
  timestamp?: string;
}
interface DailyState { date: string; realizedLossPercent: number; locked: boolean; trades: number; }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }
function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback;
}
function validateSignal(s: Signal, env: Env): string[] {
  const errors: string[] = [];
  if (!s || typeof s !== "object") return ["Invalid JSON signal"];
  if (!/^[A-Z0-9._-]{3,20}$/.test(s.symbol)) errors.push("Invalid symbol");
  if (s.side !== "BUY" && s.side !== "SELL") errors.push("Side must be BUY or SELL");
  for (const [key, value] of [["entry", s.entry], ["stopLoss", s.stopLoss], ["takeProfit", s.takeProfit], ["confidence", s.confidence]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${key} must be a finite number`);
  }
  if (s.confidence < 0 || s.confidence > 100) errors.push("Confidence must be 0..100");
  if (s.side === "BUY" && !(s.stopLoss < s.entry && s.takeProfit > s.entry)) errors.push("BUY requires SL < entry < TP");
  if (s.side === "SELL" && !(s.takeProfit < s.entry && s.stopLoss > s.entry)) errors.push("SELL requires TP < entry < SL");
  if (errors.length === 0) {
    const risk = Math.abs(s.entry - s.stopLoss);
    const reward = Math.abs(s.takeProfit - s.entry);
    if (risk <= 0 || reward / risk < numberSetting(env.MIN_RISK_REWARD, 1.2)) errors.push("Risk/reward is below the configured minimum");
    if (s.confidence < numberSetting(env.MIN_CONFIDENCE, 70)) errors.push("Confidence is below the configured minimum");
  }
  return errors;
}
async function telegram(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  return response.ok;
}
async function readDailyState(env: Env): Promise<DailyState> {
  const date = todayUTC();
  if (!env.SUPERVISOR_KV) return { date, realizedLossPercent: 0, locked: false, trades: 0 };
  const saved = await env.SUPERVISOR_KV.get<DailyState>("daily-state", "json");
  return saved?.date === date ? saved : { date, realizedLossPercent: 0, locked: false, trades: 0 };
}

async function handleSignal(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) return json({ ok: false, error: "Server is not configured: WEBHOOK_SECRET is missing" }, 503);
  let signal: Signal;
  try { signal = await request.json() as Signal; } catch { return json({ ok: false, error: "Request body must be valid JSON" }, 400); }
  if (signal.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: "Unauthorized" }, 401);
  const errors = validateSignal(signal, env);
  if (errors.length) return json({ ok: false, rejected: true, errors }, 422);
  const daily = await readDailyState(env);
  if (daily.locked) return json({ ok: false, rejected: true, errors: ["Daily risk lock is active"] }, 423);
  if (signal.id && env.SUPERVISOR_KV) {
    if (await env.SUPERVISOR_KV.get(`signal:${signal.id}`)) return json({ ok: true, duplicate: true });
    await env.SUPERVISOR_KV.put(`signal:${signal.id}`, "1", { expirationTtl: 86400 });
  }
  const rr = (Math.abs(signal.takeProfit - signal.entry) / Math.abs(signal.entry - signal.stopLoss)).toFixed(2);
  const message = [
    `XAU AI SUPERVISOR | ${signal.side}`,
    `Symbol: ${signal.symbol}`,
    `Entry: ${signal.entry}`,
    `Stop Loss: ${signal.stopLoss}`,
    `Take Profit: ${signal.takeProfit}`,
    `Risk/Reward: 1:${rr}`,
    `Confidence: ${signal.confidence}%`,
    `Strategy: ${signal.strategy || "Not specified"}`,
    "Status: PASSED SUPERVISOR FILTERS — NOT AN EXECUTION ORDER"
  ].join("\n");
  const sent = await telegram(env, message);
  return json({ ok: true, accepted: true, telegramSent: sent, riskReward: Number(rr), note: "Signal validated; no broker order was placed." });
}

async function handleTelegramUpdate(request: Request, env: Env): Promise<Response> {
  let update: any;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  const chatId = String(update?.message?.chat?.id ?? "");
  const text = String(update?.message?.text ?? "").trim();
  if (!chatId || !text) return json({ ok: true, ignored: true });
  if (env.TELEGRAM_CHAT_ID && chatId !== env.TELEGRAM_CHAT_ID) return json({ ok: true, ignored: true });
  const daily = await readDailyState(env);
  let reply = "XAU AI Supervisor\n/help - commands\n/status - system and risk status";
  if (text === "/status") reply = [
    "XAU AI SUPERVISOR STATUS",
    `Date (UTC): ${daily.date}`,
    `Accepted trades: ${daily.trades}`,
    `Daily loss: ${daily.realizedLossPercent.toFixed(2)}%`,
    `Risk lock: ${daily.locked ? "ACTIVE" : "OFF"}`,
    `KV storage: ${env.SUPERVISOR_KV ? "CONNECTED" : "NOT CONFIGURED"}`
  ].join("\n");
  await telegram(env, reply);
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ name: "XAU AI Supervisor", version: "0.1.0", status: "online", endpoints: ["/health", "/signal", "/telegram/webhook"] });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "xau-ai-supervisor", telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), webhookConfigured: Boolean(env.WEBHOOK_SECRET), storageConfigured: Boolean(env.SUPERVISOR_KV) });
    if (request.method === "POST" && url.pathname === "/signal") return handleSignal(request, env);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") return handleTelegramUpdate(request, env);
    return json({ ok: false, error: "Not found" }, 404);
  },
  async scheduled(_controller: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.resolve());
  }
};
