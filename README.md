# XAU AI Supervisor

A Cloudflare Worker-based supervisory service for XAU/USD signal validation and Telegram notifications.

## Current MVP

- Health endpoint: `GET /health`
- Signal intake: `POST /signal`
- Telegram command webhook: `POST /telegram/webhook`
- Signal checks: payload authentication, symbol/side/price validation, minimum confidence, minimum risk/reward, daily lock check.
- Duplicate signal suppression when KV is configured.
- No broker execution. Accepted signals are notifications only.

## Deploy

1. Install Node.js (LTS).
2. Run `npm install`.
3. Create a Cloudflare KV namespace and bind it as `SUPERVISOR_KV` in `wrangler.toml`.
4. Set secrets:
   - `npx wrangler secret put TELEGRAM_BOT_TOKEN`
   - `npx wrangler secret put TELEGRAM_CHAT_ID`
   - `npx wrangler secret put WEBHOOK_SECRET`
5. Run `npm run typecheck`.
6. Run `npm run deploy`.

Do not commit tokens, secrets, account credentials, or private webhook URLs.

## Signal payload

Send a POST request to `/signal` with JSON:

```json
{
  "id": "unique-signal-id",
  "symbol": "XAUUSD",
  "side": "BUY",
  "entry": 2650.0,
  "stopLoss": 2647.0,
  "takeProfit": 2655.0,
  "confidence": 82,
  "strategy": "TradingView alert",
  "secret": "YOUR_WEBHOOK_SECRET"
}
```

The example prices are illustrative only. The service does not generate a market signal or place an order.

## Telegram

Configure Telegram's webhook to point to `https://YOUR-WORKER.workers.dev/telegram/webhook`. The configured chat can use `/help` and `/status`.

## Important limitations

This is the first deployable foundation, not yet an autonomous AI trading system. It currently receives externally generated signals; it does not fetch live market data, calculate indicators, run a backtest, or execute trades. Daily loss state is scaffolding only until trade-result ingestion and persistent risk accounting are implemented. Do not use it for live trading or rely on it as a financial risk control until those features have been implemented and tested.
