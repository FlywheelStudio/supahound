# 032: One Stripe subscription per project

Date: 2026-11-11 · Issue #99 · Supersedes the seat model in 028

## Context

Decision 028 bills a workspace on one subscription with Starter and Pro seats. Erik chose on
2026-11-11 to bill each project on its own subscription, as PushFire and ULink do.

## Decision

1. The workspace keeps one Stripe customer and the validated card (028's $1 hold stays).
2. Each watched project gets its own subscription at its tier (Starter or Pro, set by traffic as
   in 028). Project Settings → Plan & billing shows that subscription, its next charge and invoices.
3. Existing workspace subscriptions move to per-project subscriptions without a double charge.

## Status

Accepted; not built. Until #99 ships, Plan & billing is read-only and links to workspace billing.
Building it needs Erik's approval for live Stripe changes and for moving the live workspace.

## Open questions (answer in #99 before the build)

- The trial: one 7-day trial per workspace, or per project.
- Adding a project mid-month: bill from that day, or from the next renewal.
