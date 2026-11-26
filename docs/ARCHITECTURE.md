# XAU AI Supervisor — production architecture

## Scope and upstream reference

This Worker is a bounded, XAUUSD-specific adaptation of [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), pinned to v1.0.1 at commit `121265d18d467ac717f7af99cb0d669c15d2e73c` (Apache-2.0).

The pinned upstream release is a TypeScript finance-research CLI for Node.js/Bun. Its architecture separates a main coordinator, specialist agents, data/compute tools, evidence records, skills and bounded model loops. It does not place trades. Its filesystem/session/runtime dependencies are not transplanted into Cloudflare Workers.

This implementation retains the research roles, evidence-linked reports, risk challenge, coordinator hand-off and bounded model usage. It does **not** claim to be the complete upstream runtime: the Worker uses a fixed four-inference workflow and prebuilt evidence inputs rather than upstream's free-form model tool-calling loops, dynamic planning/delegation and filesystem-backed sessions.

## End-to-end signal path

1. **Market data:** the scheduled Worker polls SiftingIO XAUUSD 1m bars every four minutes. Only closed, valid OHLCV bars are stored. Five- and 30-minute bars are resampled from complete, contiguous groups of 1m bars. The latest 1m bar must match the recent successful SiftingIO feed-state record, and the latest M5/M30 bars must match deterministic resampling from the same M1 history, before their source is labelled verified for AI research.
2. **Preflight:** the Worker loads up to 300 candles per timeframe and checks OHLCV validity, ordering, adequate history, freshness, 5m/30m trend alignment, macro calendar freshness/coverage, imminent high-impact USD events, and daily risk snapshot validity. Unknown candle source, missing/stale data, an expired risk snapshot, an active daily lock or a blocked event results in NO_TRADE before model inference.
3. **Evidence:** timestamped market candles, local indicator calculations, macro calendar and risk snapshot are recorded with evidence IDs in D1. Tick volume is explicitly a provider-specific proxy, not centralized gold-market volume.
4. **Macro Strategy + Quant Research:** two isolated model calls run in parallel. Macro assesses only sourced calendar and available macro series; while only the event calendar is connected, any directional Macro model output is deterministically normalized to NEUTRAL. Quant reads 1m entry context against 5m and 30m structure, momentum, volatility and turning levels.
5. **Deterministic candidate/risk geometry:** only a directional Quant conclusion can become a candidate. The last completed 1m close is the reference entry. The stop is calculated from 1m ATR14 × configured multiplier; the target is calculated to meet the configured minimum reward/risk (default 1.5). These are analysis reference levels, not a broker quote or fill.
6. **Risk Analysis:** an isolated adversarial model call checks the risk snapshot, daily loss, stop/target geometry and missing information. Its veto blocks the candidate. A non-neutral Risk direction is also treated as a veto.
7. **Contract gates:** each required report must be fresh, have findings that cite real evidence IDs, and satisfy its deterministic quality checks. Opposing non-neutral Macro and Quant conclusions are a hard blocker before coordinator inference; a neutral Macro report does not by itself block a Quant candidate.
8. **Main coordinator:** the fourth model call can return only the Quant candidate side or NEUTRAL. Invalid JSON, unknown evidence IDs, a reverse direction, model errors, missing reports or any prior blocker fail closed.
9. **Persistence and alerts:** the full research result, evidence and specialist reports are saved in D1. Only an approved BUY/SELL result is eligible for the signal Telegram notification. Telegram labels entry as the last completed 1m candle close, includes source and UTC timestamp, and states that broker execution did not occur.

## Agent and skill mapping

- **Main coordinator:** synthesizes specialist conclusions, enforces the permitted candidate side and cites evidence.
- **Macro Strategy:** scheduled USD events and connected macro series. DXY and US10Y remain unavailable until their feeds are actually connected.
- **Quant Research:** XAUUSD 1m, 5m and 30m candles; EMA20/EMA50, RSI14, ATR14, Keltner envelope and recent price structure.
- **Risk Analysis:** adversarial review of the account snapshot, daily loss, invalidation, stop/target and reward/risk.

