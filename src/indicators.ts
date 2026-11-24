import type { Candle, Timeframe, TimeframeSnapshot, Trend } from "./types.ts";

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period < 1) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i]! * alpha + value * (1 - alpha);
  return value;
}

export function rsiSeries(values: number[], period = 14): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const value = () => averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss);
  output[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[i] = value();
  }
  return output;
}

export function trueRangeSeries(candles: Candle[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1]!.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
}

export function wilderAverage(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let average = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < values.length; i++) average = (average * (period - 1) + values[i]!) / period;
  return average;
}

export function classifyTrend(close: number, ema20: number, ema50: number): Trend {
  if (close > ema20 && ema20 > ema50) return "BULLISH";
  if (close < ema20 && ema20 < ema50) return "BEARISH";
  return "NEUTRAL";
}

export function snapshot(candles: Candle[], timeframe: Timeframe): TimeframeSnapshot | null {
  if (candles.length < 55) return null;
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi = rsiSeries(closes, 14);
  const ranges = trueRangeSeries(candles);
  const atr14 = wilderAverage(ranges, 14);
  const atr20 = wilderAverage(ranges, 20);
  if (ema20 === null || ema50 === null || atr14 === null || atr20 === null) return null;
  const rsiNow = rsi.at(-1);
  const rsiPrevious = rsi.at(-2);
  if (rsiNow == null || rsiPrevious == null) return null;
  const last = candles.at(-1)!;
  return {
    timeframe,
    lastClose: last.close,
    ema20,
    ema50,
    rsi14: rsiNow,
    previousRsi14: rsiPrevious,
    atr14,
    keltnerUpper: ema20 + atr20 * 1.5,
    keltnerLower: ema20 - atr20 * 1.5,
    trend: classifyTrend(last.close, ema20, ema50),
    candleTime: last.time,
  };
}
