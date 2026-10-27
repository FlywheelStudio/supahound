# 011: Haiku 5.5 with a Grok fallback; Luna dropped

Date: 2026-10-27 · Supersedes the model choice in [005](005-zdr-only-model-calls.md) (ZDR rules stand)

## Decision

- Primary `anthropic/claude-haiku-5.5` with `reasoning: 'low'`.
- Fallback `spacexai/grok-4.20-non-reasoning`, no reasoning setting. Used only when Haiku refuses
  or fails. Then template text.
- Both list "Zero data retention: available" on the AI Gateway model page (checked 2026-10-27).

## Cost

Haiku 5.5: $0.10 / $0.50 per million tokens. Grok 4.20 non-reasoning: $1.25 / $2.50, about 12×
Haiku per token. At about 2,000 tokens in and 500 out, an incident costs about $0.0005 on Haiku
and $0.004 on Grok. No Grok model on the gateway is cheaper than Haiku 5.5.

## Unverified until the first live call

Whether Grok accepts `Output.object` structured output through the gateway, and what its routing
metadata reports. Either failure falls back to template text.
