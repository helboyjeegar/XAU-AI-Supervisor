# XAU AI Supervisor

A signal-only XAU/USD research and risk-supervision service. The architecture is inspired by the specialist-agent workflow in [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), but this repository is an independent implementation tailored to gold and short-horizon multi-timeframe analysis.

> **Safety:** This project does not connect to a broker or place orders. A BUY/SELL result is an analytical alert only. The engine fails closed when candle data, macro context, or the daily-equity snapshot is missing or stale. Do not use it for live trading until independent backtesting, forward testing and account-specific validation are complete.

## Current implementation (0.3.0)

- Cloudflare Worker API with authenticated market-data and risk ingestion.
- Default cloud-hosted XAUUSD data adapter via SiftingIO commodities REST API; no MT5 desktop or always-on user computer is required. The key is held only as a Cloudflare Worker secret.
- 1m XAUUSD reference OHLCV is refreshed by the Worker every two minutes during the permitted London/New York sessions; complete 5m and 30m candles are resampled from the 1m bars. This is a two-minute polling cadence over one-minute candles, not continuous one-minute monitoring.
- D1 persistence for OHLCV candles, analysis decisions, daily risk state and macro context.
- Four specialist modules: Gold Technical Analyst, Quant Research, Macro Strategy and Risk Analysis; a deterministic supervisor combines their findings.
- 1m entry analysis with 5m and 30m trend context.
- EMA(20/50), Wilder RSI(14), ATR(14), Keltner envelope, repeated-range tests, tick-volume comparison and rejection-wick anatomy.
- Daily drawdown lock based on externally supplied start-of-day and current equity. The current equity must include floating PnL.
- Telegram notifications with a 15-minute same-direction alert cooldown and `/status`, `/analyze`, `/help` commands.
- Freshness validation for equity snapshots; an old or delayed equity update cannot authorize a trade.
- Automatic event-time protection from official BLS/BEA/Federal Reserve schedules, with an attributed XOOMAR fallback when government endpoints are blocked. The fallback is limited to personal/internal use under its free terms; details and assumptions are in [docs/MACRO_CALENDAR_FA.md](docs/MACRO_CALENDAR_FA.md).
- Optional Cloudflare Workers AI adversarial reviewer. It is disabled by default and can only veto a deterministic candidate; it cannot create or approve signals.
- GitHub Actions type-check and unit-test workflow.
- Optional read-only MT5 desktop bridge source at [mt5/XAU_AI_Supervisor.mq5](mt5/XAU_AI_Supervisor.mq5), with Persian installation instructions in [docs/MT5_BRIDGE_FA.md](docs/MT5_BRIDGE_FA.md). It is an optional broker-specific alternative, not required by the default cloud feed; it does not place orders.

The score is an **evidence score, not a statistically calibrated probability**. Standard RSI is not the proprietary Luxe Algo Ultimate RSI; tick volume is broker-specific and is not centralized spot-gold volume. Proprietary indicator readings are not fabricated.

## Runtime architecture

```text
SiftingIO XAUUSD REST feed (every 2m in allowed sessions)
                     |
                     v
              Cloudflare Worker
        +------------+-------------+
        |            |             |
    Candle API   Macro API    Equity/Risk API
        |            |             |
        +------------+-------------+
                     v
                Cloudflare D1
                     |
          1m / 5m / 30m analysis
                     |
       +-------------+-------------+
       |             |             |
   Gold Technical  Quant       Macro + Risk
       +-------------+-------------+
                     |
              Supervisor veto
                     |
             Telegram alert
```

