---
name: xau-macro-outlook
description: Assesses sourced US macro releases and scheduled USD events that may affect XAUUSD, with strict publication-time and freshness checks.
metadata:
  group: Markets
---

Read the connected macro calendar and macro series, if available. For each item, preserve source, actual publication time, timezone, event importance, retrieval time and whether the value is actual, forecast or previous. Do not treat forecast or previous values as actual results.

Explain possible gold transmission through USD strength, rates, real yields, central-bank expectations and risk sentiment only when the corresponding data is present. Separate observation from inference. Do not assign a directional gold forecast from the event label alone.

Reject stale or malformed records. If DXY, Treasury yields or another series is not connected, explicitly say so; do not fill the gap with assumptions. Report upcoming high-impact USD events and the configured no-trade window around them.
