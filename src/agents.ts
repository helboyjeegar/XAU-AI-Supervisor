import { rsiSeries, snapshot } from "./indicators.ts";
import type { AgentFinding, Candle, Direction, MacroContext, RiskStatus, Timeframe, TimeframeSnapshot, Trend } from "./types.ts";

export interface AgentInput {
  oneMinute: Candle[];
  fiveMinute: Candle[];
  thirtyMinute: Candle[];
  macro?: MacroContext;
  risk: RiskStatus;
  now: number;
  minRiskReward: number;
  stopAtrMultiplier: number;
  minScore: number;
  highImpactBlockMinutes: number;
  macroMaxAgeMinutes: number;
}

export interface AgentOutput {
  buyScore: number;
  sellScore: number;
  agents: AgentFinding[];
  snapshots: Partial<Record<Timeframe, TimeframeSnapshot>>;
  reasons: string[];
  blockers: string[];
  warnings: string[];
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
}

const last = <T>(items: T[]): T => items[items.length - 1]!;

function freshnessBlock(candles: Candle[], maxAgeMs: number, now: number, label: string): string | null {
  const newest = candles.at(-1)?.time;
  if (newest === undefined || now - newest > maxAgeMs || newest > now + 60_000) return `${label} candles are missing or stale`;
  return null;
}

function repeatedLevelTouches(candles: Candle[], atr: number): { support: number; resistance: number } {
  const window = candles.slice(-10, -1);
  if (window.length < 5) return { support: 0, resistance: 0 };
  const low = Math.min(...window.map((c) => c.low));
  const high = Math.max(...window.map((c) => c.high));
  const tolerance = Math.max(atr * 0.18, 0.01);
  const support = window.filter((c) => c.low <= low + tolerance).length;
  const resistance = window.filter((c) => c.high >= high - tolerance).length;
  return { support, resistance };
}

function volumeConfirmed(candles: Candle[], side: "BUY" | "SELL"): boolean {
  const current = last(candles);
  const previous = candles.slice(-21, -1);
  if (previous.length < 15 || current.volume <= 0) return false;
  const average = previous.reduce((sum, c) => sum + c.volume, 0) / previous.length;
  return current.volume >= average * 1.15 && (side === "BUY" ? current.close > current.open : current.close < current.open);
}

function wickConfirmed(candle: Candle, side: "BUY" | "SELL"): boolean {
  const body = Math.max(Math.abs(candle.close - candle.open), 0.00001);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return side === "BUY" ? lowerWick >= body * 1.5 && candle.close > candle.open : upperWick >= body * 1.5 && candle.close < candle.open;
}

function analyzeTechnical(candles: Candle[], one: TimeframeSnapshot): { buy: number; sell: number; evidence: Record<"BUY" | "SELL", string[]>; warnings: string[] } {
  const current = last(candles);
  const previous = candles[candles.length - 2]!;
  const previousSnapshot = snapshot(candles.slice(0, -1), "1m");
  const rsi = rsiSeries(candles.map((c) => c.close), 14);
  const previousRsi = rsi.at(-2) ?? one.previousRsi14;
  const currentRsi = rsi.at(-1) ?? one.rsi14;
  const touches = repeatedLevelTouches(candles, one.atr14);
  const buyEvidence: string[] = [];
  const sellEvidence: string[] = [];
  const warnings: string[] = [];
  let buy = 0;
  let sell = 0;

  if (previousRsi <= 20 && currentRsi > previousRsi) { buy += 20; buyEvidence.push("RSI از ناحیه زیر ۲۰ رو به بالا برگشته است"); }
  if (previousRsi >= 80 && currentRsi < previousRsi) { sell += 20; sellEvidence.push("RSI از ناحیه بالای ۸۰ رو به پایین برگشته است"); }

  const previousLower = previousSnapshot?.keltnerLower ?? one.keltnerLower;
  const previousUpper = previousSnapshot?.keltnerUpper ?? one.keltnerUpper;
  const reenteredLower = previous.close < previousLower && current.close > one.keltnerLower;
  const reenteredUpper = previous.close > previousUpper && current.close < one.keltnerUpper;
  if (reenteredLower || (current.low <= one.keltnerLower && current.close > current.open)) { buy += 15; buyEvidence.push("بازگشت قیمت به داخل کانال کلتنر از سمت پایین"); }
  if (reenteredUpper || (current.high >= one.keltnerUpper && current.close < current.open)) { sell += 15; sellEvidence.push("بازگشت قیمت به داخل کانال کلتنر از سمت بالا"); }

  if (touches.support >= 2 && current.close > current.open && current.close > previous.close) { buy += 15; buyEvidence.push(`آزمون مکرر کف محدوده (${touches.support} برخورد نزدیک)`); }
  if (touches.resistance >= 2 && current.close < current.open && current.close < previous.close) { sell += 15; sellEvidence.push(`آزمون مکرر سقف محدوده (${touches.resistance} برخورد نزدیک)`); }

  if (volumeConfirmed(candles, "BUY")) { buy += 10; buyEvidence.push("حجم تیک بالاتر از میانگین همراه با کندل صعودی"); }
  if (volumeConfirmed(candles, "SELL")) { sell += 10; sellEvidence.push("حجم تیک بالاتر از میانگین همراه با کندل نزولی"); }
  if (wickConfirmed(current, "BUY")) { buy += 10; buyEvidence.push("سایه پایینی نشان‌دهنده رد قیمت‌های پایین‌تر است"); }
  if (wickConfirmed(current, "SELL")) { sell += 10; sellEvidence.push("سایه بالایی نشان‌دهنده رد قیمت‌های بالاتر است"); }
  if (current.close > previous.high) { buy += 5; buyEvidence.push("بسته‌شدن بالای سقف کندل قبلی"); }
  if (current.close < previous.low) { sell += 5; sellEvidence.push("بسته‌شدن پایین کف کندل قبلی"); }
  if (candles.slice(-20).some((c) => c.volume <= 0)) warnings.push("حجم معتبر برای همه کندل‌ها دریافت نشده؛ تأیید حجمی ناقص است");

  return { buy, sell, evidence: { BUY: buyEvidence, SELL: sellEvidence }, warnings };
}

