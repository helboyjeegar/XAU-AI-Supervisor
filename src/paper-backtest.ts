import type { Candle } from "./types.ts";
import { resampleCandles } from "./market-feed.ts";

const MINUTE = 60_000;
const START_BALANCE = 10_000;
const LOTS = 0.01;
const UNITS = 1; // 0.01 lot × assumed 100 oz/lot
const HALF_SPREAD = 0.15;
const STOP_ATR = 1.2;
const TARGET_R = 1.8;
const DAILY_DD = 5;

function goldMarketOpen(timestampMs: number): boolean {
  const date = new Date(timestampMs);
  const day = date.getUTCDay();
  return day !== 6 && !(day === 0 && date.getUTCHours() < 20);
}

export interface MonthlyBacktestResult {
  month: string;
  complete: boolean;
  startBalance: number;
  endBalance: number;
  netPnl: number;
  returnPercent: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  profitFactor: number | null;
  averageTrade: number;
  maxDrawdownPercent: number;
  candles: number;
  gapsOverOneMinute: number;
  firstCandleAt: number | null;
  lastCandleAt: number | null;
  assumptions: string[];
}

interface Position {
  side: "BUY" | "SELL";
  entry: number;
  stop: number;
  target: number;
  openedAt: number;
}

function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null);
  if (values.length < period) return out;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = value;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    value = values[i]! * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

function rsiSeries(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let gain = 0, loss = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const delta = values[j]! - values[j - 1]!;
      if (delta > 0) gain += delta;
      else loss -= delta;
    }
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const tr: number[] = Array(candles.length).fill(0);
  const out: (number | null)[] = Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i >= period) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += tr[j]!;
      out[i] = sum / period;
    }
  }
  return out;
}

function utcDay(ts: number): string { return new Date(ts).toISOString().slice(0, 10); }
function halfSpreadPrice(side: "BUY" | "SELL", raw: number, entry: boolean): number {
  const signed = side === "BUY" ? 1 : -1;
  return raw + signed * (entry ? HALF_SPREAD : -HALF_SPREAD);
}

