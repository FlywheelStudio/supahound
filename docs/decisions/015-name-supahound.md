# 015: The product is named Supahound

Date: 2026-10-28 · Replaces the working name Guardbase

## Decision

Erik named the product Supahound. Every identifier follows the name: the package scope
`@supahound/*`, the Postgres schema `supahound`, the roles `supahound_app` and
`supahound_scheduler`, the `SUPAHOUND_*` settings, and the Worker and queue names.

## Why now

Nothing is deployed and no credentials are sealed. Later, the rename would need a schema
migration, new Worker and queue names, and a re-seal of every token: the vault's key-derivation
label and AAD (additional authenticated data) both contain the name.

## Everything else

On 2026-10-31 Erik asked to rename everything:

- The GitHub repository is `FlywheelStudio/supahound` (private), and the local folder is
  `Development/supahound` (it was `supadog`).
- The PRD (Claude Doc) is titled "Supahound PRD". Its naming row now notes that Supabase's catalog
  bars only the word "Supabase", and that its Branding Guidelines, not yet checked, may limit
  "Supa" names.
- Older decision records use the new name. Commit messages written before the rename keep the old
  one; rewriting published history is not worth it.
