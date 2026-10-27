# 005: Every model call uses zero data retention

> Model choice superseded by [011](011-models-haiku-and-grok.md): Luna dropped, Grok fallback. The ZDR rules stand.

Date: 2026-10-27

## Context

Erik's rule: all AI SDK calls use zero data retention (ZDR). The PRD routes incident summaries
through Vercel AI Gateway with Haiku 5.5, GPT-6 Luna as fallback, then template text.

## Decision

- `src/explainer/llm.ts` is the only module that calls a model. ESLint blocks model calls, the
  gateway factory, provider SDKs, dynamic imports of them and vendor URLs in every other file.
- Every call sends `providerOptions.gateway.zeroDataRetention: true` and
  `disallowPromptTraining: true` from a frozen object. The gateway then routes only to providers
  with a ZDR agreement, and fails the request if none serves the model.
- A routing report that shows no ZDR discards the output. Any failure falls to template text, so
  an alert never waits on a model.
- No BYOK keys, no prompt caching, no tools or files.
- The model gets one incident's whitelisted features. The actor is "actor A". No IDs, user agents,
  query values, emails, IPs or tenant names.
- Model slugs: `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`. These come from the installed
  `@ai-sdk/gateway` types; the PRD's `claude-haiku-5-5` is the Anthropic API ID, not the gateway
  slug.

## Alternatives considered

- Team-wide ZDR in the gateway dashboard only: one setting, but a dashboard change could silently
  turn it off. Per-request ZDR is in code and tested. Team-wide ZDR can be added on top
  ($0.10 per 1,000 requests); Erik's call.

## Consequences

- Needs a Vercel Pro or Enterprise team.
- OpenAI's gateway ZDR terms read "ZDR with safety retention". If that does not meet the bar, drop
  the Luna fallback and go straight to template text.