export async function runPaperBacktestMonth(db: D1Database, month: string, now = Date.now()): Promise<MonthlyBacktestResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month must use YYYY-MM format");
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber! < 1 || monthNumber! > 12) throw new Error("invalid month");
  const start = Date.UTC(year!, monthNumber! - 1, 1);
  const end = Date.UTC(year!, monthNumber!, 1);
  if (start >= now) throw new Error("requested month is in the future");
  const warmupStart = start - 3 * 86_400_000;

  const rows = await db.prepare(
    `SELECT ts AS time,open,high,low,close,volume FROM market_candles
     WHERE symbol='XAUUSD' AND timeframe='1m' AND ts>=? AND ts<?
     ORDER BY ts ASC`,
  ).bind(warmupStart, end).all<Candle>();
  const candles = rows.results ?? [];
  const inMonth = candles.filter(c => c.time >= start && c.time < end);
  const gapsOverOneMinute = inMonth.slice(1).filter((c, i) => c.time - inMonth[i]!.time > MINUTE).length;
  const assumptions = [
    "همان قواعد Paper فعلی: EMA20/50 در 5m و 30m، برگشت قیمت از EMA20 در 1m، RSI14 و ATR14.",
    "ورود در تمام ساعات معمول بازبودن بازار طلا؛ شنبه و یکشنبه پیش از ۲۰:۰۰ UTC بدون ورود، مطابق زمان‌بندی Worker.",
    "حجم ثابت 0.01 لات؛ قرارداد فرضی 100 اونس در هر لات (1 اونس برای این حجم).",
    "اسپرد فرضی 0.30 دلار به‌ازای هر اونس؛ کمیسیون و اسلیپیج جداگانه صفر فرض شده‌اند.",
    "اگر SL و TP در یک کندل لمس شوند، محافظه‌کارانه SL مقدم است.",
    "سرمایه مجازی ابتدای هر ماه 10,000 دلار؛ معاملات باز انتهای ماه با قیمت بسته‌شدن آخرین کندل تسویه می‌شوند.",
    "این بک‌تست روی قیمت مرجع SiftingIO است، نه قیمت اختصاصی بروکر.",
  ];

  if (inMonth.length < 100) {
    const result: MonthlyBacktestResult = {
      month, complete: end <= now, startBalance: START_BALANCE, endBalance: START_BALANCE,
      netPnl: 0, returnPercent: 0, trades: 0, wins: 0, losses: 0, winRatePercent: 0,
      profitFactor: null, averageTrade: 0, maxDrawdownPercent: 0, candles: inMonth.length,
      gapsOverOneMinute, firstCandleAt: inMonth[0]?.time ?? null,
      lastCandleAt: inMonth.at(-1)?.time ?? null, assumptions,
    };
    await saveResult(db, result, now);
    return result;
  }

  const five = resampleCandles(candles, "5m");
  const thirty = resampleCandles(candles, "30m");
  const close1 = candles.map(c => c.close);
  const e20_1 = emaSeries(close1, 20);
  const rsi1 = rsiSeries(close1);
  const atr1 = atrSeries(candles);
  const e20_5 = emaSeries(five.map(c => c.close), 20);
  const e50_5 = emaSeries(five.map(c => c.close), 50);
  const e20_30 = emaSeries(thirty.map(c => c.close), 20);
  const e50_30 = emaSeries(thirty.map(c => c.close), 50);

  let p5 = 0, p30 = 0;
  let balance = START_BALANCE, peak = START_BALANCE, maxDrawdown = 0;
  let dailyStart = START_BALANCE, dayKey = "";
  let dailyLocked = false;
  let position: Position | null = null;
  const pnls: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i]!;
    const decisionAt = candle.time + MINUTE;
    if (decisionAt < start || candle.time >= end) continue;

    const day = utcDay(decisionAt);
    if (day !== dayKey) {
      dayKey = day;
      dailyStart = balance;
      dailyLocked = false;
    }

    while (p5 + 1 < five.length && five[p5 + 1]!.time + 5 * MINUTE <= decisionAt) p5++;
    while (p30 + 1 < thirty.length && thirty[p30 + 1]!.time + 30 * MINUTE <= decisionAt) p30++;

    if (position) {
      let rawExit: number | null = null;
      if (position.side === "BUY") {
        if (candle.low <= position.stop) rawExit = position.stop;
        else if (candle.high >= position.target) rawExit = position.target;
      } else {
        if (candle.high >= position.stop) rawExit = position.stop;
        else if (candle.low <= position.target) rawExit = position.target;
      }
      if (rawExit !== null) {
        const exit = halfSpreadPrice(position.side, rawExit, false);
        const pnl = (position.side === "BUY" ? exit - position.entry : position.entry - exit) * UNITS;
        balance += pnl;
        pnls.push(pnl);
        position = null;
      }
    }

    const floating = position
      ? (position.side === "BUY"
          ? halfSpreadPrice("BUY", candle.close, false) - position.entry
          : position.entry - halfSpreadPrice("SELL", candle.close, false)) * UNITS
      : 0;
    const equity = balance + floating;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    if (equity <= dailyStart * (1 - DAILY_DD / 100)) dailyLocked = true;

    if (position || dailyLocked || !goldMarketOpen(decisionAt)) continue;
    const side5 = e20_5[p5] === null || e50_5[p5] === null ? null
      : e20_5[p5]! > e50_5[p5]! ? "BUY" : e20_5[p5]! < e50_5[p5]! ? "SELL" : null;
    const side30 = e20_30[p30] === null || e50_30[p30] === null ? null
      : e20_30[p30]! > e50_30[p30]! ? "BUY" : e20_30[p30]! < e50_30[p30]! ? "SELL" : null;
    if (!side5 || side5 !== side30) continue;
    const prevEma = e20_1[i - 1], currentEma = e20_1[i];
    const momentum = rsi1[i], volatility = atr1[i];
    if (prevEma === null || currentEma === null || momentum === null || volatility === null || volatility <= 0) continue;
    const side = side5 === "BUY" && candles[i - 1]!.close <= prevEma && candle.close > currentEma && momentum >= 50 && momentum <= 68
      ? "BUY" : side5 === "SELL" && candles[i - 1]!.close >= prevEma && candle.close < currentEma && momentum <= 50 && momentum >= 32
        ? "SELL" : null;
    if (!side) continue;

    const entry = halfSpreadPrice(side, candle.close, true);
    const distance = volatility * STOP_ATR;
    position = {
      side, entry,
      stop: side === "BUY" ? entry - distance : entry + distance,
      target: side === "BUY" ? entry + distance * TARGET_R : entry - distance * TARGET_R,
      openedAt: decisionAt,
    };
  }

  // A month-end mark-to-market prevents an unreported open position from leaking into the next month.
  if (position && inMonth.length) {
    const last = inMonth.at(-1)!;
    const exit = halfSpreadPrice(position.side, last.close, false);
    const pnl = (position.side === "BUY" ? exit - position.entry : position.entry - exit) * UNITS;
    balance += pnl;
    pnls.push(pnl);
  }

  const wins = pnls.filter(x => x > 0).length;
  const losses = pnls.filter(x => x <= 0).length;
  const grossWin = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  const netPnl = balance - START_BALANCE;
  const result: MonthlyBacktestResult = {
    month, complete: end <= now, startBalance: START_BALANCE, endBalance: balance,
    netPnl, returnPercent: netPnl / START_BALANCE * 100, trades: pnls.length,
    wins, losses, winRatePercent: pnls.length ? wins / pnls.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    averageTrade: pnls.length ? netPnl / pnls.length : 0,
    maxDrawdownPercent: maxDrawdown, candles: inMonth.length, gapsOverOneMinute,
    firstCandleAt: inMonth[0]?.time ?? null, lastCandleAt: inMonth.at(-1)?.time ?? null,
    assumptions,
  };
  await saveResult(db, result, now);
  return result;
}

async function saveResult(db: D1Database, result: MonthlyBacktestResult, now: number): Promise<void> {
  await db.prepare(`INSERT INTO paper_backtest_monthly(month,generated_at,result_json)
    VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET generated_at=excluded.generated_at,result_json=excluded.result_json`)
    .bind(result.month, now, JSON.stringify(result)).run();
}

export async function getPaperBacktestResults(db: D1Database, limit = 12): Promise<MonthlyBacktestResult[]> {
  const rows = await db.prepare("SELECT result_json FROM paper_backtest_monthly ORDER BY month DESC LIMIT ?")
    .bind(limit).all<{result_json:string}>();
  return (rows.results ?? []).map(row => JSON.parse(row.result_json) as MonthlyBacktestResult).reverse();
}