export function runAgents(input: AgentInput): AgentOutput {
  const { oneMinute, fiveMinute, thirtyMinute } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];
  const one = snapshot(oneMinute, "1m");
  const five = snapshot(fiveMinute, "5m");
  const thirty = snapshot(thirtyMinute, "30m");
  if (!one || !five || !thirty) blockers.push("برای هر سه تایم‌فریم حداقل ۵۵ کندل معتبر لازم است");
  if (freshnessBlock(oneMinute, 3 * 60_000, input.now, "1m")) blockers.push("داده یک‌دقیقه‌ای به‌روز نیست");
  if (freshnessBlock(fiveMinute, 12 * 60_000, input.now, "5m")) blockers.push("داده پنج‌دقیقه‌ای به‌روز نیست");
  if (freshnessBlock(thirtyMinute, 40 * 60_000, input.now, "30m")) blockers.push("داده سی‌دقیقه‌ای به‌روز نیست");
  if (!one || !five || !thirty) {
    const empty: AgentFinding[] = [{ agent: "Gold Technical Analyst", direction: "NEUTRAL", score: 0, evidence: [], warnings: ["داده کافی نیست"] }];
    return { buyScore: 0, sellScore: 0, agents: empty, snapshots: {}, reasons, blockers, warnings, entry: null, stopLoss: null, takeProfit: null, riskReward: null };
  }

  const technical = analyzeTechnical(oneMinute, one);
  warnings.push(...technical.warnings);
  const alignedBull = five.trend === "BULLISH" && thirty.trend === "BULLISH";
  const alignedBear = five.trend === "BEARISH" && thirty.trend === "BEARISH";
  const conflicting = (five.trend === "BULLISH" && thirty.trend === "BEARISH") || (five.trend === "BEARISH" && thirty.trend === "BULLISH");
  const buyQuantBonus = alignedBull ? 25 : five.trend === "BULLISH" || thirty.trend === "BULLISH" ? 10 : 0;
  const sellQuantBonus = alignedBear ? 25 : five.trend === "BEARISH" || thirty.trend === "BEARISH" ? 10 : 0;
  if (conflicting) blockers.push("روند ۵ و ۳۰ دقیقه با یکدیگر تعارض دارد");
  if (input.risk.locked) blockers.push("قفل محدودیت زیان روزانه فعال است");
  if (!input.risk.verified) blockers.push("وضعیت سرمایه و افت روزانه هنوز از حساب معاملاتی تأیید نشده است");
  if (input.risk.lossPercent >= input.risk.maxDailyLossPercent) blockers.push("حداکثر زیان روزانه لمس شده است");

  const macroEvidence: string[] = [];
  const macroWarnings: string[] = [];
  let macroBlocked = false;
  const macroFresh = Boolean(input.macro?.source && input.macro.asOf && input.now - input.macro.asOf <= input.macroMaxAgeMinutes * 60_000 && input.now >= input.macro.asOf - 60_000 && (input.macro.calendarCoverageMinutes ?? 0) >= input.highImpactBlockMinutes);
  if (!macroFresh) {
    blockers.push("زمینه کلان و تقویم اقتصادی معتبر و تازه دریافت نشده است");
    macroWarnings.push("بدون منبع، زمان ثبت و پوشش تقویم اقتصادی، صدور سیگنال مجاز نیست");
  } else if (input.macro?.highImpactEventWithinMinutes !== undefined && input.macro.highImpactEventWithinMinutes !== null) {
    if (input.macro.highImpactEventWithinMinutes <= input.highImpactBlockMinutes) {
      macroBlocked = true;
      blockers.push(`ریسک خبر مهم: رویداد در ${input.macro.highImpactEventWithinMinutes} دقیقه آینده`);
    } else macroEvidence.push(`رویداد پرریسک در ${input.macro.highImpactEventWithinMinutes} دقیقه آینده نیست`);
  } else if (macroFresh) macroEvidence.push(`تقویم اقتصادی پوشش ${input.macro?.calendarCoverageMinutes} دقیقه‌ای دارد و رویداد پرریسکی در بازه مسدودکننده گزارش نشده`);
  if (input.macro?.dxyTrend) macroEvidence.push(`روند شاخص دلار: ${input.macro.dxyTrend}`);
  if (input.macro?.us10yTrend) macroEvidence.push(`روند بازده اوراق ۱۰ساله: ${input.macro.us10yTrend}`);
  if (input.macro?.note) macroEvidence.push(input.macro.note);
  warnings.push(...macroWarnings);

  let buyScore = technical.buy + buyQuantBonus;
  let sellScore = technical.sell + sellQuantBonus;
  if (input.macro?.dxyTrend === "BULLISH") { buyScore -= 5; sellScore += 5; }
  if (input.macro?.dxyTrend === "BEARISH") { buyScore += 5; sellScore -= 5; }
  if (input.macro?.us10yTrend === "BULLISH") { buyScore -= 3; sellScore += 3; }
  if (input.macro?.us10yTrend === "BEARISH") { buyScore += 3; sellScore -= 3; }
  buyScore = Math.max(0, Math.min(100, buyScore));
  sellScore = Math.max(0, Math.min(100, sellScore));

  const chosenSide: "BUY" | "SELL" | null = buyScore > sellScore ? "BUY" : sellScore > buyScore ? "SELL" : null;
  const score = chosenSide === "BUY" ? buyScore : chosenSide === "SELL" ? sellScore : 0;
  const direction: Direction = chosenSide ?? "NEUTRAL";
  const sideTrend = chosenSide === "BUY" ? alignedBull : chosenSide === "SELL" ? alignedBear : false;
  if (sideTrend && chosenSide) reasons.push("روند تایم‌فریم‌های ۵ و ۳۰ دقیقه هم‌جهت است");
  if (chosenSide) reasons.push(...technical.evidence[chosenSide]);
  if (chosenSide && !sideTrend) blockers.push("برای ورود، هم‌جهتی روند ۵ و ۳۰ دقیقه الزامی است");
  if (!chosenSide) blockers.push("شواهد خرید و فروش برتری معناداری ندارند");
  if (score < input.minScore) blockers.push(`امتیاز شواهد ${score} از حداقل لازم ${input.minScore} کمتر است`);
  if (macroBlocked) blockers.push("ورود در محدوده خبر مهم مجاز نیست");

  const entry = chosenSide ? last(oneMinute).close : null;
  const riskDistance = one.atr14 * input.stopAtrMultiplier;
  const riskReward = input.minRiskReward;
  const stopLoss = chosenSide && entry !== null && riskDistance > 0 ? chosenSide === "BUY" ? entry - riskDistance : entry + riskDistance : null;
  const takeProfit = chosenSide && entry !== null && stopLoss !== null ? chosenSide === "BUY" ? entry + riskDistance * riskReward : entry - riskDistance * riskReward : null;

  const agents: AgentFinding[] = [
    { agent: "Gold Technical Analyst", direction, score: chosenSide === "BUY" ? technical.buy : chosenSide === "SELL" ? technical.sell : 0, evidence: chosenSide ? technical.evidence[chosenSide] : [], warnings: technical.warnings },
    { agent: "Quant Research", direction: alignedBull ? "BUY" : alignedBear ? "SELL" : "NEUTRAL", score: Math.max(buyQuantBonus, sellQuantBonus), evidence: [`روند ۵ دقیقه: ${five.trend}`, `روند ۳۰ دقیقه: ${thirty.trend}`, `RSI یک‌دقیقه: ${one.rsi14.toFixed(1)}`], warnings: conflicting ? ["تعارض روند تایم‌فریم‌ها"] : [] },
    { agent: "Macro Strategy", direction: "NEUTRAL", score: 0, evidence: macroEvidence, warnings: macroWarnings },
    { agent: "Risk Analysis", direction: blockers.length === 0 ? direction : "NEUTRAL", score: blockers.length === 0 ? 100 : 0, evidence: [`افت روزانه ثبت‌شده: ${input.risk.lossPercent.toFixed(2)}%`, `حد مجاز روزانه: ${input.risk.maxDailyLossPercent.toFixed(2)}%`, `نسبت سود به زیان هدف: 1:${riskReward.toFixed(2)}`], warnings: blockers },
  ];

  return { buyScore, sellScore, agents, snapshots: { "1m": one, "5m": five, "30m": thirty }, reasons, blockers, warnings, entry, stopLoss, takeProfit, riskReward: entry !== null && stopLoss !== null && takeProfit !== null ? Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss) : null };
}
