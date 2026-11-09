# 018: Keep the Vercel AI SDK and Vercel AI Gateway

Date: 2026-11-08

## Context

Everything but the database runs on Cloudflare (decision 008). We asked whether to move model calls
to Cloudflare AI Gateway, the Cloudflare-native equivalent, to put the whole stack on one vendor.

## Decision

Keep the Vercel AI SDK (`ai` package) as the model-calling library and the agent-loop pattern, and
keep Vercel AI Gateway as the routing, spend-cap, fallback and ZDR layer. Every model call still
goes through the one ZDR module (decision 005). Do not move to Cloudflare AI Gateway.

This covers both the Supahound incident explainer (Haiku 5.5 + Grok, decision 011) and the scan
funnel's model layer (GLM-4.6, PRD), which already assume the Vercel AI SDK and Gateway.

## Why

ZDR is the binding constraint (decisions 005, 008), and Cloudflare AI Gateway does not cover the
models we use:

- Cloudflare ZDR applies only to **Unified Billing** traffic (Cloudflare-managed keys) for OpenAI,
  Anthropic, Google, xAI and Groq. BYOK and provider-native requests are excluded, and ZDR does not
  control logging (a separate `cf-aig-collect-log-payload` header does).
- **GLM-4.6 (Z.ai) and DeepSeek — the scan funnel's chosen models — are not documented Unified
  Billing providers.** Through Cloudflare they would run BYOK with no Cloudflare ZDR.
- The agent loop is already built on the Vercel AI SDK. The explainer and the scan funnel share one
  pattern, one interface, one place where ZDR is proven. Splitting model traffic across two gateways
  would split that guarantee.

## Alternatives considered

- **Cloudflare AI Gateway.** Gateway free; model tokens passed through at provider rates; a 5% fee on
  Unified Billing credit purchases. Rejected: the ZDR gap above, and the rewrite to a second gateway
  buys only single-vendor tidiness.
- **Two gateways (Vercel for GLM, Cloudflare for Haiku/Grok).** Rejected: two code paths and two ZDR
  stories for no clear gain.

## Consequences

- `AI_GATEWAY_API_KEY` and Vercel AI Gateway stay the model path. Decision 008's "model calls stay on
  Vercel AI Gateway" stands, now with the Cloudflare option evaluated and declined.
- One service (model routing) stays off Cloudflare. Accepted: the model layer is a thin,
  config-driven seam, and uniform ZDR outweighs single-vendor neatness.
- Revisit if Cloudflare adds Unified Billing + ZDR for the scan funnel's models, or if the model
  choice moves to a Cloudflare ZDR provider. A reversal gets a superseding record.
