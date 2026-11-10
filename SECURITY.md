# Security policy

Supahound holds read-only OAuth tokens for its users' Supabase orgs. Report every vulnerability
privately.

## Report a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repo
([direct link](https://github.com/FlywheelStudio/supahound/security/advisories/new)). Never open
a public issue, pull request or discussion for a vulnerability.

Include what you found, the steps to reproduce it, the commit or version, and what an attacker
could do with it.

We answer within 3 business days. We tell you when we have fixed it and credit you in the
advisory, unless you ask us not to.

## Scope

In scope: the code in this repo, including the web app, the poller, the detectors, tenant
isolation (`withTenant`, forced RLS), the token vault and the OAuth flow.

Out of scope here: a self-hosted copy that someone else runs (report it to them), and Flywheel's
hosted service at `app.supahound.com` (report it here too; we route it).

## Rules for testing

- Test only against your own deployment and your own Supabase projects.
- Never read, change or delete another person's data.
- Never run the scan funnel against a domain you do not control.
