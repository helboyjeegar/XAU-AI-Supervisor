---
name: xau-risk-assessment
description: Challenges an XAUUSD setup using data freshness, verified daily risk, invalidation, stop distance and reward-to-risk.
metadata:
  group: Risk
---

Start with hard blockers. Confirm that the 1m, 5m and 30m candles are fresh and complete and that the 5m and 30m directions agree. Confirm a verified daily risk snapshot with a timestamp inside the configured validity window. A missing, expired or unverified snapshot blocks a trade.

Check the configured maximum daily loss, current loss percentage and lock state. The maximum daily loss is 5% unless the deployment configuration explicitly sets a stricter limit; never raise it in analysis. Confirm stop-loss and take-profit are on the correct sides of entry and that the computed reward-to-risk meets the configured minimum.

Do not infer account equity, broker position size, leverage, spread, slippage or fill price when the source has not supplied them. State any unavailable execution assumptions. The system is an alerting/research system and must not place trades.

A failed check or unresolved material uncertainty means NO_TRADE.
