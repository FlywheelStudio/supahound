# 023: The Supabase OAuth app also requests `projects:read`

Date: 2026-11-09. Amends the scope line of decision 012.

## Context

Decision 012 limits the OAuth grant to `analytics:read` and `database:read`. The project picker
(issue #9) lists an org's projects with `GET /v1/projects`, and that endpoint needs
`projects:read`. The public site and the privacy policy said Supahound asks for the two scopes only.

## Decision

1. The Supabase OAuth app requests three read-only scopes: `analytics:read`, `database:read` and
   `projects:read`. Erik decided this on 2026-11-09.
2. Every page that names the scopes names all three: home, privacy policy, `llms.txt`, the compare
   page and the platform FAQs. The overview's Connect text names the project list.
3. The rest of decision 012 stands.

## Alternatives considered

- **Paste project refs, no new scope.** Supahound would check each ref with a logs call. Rejected:
  setup is clumsier, the user must type each name, and a typo fails late.

## Consequences

- Register the OAuth app (#4) with all three scopes. A connection made without `projects:read`
  shows "Reconnect Supabase" on the picker.
- The PRD (Claude Doc) still names two scopes. Erik updates it.
- The privacy policy changed. The legal review before launch covers it.
