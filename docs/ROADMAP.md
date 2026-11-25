# Delivery plan

## Milestone 1 — Repository foundation (current)
- Agent-oriented deterministic XAUUSD analysis core.
- Candle, macro and equity-risk ingestion contracts.
- D1 schema, Worker routes, Telegram command/notification adapter.
- Unit tests and GitHub Actions quality gate.

## Milestone 2 — Cloudflare and Telegram live wiring
- Create D1 and bind it to the Worker.
- Configure Worker Builds from GitHub `develop`.
- Add Secrets and verify webhook authentication.
- Exercise `/health`, `/start`, `/status` and protected endpoints.

## Milestone 3 — MT5 data bridge
- Desktop Expert Advisor sends closed 1m/5m/30m candles.
- First account snapshot captures day-start equity; later messages include current equity with floating PnL.
- Retry/backoff, request signing, duplicate handling and terminal logs.

## Milestone 4 — Sourced macro data
- Select an approved data provider after checking its current free-tier terms.
- Pull DXY / US yields and a high-impact US economic calendar.
- Persist source, publication time, observation time and coverage.
- Block analysis on stale or incomplete feeds.

## Milestone 5 — Research and validation
- Obtain broker-specific historical XAUUSD data with spread/tick-volume metadata.
- Walk-forward backtest; no future-data leakage.
- Model spread, slippage, commissions, session hours and news windows.
- Out-of-sample analysis, paper trading, false-positive review and score calibration.

## Milestone 6 — Optional LLM challenger
- Add a provider adapter only after the deterministic engine is stable.
- Ask separate agents for critique and counter-thesis.
- Parse structured output; reject invalid, stale or unsupported claims.
- The deterministic risk gate retains final veto power.

## Release gates

No connection to broker order execution is planned in these milestones. Any later execution capability would require separate explicit authorization, additional safety engineering, sandbox testing and a new review gate.
