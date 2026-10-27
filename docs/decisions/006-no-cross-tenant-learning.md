# 006: No learning across tenants

Date: 2026-10-27

## Context

The PRD's Baselines section lists "Fleet priors: patterns learned across all connected projects
cover the cold start." Erik's rule is that Guardbase never crosses client data.

## Decision

Do not build fleet priors. No detector, baseline, cache or model input reads another tenant's
data. Each project's state is keyed by tenant + project.

## Alternatives considered

- Fleet priors from aggregate, non-identifying statistics. Possible later, but only as a new
  decision record that Erik approves, with the data flow written down.

## Consequences

- Behavioral detectors (V2) start cold for every project and rely on the 7-day learning period.
- The PRD line conflicts with this record. The PRD needs an edit; Erik decides.
