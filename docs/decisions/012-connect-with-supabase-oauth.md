# 012: Customers connect Supabase through an OAuth app

Date: 2026-10-27

## Decision

- Onboarding has a "Connect Supabase" button. Guardbase asks for `analytics:read` and
  `database:read` only.
- The OAuth `state` is stored server-side, single-use, bound to the session user and tenant, with
  PKCE. The callback rejects a state whose user or tenant does not match the session, so nobody can
  connect their org into another tenant.
- Tokens are sealed per tenant + connection (decision 004). Refresh takes the connection row lock
  (`SELECT … FOR UPDATE`) and re-reads the token first, so concurrent pollers never race a
  rotating refresh token.

## Alternatives considered

- Pasting a personal access token: faster, but full account access with no expiry.
