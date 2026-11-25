export type Timeframe = "1m" | "5m" | "30m";
export type Direction = "BUY" | "SELL" | "NEUTRAL";
export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL";
export type Verdict = "BUY" | "SELL" | "NO_TRADE";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TimeframeSnapshot {
  timeframe: Timeframe;
  lastClose: number;
  ema20: number;
  ema50: number;
  rsi14: number;
  previousRsi14: number;
  atr14: number;
  keltnerUpper: number;
  keltnerLower: number;
  trend: Trend;
  candleTime: number;
}

export interface AgentFinding {
  agent: string;
  direction: Direction;
  score: number;
  evidence: string[];
  warnings: string[];
}

export interface RiskStatus {
  verified: boolean;
  locked: boolean;
  lossPercent: number;
  maxDailyLossPercent: number;
  dayKey?: string;
  updatedAt?: number;
  timezoneConfigured?: boolean;
}

export interface MacroContext {
  dxyTrend?: Trend;
  us10yTrend?: Trend;
  highImpactEventWithinMinutes?: number | null;
  note?: string;
  asOf?: number;
  source?: string;
  calendarCoverageMinutes?: number;
}

export interface AnalysisResult {
  researchStatus?: "DISABLED" | "BLOCKED" | "COMPLETED" | "FAILED";
  researchRunId?: string;
  evidenceIds?: string[];
  aiReviewStatus?: "DISABLED" | "NOT_RUN" | "PASSED" | "VETOED" | "UNAVAILABLE";
  id: string;
  symbol: "XAUUSD";
  generatedAt: number;
  verdict: Verdict;
  side: Direction;
  score: number;
  scoreMeaning: "EVIDENCE_SCORE_NOT_PROBABILITY";
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  reasons: string[];
  blockers: string[];
  warnings: string[];
  agents: AgentFinding[];
  timeframes: Partial<Record<Timeframe, TimeframeSnapshot>>;
}

export interface AiBinding {
  run(model: string, input: {
    messages: Array<{ role: "system" | "user"; content: string }>;
    temperature?: number;
    max_tokens?: number;
  }): Promise<unknown>;
}

export interface Env {
  AI?: AiBinding;
  AI_MODEL?: string;
  ENABLE_TRADINGAGENTS?: string;
  TRADINGAGENTS_MIN_INTERVAL_MINUTES?: string;
  TRADINGAGENTS_MAX_RUNS_PER_UTC_DAY?: string;
  ENABLE_AI_REVIEW?: string;
  ALERT_COOLDOWN_MINUTES?: string;
  RISK_MAX_AGE_MINUTES?: string;
  DB?: D1Database;
  INGEST_SECRET?: string;
  SIFTING_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MIN_SIGNAL_SCORE?: string;
  MIN_RISK_REWARD?: string;
  STOP_ATR_MULTIPLIER?: string;
  MAX_DAILY_LOSS_PERCENT?: string;
  RISK_TIMEZONE?: string;
  HIGH_IMPACT_BLOCK_MINUTES?: string;
  MACRO_MAX_AGE_MINUTES?: string;
}

export interface RiskRow {
  day_key: string;
  day_start_equity: number;
  current_equity: number;
  loss_percent: number;
  locked: number;
  updated_at: number;
}

export interface CandleRow extends Candle {
  symbol: string;
  timeframe: Timeframe;
}
