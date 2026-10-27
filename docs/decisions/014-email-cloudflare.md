# 014: Cloudflare Email Service for all email

Date: 2026-10-27 · Revises the PRD research row (Cloudflare primary, SES failover)

## Decision

Magic links, incident alerts and the weekly digest go out through Cloudflare Email Service from a
Worker. Alert bodies use template or validated model text only, escaped, with links stripped
(PRD, Clean alerts).

## Open

The PRD suggested Amazon SES as a failover for critical alerts while Cloudflare's service is in
beta. Not built; Erik decides.
