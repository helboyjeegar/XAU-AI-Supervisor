# TradingAgents v1.0.1 XAUUSD Port Plan

Status: implemented as a Worker-safe research adapter in the active production decision path; this is a bounded adaptation of TradingAgents v1.0.1, not the upstream CLI runtime.

## Source of truth

- Upstream: https://github.com/TauricResearch/TradingAgents
- Pinned upstream release: `v1.0.1`
- Upstream commit: `121265d18d467ac717f7af99cb0d669c15d2e73c`
- License: Apache-2.0
- This project must derive its research workflow, agent responsibilities, skill format, evidence handling, and decision process from this upstream source. Do not introduce a competing trading framework or an independent signal strategy.

## What the upstream framework actually provides

The pinned release is a TypeScript codebase compiled into a platform-specific executable. Its package declares Node.js >=22 and depends on AI SDK/provider packages, React/Ink terminal UI, filesystem/session facilities, and data-provider integrations. Its engine separates:

1. A main agent that plans the research, chooses tools and skills, delegates work, weighs reports, and writes the final answer.
2. Specialist agents that work in separate contexts and return concise, evidence-referenced reports.
3. Data tools that fetch facts and compute tools that calculate from returned data.
4. Skills, expressed as Agent Skills Markdown files, that describe repeatable research methods.
5. An evidence store that records tool results and supports citations/references.
6. Explicit usage limits and failure handling.

The upstream source is not a ready-made Cloudflare Worker package. Its CLI/session/catalog paths use Node/Bun and filesystem capabilities. A direct bundle into this Worker would be an unsupported runtime transplant.

## XAUUSD agent map

| Upstream role | XAUUSD responsibility | Inputs |
| --- | --- | --- |
| Main agent / coordinator | Plan the analysis, dispatch specialists, compare reports, apply hard gates, publish a decision record | Specialist reports, evidence IDs, risk snapshot |
| Macro Strategy | Assess USD-sensitive macro conditions and scheduled high-impact events; distinguish reported facts from inference | Existing macro calendar feed; only actually connected macro series/market data |
| Quant Research | Measure XAUUSD price behavior on 1m, 5m and 30m; trend, momentum, volatility, levels and volume proxies | Sourced OHLCV candles |
| Risk Analysis | Independently challenge data freshness, directional conflict, stop geometry, reward/risk and daily-loss constraints | Candle-derived levels, risk snapshot, event context |

The Equity Research role is not applicable to spot gold and must not be fabricated. The main coordinator remains responsible for the overall plan and final synthesis.

## XAUUSD skills to implement in the upstream Agent Skills format

- `xau-market-brief`: identify symbol, data source, timestamps, completed-candle status, and missing coverage before analysis.
- `xau-technical-analysis`: compare 1m entry evidence with 5m and 30m context; describe trend, momentum, volatility and price levels as evidence, not as an automatic signal.
- `xau-macro-outlook`: interpret only sourced USD/macro releases and scheduled events; do not invent DXY, Treasury yields or market expectations when feeds are absent.
- `xau-risk-assessment`: challenge the thesis, define invalidation, verify stop/target geometry and enforce daily risk.
- `xau-decision-review`: require the coordinator to reconcile specialist disagreement and cite the evidence supporting each material claim.

Skills follow the upstream `SKILL.md` frontmatter/body convention. The active Worker cannot read project files at runtime, so the core XAU skill instructions are embedded in `src/tradingagents-engine.ts` and must be kept synchronized with the Markdown skill files. The Worker does not yet run the upstream free-form agent tool loop, dynamic delegation planner, or filesystem-backed skill loader; it uses a fixed, bounded four-inference workflow (Macro and Quant in parallel, Risk challenge, then main coordinator) with a prebuilt evidence bundle.

## Existing user constraints that remain hard gates