TradingAgents itself currently presents a research CLI and specialist-agent framework; it does not execute trades. We reuse its specialist-role and supervisor pattern, not its entire CLI runtime. See its [README](https://github.com/TauricResearch/TradingAgents) and [Apache-2.0 license](https://github.com/TauricResearch/TradingAgents/blob/main/LICENSE).

## API

All administrative ingestion endpoints require `X-Ingest-Secret`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Runtime configuration health |
| POST | `/market/candles` | Store 1m, 5m or 30m XAUUSD candles |
| POST | `/macro/context` | Store a timestamped macro/calendar snapshot |
| POST | `/risk/snapshot` | Store day-start/current equity and update the daily loss lock |
| POST | `/analysis/run` | Run the specialist pipeline |
| GET | `/analysis/latest` | Read the latest decision (authenticated) |
| POST | `/telegram/webhook` | Telegram bot webhook with Telegram secret-token verification |

See [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) for request payloads.

## Development

Requires Node.js 22+.

```bash
npm install
npm run check
npm run dev
```

## Cloudflare deployment

1. Create a Cloudflare D1 database named `xau-ai-supervisor`.
2. Add its ID to the `DB` D1 binding in `wrangler.toml`.
3. Apply all migrations in order: `0001_init.sql` and `0002_market_feed_state.sql` (or use `wrangler d1 migrations apply xau-ai-supervisor --remote`).
4. Add Worker secrets: `INGEST_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, and `SIFTING_API_KEY` (for the default cloud gold feed).
5. Connect GitHub repository branch `develop` in **Workers & Pages → Create application → GitHub**. Build command: `npm install && npm run check`; deploy command: `npx wrangler deploy`.
6. Configure Telegram's webhook URL and secret token as described in [docs/DEPLOYMENT_FA.md](docs/DEPLOYMENT_FA.md).
7. Keep `ENABLE_AI_REVIEW=false` during initial deployment. Workers AI has quotas; enable the veto-only reviewer only after verifying the account's free-plan allowance and testing.

The D1 binding in `wrangler.toml` is configured for the existing Cloudflare database. Do not replace its ID or binding unless intentionally migrating the database. Do not add tokens or account credentials to GitHub.

### Default XAUUSD feed

Create a free SiftingIO account (no payment card), enable the Commodities free market, generate an API key, and add it as the Cloudflare Worker secret `SIFTING_API_KEY`. Never place this key in Telegram, GitHub, source code or ChatGPT. Setup steps are in [docs/DEPLOYMENT_FA.md](docs/DEPLOYMENT_FA.md).

## Guarded AI engine and daily risk boundary

The production TradingAgents research engine is enabled, but it is not allowed to bypass deterministic preflight checks. It can only run during the configured London/New York sessions and only when complete, fresh market/calendar evidence and a fresh daily-equity snapshot pass the risk gates. A blocked or malformed model response produces `NO_TRADE`; no broker order is ever submitted.

Workers AI calls are bounded by an atomic maximum of 8 research runs per UTC quota day, a 15-minute minimum interval, a 20,000-character combined system/user input ceiling per inference, and per-specialist output caps (400 + 500 + 400 + 350 tokens maximum per run). The input ceiling is checked for both parallel specialists before either inference starts. These are application-side guardrails, not a promise that the entire Cloudflare account's shared allocation is reserved for this Worker; Cloudflare's own quota/error response remains authoritative and a denied inference fails closed. The optional separate veto-only `ENABLE_AI_REVIEW` remains disabled.

**Prop-firm daily reset must be configured separately from the Workers AI quota clock.** Set `RISK_TIMEZONE` to the exact IANA timezone that the prop firm uses for its daily equity reset (for example, only after confirmation, a value such as `America/New_York`). It is deliberately set to `UNCONFIGURED` in the repository until that reset boundary is known. When unset or invalid, Telegram `/risk` and the `/risk/snapshot` API reject new snapshots, the risk state is locked, and no entry signal can be authorized. Do not infer the reset timezone from the word “daily” or substitute UTC. The existing old snapshot is not carried forward into a newly configured daily boundary.

## Free-tier expectations

The architecture avoids a dedicated always-on server. Cloudflare Free is quota-limited, not unlimited: Workers, D1 and Workers AI each have usage ceilings. The current release does not require a paid LLM API. The optional Workers AI reviewer is disabled by default; its free-plan availability is quota-limited and is not an unlimited inference service. A reliable live economic calendar, gold price feed, or AI model may have separate quotas or paid tiers; no provider is represented as unlimited-free. The default SiftingIO Commodities free tier currently includes 10,000 REST requests/month, no card, one WebSocket connection and five symbol subscriptions. The Worker checks every two minutes only during the combined London/New York weekday session window (up to about 14 hours/day). At that upper bound, the feed can use roughly 9,240 requests in a 22-business-day month or 9,660 in a 23-business-day month, close to the 10,000-request free allowance; manual `/analyze` calls can add requests. If the provider quota is reached, data refresh fails closed rather than switching to a paid provider. This provider's XAUUSD price is an aggregated spot/reference value, not the user's broker quote; its `v` field is tick-count volume, not exchange-traded volume. Its free tier is for personal/internal non-commercial use and is best-effort without an uptime SLA. The default system therefore remains analysis-and-alerts-only and should not be used as an execution-price feed. Details: [SiftingIO Free Commodities](https://sifting.io/free-market-data-api), [XAUUSD reference](https://sifting.io/symbols/commodities/XAUUSD), [OHLCV API](https://sifting.io/docs/historical/commodities).

## Roadmap

1. Verify SiftingIO entitlement, end-to-end 1m bars and derived 5m/30m candles in D1 after the user adds `SIFTING_API_KEY`.
2. Add a trustworthy, user-approved equity/risk snapshot source; the market data API does not provide the user's account equity or prop-firm drawdown.
3. Add timestamped DXY and US 10-year Treasury yield data; scheduled-event protection alone is not complete macro context.
4. Backtest using the user's broker-specific XAUUSD history, spreads, slippage and session rules; prevent look-ahead bias.
5. Paper trade, compare signals against the existing playbook, calibrate scores and risk vetoes.
6. Calibrate and test the optional veto-only Workers AI reviewer; deterministic safety gates remain authoritative.

## License

This independent project does not redistribute TradingAgents source code. It references the upstream project's public design and Apache-2.0 license; see the upstream repository for its license terms.
