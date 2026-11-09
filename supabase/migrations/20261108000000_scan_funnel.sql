-- Scan funnel (hackme.si): the free AI pentest that feeds Supahound trials.
--
-- The funnel shares Supahound's account and tenancy: a scan account is a Supahound account, so
-- every row here carries tenant_id and lives under the same forced RLS as the rest of the schema
-- (decision 016). The authorization trail (verified domain + accepted scope) is first-class data,
-- not a log line: no active scan runs without a verified domain row and an authorization row.

BEGIN;

-- A domain a user has claimed. It becomes scannable only once verified_at is set by a DNS TXT
-- proof (packages/core/src/scan/verify.ts). The token is single-use and expires.
CREATE TABLE supahound.scan_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  apex text NOT NULL CHECK (apex ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND length(apex) <= 253),
  verification_token text NOT NULL CHECK (verification_token ~ '^[0-9a-f]{32}$'),
  token_expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  -- The IP that completed verification, and the structured resolver responses, as the audit trail.
  verifying_ip inet,
  verification_audit jsonb CHECK (verification_audit IS NULL OR jsonb_typeof(verification_audit) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, apex)
);

ALTER TABLE supahound.scan_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.scan_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.scan_domains TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.scan_domains TO supahound_app;

-- The accepted scope/authorization agreement: who consented, to which version, from where. Append
-- only for the app (no UPDATE/DELETE grant), like audit_log — it is legal evidence of consent.
CREATE TABLE supahound.scan_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  tos_version text NOT NULL CHECK (length(tos_version) BETWEEN 1 AND 50),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  ip inet,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, domain_id) REFERENCES supahound.scan_domains (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX scan_authorizations_domain_idx ON supahound.scan_authorizations (tenant_id, domain_id);

ALTER TABLE supahound.scan_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.scan_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.scan_authorizations TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT ON supahound.scan_authorizations TO supahound_app;

-- One scan run against a verified domain.
CREATE TABLE supahound.scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('introductory', 'advanced')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  score smallint CHECK (score BETWEEN 0 AND 100),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, domain_id) REFERENCES supahound.scan_domains (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX scans_domain_idx ON supahound.scans (tenant_id, domain_id, created_at DESC);

ALTER TABLE supahound.scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.scans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.scans TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.scans TO supahound_app;

-- A finding from a scan. Evidence is structured JSON only (counts, enums, endpoints), never raw
-- attacker-controlled text. supahound_monitor names the monitor that watches this continuously.
CREATE TABLE supahound.scan_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  endpoint text CHECK (endpoint IS NULL OR length(endpoint) <= 2048),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  fix text,
  supahound_monitor text CHECK (supahound_monitor IS NULL OR length(supahound_monitor) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, scan_id) REFERENCES supahound.scans (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX scan_findings_scan_idx ON supahound.scan_findings (tenant_id, scan_id);

ALTER TABLE supahound.scan_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.scan_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.scan_findings TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.scan_findings TO supahound_app;

-- The scan queue. Scans are long-running, so the web app enqueues a job and workers claim it.
CREATE TABLE supahound.scan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'done', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, scan_id) REFERENCES supahound.scans (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX scan_jobs_state_idx ON supahound.scan_jobs (state, created_at) WHERE state = 'queued';

ALTER TABLE supahound.scan_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.scan_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.scan_jobs TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.scan_jobs TO supahound_app;

COMMIT;
