# WIP: Incident engine and LLM explainer (ZDR only)

Goal: group findings into incidents (per actor, 15-minute window) and write each incident's plain
summary with an LLM. Every model call uses zero data retention (ZDR). One call covers one incident
of one tenant.

## Status — 2026-10-27

- Built: incident engine (`src/incidents/engine.ts`) and explainer. Tested with mock models and
  a captured gateway HTTP body.
- **Next step:** one live call with an AI Gateway key on a Pro team. Check the model slugs, that
  `reasoning: 'low'` passes through, and what `routing.planningReasoning` returns.

## Approach

- Incident engine: pure function over open incidents + new findings. Key = tenant + project + actor.
  Never merges across projects.
- Explainer: AI SDK 7 through Vercel AI Gateway. Primary `anthropic/claude-haiku-5.5` (`reasoning: 'low'`),
  fallback `spacexai/grok-4.20-non-reasoning` (no reasoning setting), then template text. No
  temperature. Luna dropped (decision 011).
- ZDR choke point: `src/explainer/llm.ts` is the only module allowed to import model calls.
  ESLint `no-restricted-imports` enforces it. The module sets
  `providerOptions.gateway.zeroDataRetention = true` after merging, so nothing overrides it.
  A test captures the HTTP body sent to the gateway and checks the flag on both models.
- Prompt input: structured features only. Actor IDs become aliases ("actor A"). No user agents,
  query values, emails or IPs. Output validated against the evidence; on mismatch, template text.

## Verify on the first live call

- Model slugs: `anthropic/claude-haiku-5.5` and `spacexai/grok-4.20-non-reasoning` come from the installed gateway
  types (`@ai-sdk/gateway@4.0.128`). The PRD's `claude-haiku-5-5` is wrong for the gateway.
- `routing.planningReasoning` shows "ZDR requested". Recorded as `zdrConfirmed`.

## For Erik to decide

- Team-wide ZDR in the AI Gateway dashboard: $0.10 per 1,000 requests, a second safeguard.

## Build log

- Explainer built: `features.ts` (whitelist rebuild, actor aliased), `validate.ts`, `template.ts`,
  `llm.ts` (the only model caller). ESLint blocks model calls, the gateway factory, provider SDKs,
  dynamic imports of them and vendor URLs everywhere else; `test/zdrGuard.test.ts` proves the
  rule fires.
- Wire test: `createGateway({ fetch })` captures the real HTTP bodies. Both the Haiku and the
  fallback request carry `providerOptions.gateway.zeroDataRetention: true`.
- A routing report that names providers without "ZDR" now discards the output (fail closed).
  A response with no routing report is accepted and recorded as `zdrConfirmed: null`.
- Mutation checks that fail the suite: flag removed, flag false, options not passed, routing check
  skipped, number check skipped, actor not aliased.
- Incident engine: one incident per actor per project, extended inside 15 minutes, severity =
  worst finding raised one level when two detectors fire, pages on new >= high or on escalation
  to high. Throws on any incident from another scope. 8 tests.
- ZDR lint guard widened to `.tsx`, `.mts`, `.cts`, `.mjs`, `.cjs`.
