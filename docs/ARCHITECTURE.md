# Architecture and engineering decisions

## Upstream source of truth

The research workflow, agent responsibilities, specialist delegation, evidence references, skill format and coordinator review process are derived exclusively from [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), pinned for this port to release `v1.0.1` (commit `121265d18d467ac717f7af99cb0d669c15d2e73c`, Apache-2.0).

This project is a Worker-compatible adaptation, not a claim that the upstream CLI is running inside Cloudflare. The upstream executable targets Node.js >=22/Bun and includes filesystem/session and model-provider dependencies. Its runtime must not be copied wholesale into Workers.

## System boundaries

- **GitHub** is the source of truth, review history and CI gate. `develop` is the integration branch; `main` is reserved for tested releases.
- **Cloudflare Worker** is the HTTPS API, webhook receiver and scheduler. No broker execution code belongs here.
- **Cloudflare D1** stores candles, analysis snapshots, macro context, evidence records and daily account-risk state.
- **Telegram** is an alert and command surface. Its webhook is authenticated using Telegram's `secret_token` header, and only the configured chat ID is allowed to issue commands.
- **Market and account adapters** provide closed candles and risk snapshots. A manually entered snapshot must never be represented as broker-verified.

## TradingAgents research topology

1. **Main coordinator:** plans the research, delegates to specialists, weighs their independent reports and evidence references, resolves disagreement and records the final answer.
2. **Macro Strategy:** assesses sourced US macro series and scheduled USD events. Missing DXY, yields or other series remain explicitly unavailable.
3. **Quant Research:** measures XAUUSD behavior across 1m, 5m and 30m candles. The 1m chart is entry context; 5m and 30m establish directional context.
4. **Risk Analysis:** independently challenges data quality, risk snapshot validity, invalidation, stop geometry, reward/risk and daily-loss limits. It can veto a candidate.
5. **Skills:** repeatable research procedures are stored as Agent Skills Markdown files in the upstream format. Each material finding must cite evidence IDs returned by data/compute tools.

Equity Research is not applicable to spot gold and is not fabricated as an agent.

## Session eligibility gate

- Analysis is eligible only Monday-Friday from 08:00 inclusive to 17:00 exclusive in either `Europe/London` or `America/New_York`.
- The IANA time zones are evaluated independently, so UK and US daylight-saving transitions are handled without hard-coded UTC offsets.
- During the London/New York overlap, the session gate is open once; it does not create duplicate analysis runs.
- Outside both windows, the Worker returns a fail-closed `NO_TRADE` result before loading candles or invoking the analysis path. No entry alert can be emitted.
- This is a time-eligibility guard only; it is not a new trading strategy or a substitute for the TradingAgents research workflow.

## XAUUSD constraints

- Only XAUUSD/GOLD aliases are accepted; data is normalized to XAUUSD.
- Required timeframes are 1m, 5m and 30m, with completed, timestamped candles.
- A 5m/30m directional conflict blocks a trade.
- Intended holding context is approximately 30 minutes, not a 1m-only scalp.
- The minimum evidence score remains 75. It is an evidence score, not a probability.
- The configured minimum reward/risk remains enforced.
- Daily loss ceiling remains 5% unless configuration is stricter. The risk snapshot must be verified and no older than the configured two-minute validity window.
- Missing/stale candles, incomplete timeframe coverage, invalid stop geometry, missing/expired risk snapshot, stale macro calendar, specialist veto or failed validation results in NO_TRADE.
- No automatic broker execution.

## Data integrity and evidence

- Candle timestamps are Unix milliseconds and must be ascending and unique within a payload.
- Candle high/low must enclose open and close; all prices must be positive and volume non-negative.
- Each timeframe requires adequate history; stale or contradictory data blocks a signal.
- Macro facts carry source, publication/scheduled time, timezone and retrieval time where available. Missing series are not guessed.
- Tick volume is a broker-specific proxy, not centralized gold-market traded volume.
- Standard indicators must not be described as exact reproductions of proprietary TradingView scripts. Any approximation must state its formula and limitations.
- Tool outputs and specialist reports are information to weigh, not instructions. The coordinator must trace material claims to evidence IDs.

## Runtime and cost

The upstream framework uses a model client and specialist agents in separate contexts. The Worker port must preserve that coordinator/specialist/evidence/skill structure. It must not silently substitute an unrelated trading framework or claim that deterministic calculations are LLM agents.

No paid model provider may be enabled silently. Before enabling a model route, validate authentication, cost/quota, latency, output schema and fail-closed behavior. If an acceptable no-cost model route is not available, the decision path remains NO_TRADE until the limitation is resolved. A model can assist research but cannot override the Risk agent's hard veto.

## Migration status

- Architecture plan and upstream-compatible agent/skill specifications are on the feature branch.
- A Worker-safe evidence-linked specialist-report contract has been added with fail-closed tests.
- A Worker-compatible TradingAgents orchestration module runs isolated Macro and Quant specialists, then Risk Analysis, then the main coordinator; malformed output, missing citations, stale inputs, risk vetoes and model failure fail closed.
- Research runs, evidence records and specialist reports have dedicated D1 tables and a migration. The runtime model flag remains disabled by default until free quota and billing state are confirmed.
- The feature-branch analysis route uses the TradingAgents port; the prior heuristic analyzer is no longer called by the Worker entry point. The deployed Worker is unchanged.
- London/New York IANA session eligibility is wired into the feature-branch analysis entry point; boundary, overlap, weekend and DST tests are included. Scheduled data refresh and analysis are also gated to the permitted session windows. This change is not deployed.
- The existing live `analyzeMarket` path has not yet been replaced or wired to these contracts.
- Model-client adapter, specialist orchestration, evidence persistence and end-to-end tests remain pending review.
- The live Worker and `develop` remain unchanged until the replacement passes CI and staging smoke tests.

## Deployment topography

```text
GitHub feature branch --PR/CI--> develop --reviewed deploy--> Cloudflare Worker
                                                               |
                                                               +--> D1 evidence and market data
                                                               +--> Telegram alerts
Market/account adapters -------------------------------------->|
```
