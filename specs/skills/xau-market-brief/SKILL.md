---
name: xau-market-brief
description: Establishes XAUUSD identity, candle provenance, timestamps, completion and coverage before technical or risk analysis.
metadata:
  group: Markets
---

Begin by confirming that the instrument is XAUUSD and that the supplied data source is known. For each required timeframe (1m, 5m and 30m), record the number of candles, interval, source, newest candle timestamp and whether that candle is complete.

Check ordering, duplicate timestamps, gaps, impossible OHLC relationships and non-finite values. Never treat an in-progress candle as a completed close. Apply configured freshness limits; do not silently relax them when a timeframe has fewer bars.

A data-quality failure is a finding, not a prompt to guess. If a required timeframe is missing, stale, incomplete or internally inconsistent, report the precise failure and let the coordinator return NO_TRADE.
