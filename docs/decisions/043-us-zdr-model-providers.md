# 043: AI calls go only to US first-party providers, with ZDR

Date: 2026-11-22 · Builds on [005](005-zdr-only-model-calls.md) (ZDR rules) and
[011](011-models-haiku-and-grok.md) (models). Issue #126.

## Context

Erik's rule: Supahound never sends logs, or anything derived from them, to a Chinese model
provider. Every AI feature runs with zero data retention (ZDR) in the US, through Vercel AI Gateway.

ZDR alone (decision 005) does not pin geography. On 2026-11-22 the gateway served Haiku 5.5 from
`anthropic`, `bedrock` (US, plus EU, AU and JP regions), `claudeaws` and `vertexAnthropic` (US
and EU), and Grok 4.20 from `xai` and `vertex`. Every one of these listed ZDR and a US
headquarters, but some serve from non-US regions.

## Decision

- Every model call sends `providerOptions.gateway.only: ["anthropic", "xai"]`, frozen together
  with the ZDR flags in `packages/core/src/explainer/llm.ts`. Each model then runs only on its
  maker's own US API: Haiku 5.5 on Anthropic, Grok 4.20 on xAI.
- If neither listed provider can serve a request with ZDR, the gateway fails it and the alert
  uses template text. There is no fallback to another provider.
- No model from a Chinese provider (for example DeepSeek, Qwen, Kimi, GLM, MiniMax) may be added,
  directly or through a reseller. Adding any provider or model needs a new decision record.
- The model only ever receives one incident's whitelisted features (decision 005). Raw log rows,
  user agents, query values, emails, IPs and tenant names never reach it.

## Scope

This covers model calls only. Supahound's own Postgres is hosted by Supabase (decision 008), and
the region of that project is a separate choice.

## Consequences

- If a provider has an outage, the gateway can't route around it through a reseller. The alert
  still goes out, with template text.
- `explainer.test.ts` checks the allowlist on the mock call and in the real HTTP body sent to the
  gateway.
