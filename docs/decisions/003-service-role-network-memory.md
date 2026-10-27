# 003: Service-role networks are learned on the first poll

Date: 2026-10-27

## Context

The PRD lists detector 4 as baseline-free, but "service key used from a new network" needs to know
which networks are old.

## Decision

Keep a per-project set of hosting ASNs seen with the service key. The first poll learns silently.
Later polls flag a new hosting ASN once (medium), then learn it. Browser, mobile-app and
non-hosting signals need no memory and fire from the first poll. Only server-like callers on
hosting networks teach the set.

## Alternatives considered

- Alert on every network until the customer approves it: noisy on day one.
- Full statistical baseline: contradicts "baseline-free" and delays protection 7 days.

## Consequences

The poller must persist the set. A key leaked before onboarding and used from a cloud VM is learned
on the first poll; the browser and non-hosting signals still catch the common leak.
