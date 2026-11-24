---
name: gold-microstructure
description: Reads short-horizon XAUUSD range behavior, failed breaks, Keltner re-entry and tick-volume context.
metadata:
  group: Markets
---

Use the 1-minute chart for entry timing and 5-minute/30-minute charts for trend context. Prefer several independent pieces of evidence: exhaustion, failure to extend a high or low, a return inside the Keltner envelope, repeated tests of a range boundary, and tick-volume confirmation. Treat tick volume as broker-specific activity, not centralized gold-market volume. Standard RSI(14) is not identical to a proprietary Ultimate RSI. If a custom indicator value is supplied from an authorized chart integration, preserve its source and timestamp. Never synthesize a missing reading. In a strong trend, RSI can remain extreme; do not fade it without a failure/rejection pattern. Capital preservation outranks signal frequency.