- Instrument: XAUUSD only.
- Entry context: 1-minute; 5-minute and 30-minute context must be checked.
- Intended holding context: approximately 30 minutes, not a 1-minute-only scalp.
- A 5m/30m directional conflict blocks a trade.
- Existing minimum evidence score remains 75; this is an evidence score, never a probability.
- Existing minimum reward/risk setting remains enforced.
- Daily loss limit remains 5%; risk snapshot must be verified and no older than the existing 2-minute validity window.
- Missing/stale candles, incomplete timeframe coverage, invalid stop geometry, missing/expired risk snapshot, macro data that cannot be verified, or a failed specialist review must result in `NO_TRADE`.
- No automatic broker execution. This system is research and alerting only.

## Indicator evidence and data integrity

The user's chart workflow references Keltner Channel, Ultimate RSI extremes (below 20 / above 80), RSI Volume, repeated support/resistance tests, and a range detector. These may be represented only as explicitly documented XAUUSD skill evidence calculated from available candles. Do not claim parity with proprietary TradingView scripts. Tick volume is not exchange-wide traded volume and must be labelled as a proxy. Any approximation must identify its formula and test coverage. If required input is absent, mark it unavailable rather than infer it.

## Runtime and cost decision

Do not import the full upstream CLI into Cloudflare Workers. Build a Worker-compatible adapter around the upstream concepts and contracts: coordinator, specialist reports, skill loading, evidence IDs, data/compute tool separation, budgets, and safe failure semantics.

The upstream engine expects a model client. No paid provider may be enabled silently. Before enabling an LLM route, prove its authentication, cost/quota, latency, output validation and failure behavior. If no acceptable no-cost model route is available, keep the decision path in `NO_TRADE` and report the limitation. A deterministic calculation is a tool result, not a substitute for claiming that an LLM agent ran.

## Runtime status and remaining differences

- Production uses a fixed Worker-safe pipeline: closed-candle preflight and evidence generation; isolated Macro and Quant inferences; deterministic ATR reference-price/stop/target geometry; independent Risk challenge; contract validation; coordinator synthesis; D1 audit persistence; Telegram alert.
- A deterministic gate now rejects opposite non-neutral Macro and Quant conclusions before the coordinator runs. While the connected Macro source is calendar-only (no DXY/US10Y series), any directional model output is normalized to NEUTRAL; a calendar event alone is not directional gold evidence. A neutral Macro report can coexist with a directional Quant candidate.
- The embedded prompts carry the core instructions from the XAU macro, technical-analysis and risk-assessment skills. The Markdown `SKILL.md` files remain the human-readable specifications and must be kept in sync.
- This remains a bounded adapter, not a full port of upstream's step-by-step tool-calling loops, main-agent planning, dynamic specialist delegation, filesystem sessions, or general-purpose tool registry. Those capabilities are intentionally not transplanted into the Worker runtime.
- Model calls remain subject to Cloudflare Workers AI quota/limits and an 8-run daily budget. One run reserves budget once and invokes four model inferences. No guarantee of unlimited free inference is made.
- The model's BUY/SELL is a research direction; entry is the last completed 1m close, and stop/target are deterministic ATR levels. The Telegram message now labels this as a reference price, not a broker fill or executable quote.
- No broker API is connected. The user-entered risk snapshot is not independently verified by a broker and expires after two minutes. DXY and US10Y remain unavailable unless connected.
- Paper Trading remains a separate deterministic simulation strategy, not the TradingAgents alert path; its assumptions are documented independently.
- CI and deployment status are tracked by the corresponding GitHub PR and Cloudflare deployment records. Never enable broker execution.

## Attribution

This plan is based on TauricResearch/TradingAgents v1.0.1 source files and specifications, including `src/engine/engine.ts`, `src/engine/delegation.ts`, `src/agents/agent-file.ts`, `src/agents/skill-file.ts`, `src/agents/prompts.ts`, `src/tools/evidence-store.ts`, `specs/agents/{macro,quant,risk}.md`, and `specs/skills/{technical-analysis,macro-outlook,risk-assessment}/SKILL.md`.

Copyright remains with the respective authors. Upstream license: Apache-2.0.
