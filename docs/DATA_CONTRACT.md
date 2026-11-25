# Data contracts

All administrative endpoints use HTTPS and require the header `X-Ingest-Secret: <INGEST_SECRET>`.

## Candles

`POST /market/candles`

```json
{
  "symbol": "XAUUSD",
  "timeframe": "1m",
  "candles": [
    {
      "time": 1795632000000,
      "open": 2640.1,
      "high": 2641.2,
      "low": 2639.8,
      "close": 2640.9,
      "volume": 137
    }
  ]
}
```

- `time` is Unix milliseconds. ISO-8601 timestamps are also accepted.
- Send completed candles in ascending timestamp order. Up to 200 candles per request.
- Send separate requests for `1m`, `5m` and `30m`.
- `volume` should be broker tick volume when true centralized volume is unavailable. Never label tick volume as exchange volume.
- Duplicate timestamps are updated idempotently in D1.

## Daily equity / risk

`POST /risk/snapshot`

```json
{
  "dayStartEquity": 10000,
  "currentEquity": 9960,
  "observedAt": 1795632000000
}
```

`observedAt` is the source observation time in Unix milliseconds and must be within 2 minutes of server time. `currentEquity` must include floating PnL. Risk snapshots older than `RISK_MAX_AGE_MINUTES` are treated as unverified. The first snapshot of the configured trading day establishes the stored day-start baseline; subsequent snapshots update current equity. The daily lock remains active after the threshold is crossed, even if equity later recovers. Trading-day timezone is configured through `RISK_TIMEZONE`.

## Macro and calendar context

`POST /macro/context`

```json
{
  "source": "YOUR_VERIFIED_MACRO_PROVIDER",
  "asOf": 1795632000000,
  "calendarCoverageMinutes": 180,
  "highImpactEventWithinMinutes": null,
  "dxyTrend": "NEUTRAL",
  "us10yTrend": "BULLISH",
  "note": "Optional concise sourced context"
}
```

`highImpactEventWithinMinutes` is either the number of minutes until the next high-impact event or `null` when the source confirms no such event in the stated coverage window. Do not send `null` when the calendar source is unavailable. `asOf` must be a current timestamp. The context becomes stale after `MACRO_MAX_AGE_MINUTES`.

## Manual analysis

`POST /analysis/run` uses only the latest fresh macro context previously validated and stored through `/macro/context`; the request body cannot override it. A macro snapshot older than the configured freshness window is rejected at ingestion. A successful request always returns the complete analysis record; it does not place any order.
