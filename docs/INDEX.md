# Docs index

| Doc | Description |
| --- | --- |
| [STATE.md](STATE.md) | In progress, completed and backlog |
| [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) | Detectors 2 and 4 prototype: status, field paths, known gaps |
| [wip/tenant-isolation.md](wip/tenant-isolation.md) | Multi-tenant storage, RLS, token vault, poller |
| [wip/incident-explainer.md](wip/incident-explainer.md) | Incident engine and ZDR-only LLM explainer |
| [decisions/001-typescript-node-worker.md](decisions/001-typescript-node-worker.md) | TypeScript on Node.js 22+, no framework |
| [decisions/002-ownership-from-rls-policies.md](decisions/002-ownership-from-rls-policies.md) | Ownership from RLS policies, per command, not column names |
| [decisions/003-service-role-network-memory.md](decisions/003-service-role-network-memory.md) | Service-role networks learned on the first poll |
| [decisions/004-tenant-isolation.md](decisions/004-tenant-isolation.md) | Postgres with forced RLS, scoped transactions, per-tenant token keys |
| [decisions/005-zdr-only-model-calls.md](decisions/005-zdr-only-model-calls.md) | Every model call uses zero data retention through one module |
| [decisions/006-no-cross-tenant-learning.md](decisions/006-no-cross-tenant-learning.md) | No fleet priors or other learning across tenants |
