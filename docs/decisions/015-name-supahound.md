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

## Not renamed

- The repository folder is still `supadog`. Renaming it moves the Claude Code project history and
  memory, so Erik renames it when he wants to.
- The PRD (Claude Doc) still says Guardbase. Older decision records now use the new name.
