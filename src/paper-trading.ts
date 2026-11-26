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
const MAX_M1_AGE_MS = 6 * MS["1m"];
const MAX_M5_AGE_MS = 10 * MS["1m"];
const MAX_M30_AGE_MS = 36 * MS["1m"];

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
    id:string;side:string;lots:number;units:number;entry_price:number;stop_loss:number;take_profit:number;opened_at:number;
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
    // Entry and exit prices both include the assumed half-spread. This is the
    // realized simulated P/L after the assumed spread, before any other fees.
    const gross = (p.side === "BUY" ? exit-p.entry_price : p.entry_price-exit)*p.units;
    const costs = 0;
    const net = gross-costs;
    const before = await db.prepare("SELECT balance FROM paper_state WHERE id=1").first<{balance:number}>();
    const balanceBefore = before?.balance ?? START_BALANCE;
    const balanceAfter = balanceBefore + net;
    const returnPercent = balanceBefore > 0 ? net / balanceBefore * 100 : 0;
    const report = JSON.stringify({
      side:p.side, lots:p.lots, entry:p.entry_price, exit, net, returnPercent,
      reason, openedAt:p.opened_at, closedAt:candle.time+MS["1m"], balanceAfter,
    });
    await db.batch([
      db.prepare(`UPDATE paper_positions SET status='CLOSED',closed_at=?,exit_price=?,gross_pnl=?,costs=?,net_pnl=?,close_reason=? WHERE id=? AND status='OPEN'`).bind(candle.time+MS["1m"],exit,gross,costs,net,reason,p.id),
      db.prepare("UPDATE paper_state SET balance=balance+? WHERE id=1").bind(net),
      db.prepare("INSERT OR IGNORE INTO paper_trade_notifications(position_id,payload,created_at) VALUES(?,?,?)").bind(p.id,report,candle.time+MS["1m"]),
    ]);
  }
}
async function flushClosedTradeReports(env: Env): Promise<void> {
  if (!env.DB) return;
  const pending = await env.DB.prepare(
    "SELECT position_id,payload,attempts FROM paper_trade_notifications WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT 20",
  ).all<{position_id:string;payload:string;attempts:number}>();
  if (!pending.results?.length) return;
  const state = await env.DB.prepare("SELECT balance,equity FROM paper_state WHERE id=1")
    .first<{balance:number;equity:number}>();
  for (const row of pending.results) {
    try {
      const trade = JSON.parse(row.payload) as {
        side:string;lots:number;entry:number;exit:number;net:number;returnPercent:number;
        reason:string;openedAt:number;closedAt:number;balanceAfter:number;
      };
      const pnl = (trade.net >= 0 ? "+" : "-") + "$" + Math.abs(trade.net).toFixed(2);
      const pct = (trade.returnPercent >= 0 ? "+" : "") + trade.returnPercent.toFixed(3) + "%";
      const duration = Math.max(0, Math.round((trade.closedAt-trade.openedAt)/60_000));
      const reason = trade.reason === "TAKE_PROFIT" ? "حد سود" : "حد ضرر";
      const message = [
        "گزارش معامله بسته‌شده — Paper Trading / XAUUSD",
        "نتیجه: " + (trade.net >= 0 ? "سود" : "ضرر"),
        "جهت: " + trade.side + " | حجم: " + trade.lots.toFixed(2) + " لات",
        "قیمت ورود: " + trade.entry.toFixed(2),
        "قیمت خروج: " + trade.exit.toFixed(2),
        "سود/زیان خالص پس از اسپرد فرضی: " + pnl + " (" + pct + ")",
        "علت خروج: " + reason,
        "مدت معامله: " + duration + " دقیقه",
        "Balance مجازی: $" + (state?.balance ?? trade.balanceAfter).toFixed(2),
        "Equity مجازی: $" + (state?.equity ?? trade.balanceAfter).toFixed(2),
        "شناسه: " + row.position_id.slice(0,8),
        "قیمت مرجع SiftingIO است؛ این گزارش اجرای بروکر واقعی نیست.",
      ].join("\n");
      const sent = await sendTelegram(env,message);
      if (sent) {
        await env.DB.prepare("UPDATE paper_trade_notifications SET sent_at=?,attempts=attempts+1,last_error=NULL WHERE position_id=? AND sent_at IS NULL")
          .bind(Date.now(),row.position_id).run();
      } else {
        await env.DB.prepare("UPDATE paper_trade_notifications SET attempts=attempts+1,last_error=? WHERE position_id=? AND sent_at IS NULL")
          .bind("Telegram did not confirm message delivery",row.position_id).run();
      }
    } catch (error) {
      await env.DB.prepare("UPDATE paper_trade_notifications SET attempts=attempts+1,last_error=? WHERE position_id=? AND sent_at IS NULL")
        .bind((error instanceof Error ? error.message : "Unknown notification error").slice(0,300),row.position_id).run();
    }
  }
}
async function maybeOpen(db: D1Database, now: number, allowEntry: boolean): Promise<string | null> {
  if (!allowEntry) return null;
  const [one,five,thirty] = await Promise.all([
    loadCandles(db,"XAUUSD","1m",80),loadCandles(db,"XAUUSD","5m",80),loadCandles(db,"XAUUSD","30m",80)
  ]);
  if (one.length<55 || five.length<55 || thirty.length<55) return null;
  const last=one.at(-1)!, prev=one.at(-2)!;
  if (now-(last.time+MS["1m"])>MAX_M1_AGE_MS || now-(five.at(-1)!.time+MS["5m"])>MAX_M5_AGE_MS || now-(thirty.at(-1)!.time+MS["30m"])>MAX_M30_AGE_MS) return null;
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
  if (!state || state.daily_locked===1) return null;
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
  const db = env.DB;
  await ensureState(db,now);
  const last=(await loadCandles(db,"XAUUSD","1m",1))[0];
  if (!last || now-(last.time+MS["1m"])>MAX_M1_AGE_MS) {
    await flushClosedTradeReports(env);
    return;
  }

  const state = await db.prepare(
    "SELECT last_processed_bar FROM paper_state WHERE id=1",
  ).first<{last_processed_bar:number}>();
  if (!state) return;

  // On first activation, establish a clean watermark instead of replaying old history.
  if (state.last_processed_bar === 0) {
    await db.prepare("UPDATE paper_state SET last_processed_bar=?,updated_at=? WHERE id=1")
      .bind(last.time,now).run();
    await updateEquity(db,now);
    await flushClosedTradeReports(env);
    return;
  }

  const pending = await db.prepare(
    `SELECT ts AS time,open,high,low,close,volume FROM market_candles
     WHERE symbol='XAUUSD' AND timeframe='1m' AND ts>? AND ts<=?
     ORDER BY ts ASC LIMIT 2000`,
  ).bind(state.last_processed_bar,last.time).all<Candle>();
  const candles = pending.results ?? [];
  if (candles.length === 0) {
    await updateEquity(db,now);
    await flushClosedTradeReports(env);
    return;
  }

  // Process every newly available minute in order so a 4-minute polling cadence
  // cannot skip a stop-loss or take-profit touched between scheduled runs.
  for (const candle of candles) {
    await closeOpen(db,candle);
    await db.prepare("UPDATE paper_state SET last_processed_bar=?,updated_at=? WHERE id=1")
      .bind(candle.time,now).run();
  }

  await updateEquity(db,now);
  await flushClosedTradeReports(env);
  const day = utcDay(now);
  const dayState = await db.prepare("SELECT day_key,equity FROM paper_state WHERE id=1")
    .first<{day_key:string;equity:number}>();
  if (dayState && dayState.day_key !== day) {
    await db.prepare("UPDATE paper_state SET day_key=?,daily_start_equity=equity,daily_locked=0,updated_at=? WHERE id=1")
      .bind(day,now).run();
  }

  // Only consider a new entry when the newest closed candle was processed in this run.
  // Older missed candles are used for exits, never for retrospective entries.
  const caughtUp = candles.at(-1)!.time === last.time;
  const alert = await maybeOpen(db,now,caughtUp);
  await db.prepare("UPDATE paper_state SET last_processed_bar=MAX(last_processed_bar,?),updated_at=? WHERE id=1")
    .bind(last.time,now).run();
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
