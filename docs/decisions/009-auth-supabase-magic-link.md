# 009: Sign-in with Supabase Auth magic links

Date: 2026-10-27

## Decision

- Supabase Auth (on Supahound's own Supabase project) issues magic links and sessions.
- Supabase's Send Email Hook calls a Cloudflare Worker, which verifies the hook signature and
  sends the email through Cloudflare Email Service.
- Server code trusts a user ID only from a verified Supabase JWT, never from request input.
- Users join tenants through `supahound.memberships`; every request checks membership inside the
  same transaction that reads tenant data.
- V2/V3: more OAuth sign-in providers, possibly "Sign in with Supabase". Configuration only.

## Alternatives considered

- Own magic-link auth on Workers: no Supabase dependency, but more security code to own.
