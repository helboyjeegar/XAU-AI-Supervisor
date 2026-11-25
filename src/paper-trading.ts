import type { Candle } from "./types.ts";
import { loadCandles } from "./storage.ts";
import { sendTelegram } from "./telegram.ts";
import type { Env } from "./types.ts";

const START_BALANCE = 10_000;
const LOTS = 0.01;
const CONTRACT_OZ_PER_LOT = 100;
const SPREAD_USD_PER_OZ = 0.30;
const STOP_ATR = 1.2;
const TARGET_R = 1.8;
const MAX_DAILY_DD = 5;
const MS = { "1m": 60_000, "5m": 300_000, "30m": 1_800_000 } as const;

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const x of values.slice(period)) value = x * k + value * (1 - k);
  return value;
}
function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function trend(c: Candle[]): "BUY" | "SELL" | null {
  const closes = c.map(x => x.close);
  const fast = ema(closes, 20), slow = ema(closes, 50);
  if (fast === null || slow === null) return null;
  return fast > slow ? "BUY" : fast < slow ? "SELL" : null;
}
function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function priceExit(side: string, raw: number): number {
  return side === "BUY" ? raw - SPREAD_USD_PER_OZ / 2 : raw + SPREAD_USD_PER_OZ / 2;
}
function priceEntry(side: string, raw: number): number {
  return side === "BUY" ? raw + SPREAD_USD_PER_OZ / 2 : raw - SPREAD_USD_PER_OZ / 2;
}
async function ensureState(db: D1Database, now: number): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO paper_state
    (id,balance,equity,peak_equity,daily_start_equity,day_key,daily_locked,last_processed_bar,updated_at)
    VALUES (1,?,?,?,?,?,0,0,?)`).bind(START_BALANCE, START_BALANCE, START_BALANCE, START_BALANCE, utcDay(now), now).run();
}
async function updateEquity(db: D1Database, now: number): Promise<void> {
  const state = await db.prepare("SELECT balance FROM paper_state WHERE id=1").first<{balance:number}>();
  const open = await db.prepare("SELECT side,units,entry_price FROM paper_positions WHERE status='OPEN'").all<{side:string;units:number;entry_price:number}>();
  const last = await loadCandles(db,"XAUUSD","1m",1);
  let floating = 0;
  if (last[0]) for (const p of open.results ?? []) {
    const exit = priceExit(p.side,last[0].close);
    floating += (p.side === "BUY" ? exit-p.entry_price : p.entry_price-exit)*p.units;
  }
  const equity = (state?.balance ?? START_BALANCE)+floating;
  await db.prepare("UPDATE paper_state SET equity=?, peak_equity=MAX(peak_equity,?), updated_at=? WHERE id=1").bind(equity,equity,now).run();
}
async function closeOpen(db: D1Database, candle: Candle): Promise<void> {
  const open = await db.prepare("SELECT * FROM paper_positions WHERE status='OPEN' ORDER BY opened_at").all<{
    id:string;side:string;units:number;entry_price:number;stop_loss:number;take_profit:number;
  }>();
  for (const p of open.results ?? []) {
    let raw: number | null = null, reason = "";
    if (p.side === "BUY") {
      if (candle.low <= p.stop_loss) { raw=p.stop_loss; reason="STOP_LOSS"; }
      else if (candle.high >= p.take_profit) { raw=p.take_profit; reason="TAKE_PROFIT"; }
    } else {
      if (candle.high >= p.stop_loss) { raw=p.stop_loss; reason="STOP_LOSS"; }
      else if (candle.low <= p.take_profit) { raw=p.take_profit; reason="TAKE_PROFIT"; }
    }
    if (raw === null) continue;
    const exit = priceExit(p.side,raw);
    const gross = (p.side === "BUY" ? exit-p.entry_price : p.entry_price-exit)*p.units;
    const costs = 0;
    const net = gross-costs;
    await db.batch([
      db.prepare(`UPDATE paper_positions SET status='CLOSED',closed_at=?,exit_price=?,gross_pnl=?,costs=?,net_pnl=?,close_reason=? WHERE id=? AND status='OPEN'`).bind(candle.time+MS["1m"],exit,gross,costs,net,reason,p.id),
      db.prepare("UPDATE paper_state SET balance=balance+? WHERE id=1").bind(net)
    ]);
  }
}
async function maybeOpen(db: D1Database, now: number): Promise<string | null> {
  const [one,five,thirty] = await Promise.all([
    loadCandles(db,"XAUUSD","1m",80),loadCandles(db,"XAUUSD","5m",80),loadCandles(db,"XAUUSD","30m",80)
  ]);
  if (one.length<55 || five.length<55 || thirty.length<55) return null;
  const last=one.at(-1)!, prev=one.at(-2)!;
  if (now-(last.time+MS["1m"])>180_000 || now-(five.at(-1)!.time+MS["5m"])>420_000 || now-(thirty.at(-1)!.time+MS["30m"])>1_920_000) return null;
  const side5=trend(five), side30=trend(thirty);
  if (!side5 || side5!==side30) return null;
  const closes=one.map(c=>c.close), prevEma=ema(closes.slice(0,-1),20), currentEma=ema(closes,20);
  const momentum=rsi(closes), volatility=atr(one);
  if (prevEma===null || currentEma===null || momentum===null || volatility===null || volatility<=0) return null;
  const side = side5==="BUY" && prev.close<=prevEma && last.close>currentEma && momentum>=50 && momentum<=68
    ? "BUY" : side5==="SELL" && prev.close>=prevEma && last.close<currentEma && momentum<=50 && momentum>=32 ? "SELL" : null;
  if (!side) return null;
  const state=await db.prepare("SELECT * FROM paper_state WHERE id=1").first<{
    balance:number;equity:number;daily_start_equity:number;day_key:string;daily_locked:number;last_processed_bar:number;
  }>();
  if (!state || state.daily_locked===1 || last.time<=state.last_processed_bar) return null;
  if ((await db.prepare("SELECT id FROM paper_positions WHERE status='OPEN' LIMIT 1").first())) return null;
  const day=utcDay(now);
  if (state.day_key!==day) await db.prepare("UPDATE paper_state SET day_key=?,daily_start_equity=equity,daily_locked=0 WHERE id=1").bind(day).run();
  const refreshed=await db.prepare("SELECT * FROM paper_state WHERE id=1").first<{balance:number;equity:number;daily_start_equity:number;daily_locked:number}>();
  if (!refreshed || refreshed.equity <= refreshed.daily_start_equity*(1-MAX_DAILY_DD/100)) {
    await db.prepare("UPDATE paper_state SET daily_locked=1,last_processed_bar=? WHERE id=1").bind(last.time).run();
    return null;
  }
  const entry=priceEntry(side,last.close), distance=volatility*STOP_ATR;
  const stop=side==="BUY"?entry-distance:entry+distance;
  const target=side==="BUY"?entry+distance*TARGET_R:entry-distance*TARGET_R;
  const id=crypto.randomUUID(), units=LOTS*CONTRACT_OZ_PER_LOT;
  await db.batch([
    db.prepare(`INSERT INTO paper_positions(id,side,lots,units,entry_price,stop_loss,take_profit,opened_at,status)
      VALUES(?,?,?,?,?,?,?,?,'OPEN')`).bind(id,side,LOTS,units,entry,stop,target,last.time+MS["1m"]),
    db.prepare("UPDATE paper_state SET last_processed_bar=?,updated_at=? WHERE id=1").bind(last.time,now)
  ]);
  return `معامله شبیه‌سازی‌شده جدید: ${side}\nورود: ${entry.toFixed(2)}\nحد ضرر: ${stop.toFixed(2)}\nحد سود: ${target.toFixed(2)}\nحجم: ${LOTS.toFixed(2)} لات\nمبنای قیمت: SiftingIO؛ نه قیمت اجرای بروکر.`;
}
export async function processPaperTrading(env: Env, now=Date.now()): Promise<void> {
  if (!env.DB || !env.SIFTING_API_KEY) return;
  await ensureState(env.DB,now);
  const last=(await loadCandles(env.DB,"XAUUSD","1m",1))[0];
  if (!last || now-(last.time+MS["1m"])>180_000) return;
  await closeOpen(env.DB,last);
  await updateEquity(env.DB,now);
  const day = utcDay(now);
  const state = await env.DB.prepare("SELECT day_key,equity FROM paper_state WHERE id=1").first<{day_key:string;equity:number}>();
  if (state && state.day_key !== day) {
    await env.DB.prepare("UPDATE paper_state SET day_key=?,daily_start_equity=equity,daily_locked=0,updated_at=? WHERE id=1").bind(day,now).run();
  }
  const alert=await maybeOpen(env.DB,now);
  if (alert) await sendTelegram(env,alert);
}
export async function sendPaperDailyReport(env: Env, now=Date.now()): Promise<void> {
  if (!env.DB) return;
  await ensureState(env.DB,now);
  const yesterday=new Date(now-86_400_000).toISOString().slice(0,10);
  const already=await env.DB.prepare("SELECT day_key FROM paper_daily_reports WHERE day_key=?").bind(yesterday).first();
  if (already) return;
  const stats=await env.DB.prepare(`SELECT COUNT(*) AS trades,
    SUM(CASE WHEN net_pnl>0 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN net_pnl<=0 THEN 1 ELSE 0 END) AS losses,
    COALESCE(SUM(net_pnl),0) AS net,
    COALESCE(SUM(gross_pnl),0) AS gross,
    COALESCE(SUM(costs),0) AS costs
    FROM paper_positions WHERE status='CLOSED' AND closed_at>=? AND closed_at<?`)
    .bind(Date.parse(yesterday+"T00:00:00Z"),Date.parse(utcDay(now)+"T00:00:00Z")).first<{
      trades:number;wins:number;losses:number;net:number;gross:number;costs:number;
    }>();
  const state=await env.DB.prepare("SELECT balance,equity,peak_equity FROM paper_state WHERE id=1").first<{
    balance:number;equity:number;peak_equity:number;
  }>();
  const open=await env.DB.prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE status='OPEN'").first<{n:number}>();
  const message=[
    "گزارش روزانه Paper Trading — XAU/USD",
    "روز معاملاتی UTC: "+yesterday,
    "تعداد معاملات بسته‌شده: "+(stats?.trades??0),
    "سودده: "+(stats?.wins??0)+" | زیان‌ده: "+(stats?.losses??0),
    "سود/زیان ناخالص: $"+(stats?.gross??0).toFixed(2),
    "هزینه شبیه‌سازی‌شده: $"+(stats?.costs??0).toFixed(2),
    "سود/زیان خالص روز: $"+(stats?.net??0).toFixed(2),
    "Balance شبیه‌سازی: $"+(state?.balance??START_BALANCE).toFixed(2),
    "Equity شبیه‌سازی: $"+(state?.equity??START_BALANCE).toFixed(2),
    "معاملات باز: "+(open?.n??0),
    "حساب مجازی؛ بدون سفارش بروکر. حجم ثابت 0.01 لات؛ فرض قرارداد 100 اونس/لات؛ اسپرد فرضی 0.30 دلار/اونس.",
  ].join("\n");
  const sent=await sendTelegram(env,message);
  if (sent) await env.DB.prepare("INSERT OR IGNORE INTO paper_daily_reports(day_key,sent_at,payload) VALUES(?,?,?)")
    .bind(yesterday,now,message).run();
}
