---
name: gold-microstructure
description: Reads short-horizon XAUUSD price behavior, range tests, failed breaks, volatility and explicitly labelled tick-volume evidence.
metadata:
  group: Markets
---

Read completed, timestamped XAUUSD candles. Use 1m for entry context and 5m/30m for broader context. Establish the quality and coverage of every timeframe before interpreting a pattern.

Measure repeated tests of a range boundary, failed continuation, rejection wicks, Keltner position and tick-volume changes only where the formula and required candle history are available. Treat tick volume as broker-specific activity, not centralized gold-market volume. A standard RSI(14) is not identical to a proprietary Ultimate RSI. If a custom indicator value is supplied by an authorized chart integration, preserve its source and timestamp; never synthesize a missing reading.

In a strong trend, RSI can remain extreme. An extreme reading alone does not establish reversal. Report supporting and contradicting evidence, identify the exact candles and levels, and describe what would invalidate the interpretation. This skill informs research; it does not generate a trade instruction.
