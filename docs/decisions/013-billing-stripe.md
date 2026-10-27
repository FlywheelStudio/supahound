# 013: Stripe for billing

Date: 2026-10-27

## Decision

- Stripe Checkout and the Billing Portal. Plans from the PRD: Free, Builder ($29 per project per
  month), Agency ($19 per project per month, 10-project minimum).
- Checkout sets `client_reference_id` and subscription metadata to the tenant ID on the server.
  The webhook verifies the signature (`constructEventAsync` with the SubtleCrypto provider on
  Workers), then writes through `withTenant`. Processed event IDs are stored per tenant, so a
  replayed event changes nothing.
- Test-mode keys only in tests. Live-mode products, prices and webhooks need Erik's approval.
