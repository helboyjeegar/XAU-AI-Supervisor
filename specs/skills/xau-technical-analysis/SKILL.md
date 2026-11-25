---
name: xau-technical-analysis
description: Reads XAUUSD trend, momentum, volatility and turning levels across 1m, 5m and 30m without treating indicators as standalone signals.
metadata:
  group: Markets
---

Use completed, timestamped OHLCV candles. The 1m chart is the entry context; 5m and 30m establish the broader context. Report whether 5m and 30m agree. A conflict is a hard blocker under this project's decision policy.

Describe price structure, momentum, volatility and support/resistance as evidence. The user's chart workflow references Keltner Channel and Ultimate RSI extremes below 20 or above 80. These may be calculated only where the exact calculation and adequate history are available. An indicator reading is context, not a signal by itself. Keltner re-entry or a return from an RSI extreme must be described with the candle timestamps that support it.

Repeated tests of a level, candle wicks and volume expansion may be reported when their definitions are explicit. Tick volume must be labelled as a proxy. Do not claim exact parity with RSI Volume, Range Detector Alpha Wizard, Leg Anatomy, Luxe Algo or any other proprietary TradingView script. If the exact formula is unavailable, state that the native calculation is an approximation or mark it unavailable.

Describe both bullish and bearish evidence, the levels that would invalidate each reading, and what is uncertain. Do not issue a BUY/SELL instruction.