The Equity Research role is intentionally omitted because spot gold has no company financial statements. The XAU Agent Skills Markdown files are the human-readable specifications. Since the Worker has no project-filesystem skill loader, the essential methods from `xau-macro-outlook`, `xau-technical-analysis` and `xau-risk-assessment` are embedded in the runtime prompts in `src/tradingagents-engine.ts`; keep them synchronized.

Standard RSI14 is not identical to the user's TradingView Ultimate RSI. The local Keltner calculations and candle-derived levels are not claimed to reproduce proprietary indicators such as RSI Volume, Range Detector Alpha Wizard or Leg Anatomy. Missing formulas/data are not fabricated.

## Deterministic decision and risk gates

- Symbol is restricted to XAUUSD/GOLD aliases.
- All input candles must be completed, timestamped, positive-price OHLCV series with valid high/low relationships, ascending unique times and adequate history.
- The latest market feed source must be attributable to a recent SiftingIO fetch and match the latest M1 bar; unverified source attribution blocks AI signals.
- M1 is the reference/entry context; M5 and M30 must have aligned non-neutral trends.
- The sourced macro calendar must be recent and cover at least the configured event-block window. A high-impact USD event inside the configured block window (default 15 minutes) blocks the signal. Current macro context is an aggregated ShowMyTrades calendar fallback; it is not a direct official DXY/US10Y data feed.
- The daily loss ceiling is 5% unless a stricter deployment setting is used. Risk snapshot age is at most two minutes. A fresh manually entered snapshot is **not** broker-verified; the Worker cannot read broker Equity or open positions.
- The evidence score minimum is 75. The score is coverage/traceability, **not** a probability, confidence percentage or win-rate estimate.
- Minimum reward/risk is 1.5 by default.
- Any model, schema, citation, provenance, data, calendar or risk failure returns NO_TRADE.
- No broker credentials, broker order endpoint or live execution path exists.

## Schedule and costs

- Market feed and Paper Trading poll on a four-minute cron while XAUUSD is normally open. The schedule skips Saturday and Sunday before 20:00 UTC.
- AI research/alerts are restricted to Monday-Friday, 08:00 inclusive through 17:00 exclusive, in either `Europe/London` or `America/New_York`; IANA timezones handle daylight-saving changes.
- AI research is throttled to one run per 15 minutes and at most eight reserved runs per UTC day. Each successful research run uses four model inferences (Macro, Quant, Risk and coordinator). Cloudflare Workers AI has provider/account quotas; eight runs/day is an application cap, not a promise of unlimited free inference.
- Failed preflight checks happen before model budget reservation and before any AI inference.
- Four-minute polling is a quota trade-off and can miss short-lived one-minute entry setups between fetches.

## Separate Paper Trading path

Paper Trading is **not** the TradingAgents signal engine. It is an independent deterministic simulation using its own EMA20/EMA50 5m/30m alignment, 1m EMA20 crossback, RSI and ATR logic. It runs across normal XAUUSD market hours independently of London/New York AI sessions. Its virtual account assumptions (0.01 lot, 100 oz/lot, $0.30/oz spread, ATR stop and 1.8R target) are estimates, not broker-verified contract terms or fills. It never submits live orders. The current simulation has no closed-trade history yet; no performance or profitability claim is justified.

## Deployment boundaries and source of truth

- GitHub is the source of code, tests and review history.
- Cloudflare Worker is the API, webhook and scheduler.
- Cloudflare D1 stores candles, analysis, evidence, specialist reports, macro context, risk snapshots and Paper Trading records.
- Telegram receives alerts and accepts allow-listed commands through the authenticated webhook.
- Production `RISK_TIMEZONE=UTC` follows the configured SGB broker-day boundary.
- Preview keeps TradingAgents disabled and the risk timezone unconfigured.
- Changes must pass `npm run check` and GitHub CI before deployment. Never enable broker execution as part of this project.
