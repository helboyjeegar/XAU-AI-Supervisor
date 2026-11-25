# XAU AI Supervisor

A signal-only XAU/USD research and risk-supervision service. The architecture is inspired by the specialist-agent workflow in [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), but this repository is an independent implementation tailored to gold and short-horizon multi-timeframe analysis.

> **Safety:** This project does not connect to a broker or place orders. A BUY/SELL result is an analytical alert only. The engine fails closed when candle data, macro context, or the daily-equity snapshot is missing or stale. Do not use it for live trading until independent backtesting, forward testing and account-specific validation are complete.

## Current implementation (0.3.0)

- Cloudflare Worker API with authenticated market-data and risk ingestion.
- D1 persistence for OHLCV candles, analysis decisions, daily risk state and macro context.
- Four specialist modules: Gold Technical Analyst, Quant Research, Macro Strategy and Risk Analysis; a deterministic supervisor combines their findings.
- 1m entry analysis with 5m and 30m trend context.
- EMA(20/50), Wilder RSI(14), ATR(14), Keltner envelope, repeated-range tests, tick-volume comparison and rejection-wick anatomy.
- Daily drawdown lock based on externally supplied start-of-day and current equity. The current equity must include floating PnL.
- Telegram notifications with a 15-minute same-direction alert cooldown and `/status`, `/analyze`, `/help` commands.
- Freshness validation for equity snapshots; an old or delayed equity update cannot authorize a trade.
- Optional Cloudflare Workers AI adversarial reviewer. It is disabled by default and can only veto a deterministic candidate; it cannot create or approve signals.
- GitHub Actions type-check and unit-test workflow.
- Read-only MT5 desktop bridge source at [mt5/XAU_AI_Supervisor.mq5](mt5/XAU_AI_Supervisor.mq5), with Persian installation instructions in [docs/MT5_BRIDGE_FA.md](docs/MT5_BRIDGE_FA.md). The bridge is source code until installed and verified on the user's terminal; it does not place orders.

The score is an **evidence score, not a statistically calibrated probability**. Standard RSI is not the proprietary Luxe Algo Ultimate RSI; tick volume is broker-specific and is not centralized spot-gold volume. Proprietary indicator readings are not fabricated.

## Runtime architecture

```text
MT5 broker feed / other authorized market feed
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
3. Apply `migrations/0001_init.sql` (or run the documented Wrangler migration command after creating the database binding).
4. Add Worker secrets: `INGEST_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`.
5. Connect GitHub repository branch `develop` in **Workers & Pages → Create application → GitHub**. Build command: `npm install && npm run check`; deploy command: `npx wrangler deploy`.
6. Configure Telegram's webhook URL and secret token as described in [docs/DEPLOYMENT_FA.md](docs/DEPLOYMENT_FA.md).
7. Keep `ENABLE_AI_REVIEW=false` during initial deployment. Workers AI has quotas; enable the veto-only reviewer only after verifying the account's free-plan allowance and testing.

The D1 binding is intentionally commented out until the real database ID exists. Do not add tokens or account credentials to GitHub.

## Free-tier expectations

The architecture avoids a dedicated always-on server. Cloudflare Free is quota-limited, not unlimited: Workers, D1 and Workers AI each have usage ceilings. The current release does not require a paid LLM API. The optional Workers AI reviewer is disabled by default; its free-plan availability is quota-limited and is not an unlimited inference service. A reliable live economic calendar, gold price feed, or AI model may have separate quotas or paid tiers; no provider is represented as unlimited-free. The MT5 bridge uses the gold price feed provided by the user's own broker and does not require a separate market-data API subscription; it does require MT5 desktop to remain connected and running.

## Roadmap

1. Verify the MT5 bridge end-to-end on the user's broker: 1m/5m/30m closed candles, equity snapshots, data freshness and reconnect recovery.
2. Add sourced macro/calendar and dollar/yield adapters with timestamp and freshness guarantees.
3. Backtest using broker-specific XAUUSD history, spreads, slippage and session rules; prevent look-ahead bias.
4. Paper trade, compare signals against the existing playbook, calibrate scores and risk vetoes.
5. Calibrate and test the optional veto-only Workers AI reviewer; deterministic safety gates remain authoritative.

## License

This independent project does not redistribute TradingAgents source code. It references the upstream project's public design and Apache-2.0 license; see the upstream repository for its license terms.
