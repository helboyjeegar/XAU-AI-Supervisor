# Architecture and engineering decisions

## System boundaries

- **GitHub** is the source of truth, review history and CI gate. `develop` is the integration branch; `main` is reserved for tested releases.
- **Cloudflare Worker** is the thin HTTPS API, webhook receiver and five-minute scheduler. No broker execution code belongs here.
- **Cloudflare D1** stores candles, analysis snapshots, macro context and daily account-risk state.
- **Telegram** is an alert and command surface. Its webhook is authenticated using Telegram's `secret_token` header, and only the configured chat ID is allowed to issue commands.
- **Market/equity adapters** run outside the mobile terminal. The planned MT5 Expert Advisor sends closed candles and account-equity snapshots to the authenticated Worker endpoints.

## Specialist pipeline

1. **Gold Technical Analyst:** 1m RSI exhaustion/recovery, Keltner re-entry, repeated range-boundary tests, tick-volume confirmation and candle wick rejection.
2. **Quant Research:** computes independent 1m, 5m and 30m EMA20/EMA50, RSI(14) and ATR(14); 5m and 30m must agree directionally.
3. **Macro Strategy:** requires a recent, sourced macro/calendar snapshot; a high-impact event inside the configured block window vetoes a new entry.
4. **Risk Analysis:** has veto power. It requires current equity, day-start equity, fresh candles and a non-locked daily risk state; it checks ATR-based stop distance and reward/risk.
5. **Supervisor:** issues BUY/SELL only when all vetoes are clear and the evidence score meets the configured threshold. Otherwise it emits NO_TRADE.

Scores are deterministic evidence weights. They are not probabilities and will not be described as win rates until a properly designed, out-of-sample calibration study exists.

## Data integrity and fail-closed rules

- Only XAUUSD/GOLD aliases are accepted; data is normalized to XAUUSD.
- Supported timeframes are 1m, 5m and 30m.
- Candle timestamps are Unix milliseconds and must be ascending and unique within a payload.
- Candle high/low must enclose open and close; all prices must be positive and volume non-negative.
- Each timeframe requires at least 55 bars; stale or contradictory data blocks a signal.
- Macro snapshots require a source, timestamp and explicit calendar coverage. Missing macro context blocks a signal.
- Risk snapshots require positive day-start and current equity. Current equity must include floating PnL. Once the configured daily drawdown threshold is crossed, the lock persists for that trading day.
- Missing D1 binding or missing secrets causes an explicit error; there is no silent fallback to a permissive risk mode.

## Why not embed the full upstream CLI?

The current upstream repository is an extensible research CLI with agent, tool, data and compute layers. Its full interactive runtime is not an appropriate dependency to bundle into a small, low-CPU Cloudflare Worker. This project adopts the specialist-role/supervisor architecture and implements a smaller, deterministic XAUUSD engine with a narrow API contract. An optional model adapter can be added later, but an LLM must never override the deterministic risk veto.

## Deployment topography

```text
GitHub develop --CI--> Cloudflare Workers Builds --deploy--> xau-ai-supervisor Worker
                                                              |
                                                              +--> D1
                                                              +--> Telegram Bot API
MT5 EA / macro adapter -------------------------------------->|
```
