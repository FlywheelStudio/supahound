-- Billing with a validated card, priced per watched project by its traffic (issue #25, decision 028).
--
-- billing_accounts: one row per tenant. Holds Stripe IDs, the subscription status the gate reads,
--   the seats billed per tier, the card check result and the accepted terms. No card data.
-- stripe_events: the Stripe event IDs already processed for a tenant, so a replayed webhook
--   changes nothing.
-- project_usage: edge-log requests per project per UTC day, counted once a day by the poller.
--   The sum of the last 30 days sets each project's tier (projects.billing_tier).
--
-- The scheduler reads billing_accounts (tenant_id, status) only, to skip tenants that have not
-- paid. The app may insert and update billing rows but never delete them: they are the record of
-- what the customer agreed to.

BEGIN;

CREATE TABLE supahound.billing_accounts (
  tenant_id uuid PRIMARY KEY REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  status text NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  subscription_id text UNIQUE CHECK (subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  starter_seats integer CHECK (starter_seats >= 0),
  pro_seats integer CHECK (pro_seats >= 0),
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  card_verified_at timestamptz,
  verification_error text CHECK (verification_error ~ '^[a-z_]{1,64}$'),
  terms_version text CHECK (length(terms_version) BETWEEN 1 AND 50),
  terms_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A subscription exists only after a card passed the check.
  CHECK (subscription_id IS NULL OR card_verified_at IS NOT NULL)
);

ALTER TABLE supahound.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.billing_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.billing_accounts TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
CREATE POLICY scheduler_read ON supahound.billing_accounts FOR SELECT TO supahound_scheduler USING (true);
GRANT SELECT, INSERT, UPDATE ON supahound.billing_accounts TO supahound_app;
GRANT SELECT (tenant_id, status) ON supahound.billing_accounts TO supahound_scheduler;

CREATE TABLE supahound.stripe_events (
  tenant_id uuid NOT NULL REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  event_id text NOT NULL CHECK (event_id ~ '^evt_[A-Za-z0-9]{1,64}$'),
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);

ALTER TABLE supahound.stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.stripe_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.stripe_events TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT ON supahound.stripe_events TO supahound_app;

CREATE TABLE supahound.project_usage (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  day date NOT NULL,
  requests bigint NOT NULL CHECK (requests >= 0),
  counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, day),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE supahound.project_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.project_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.project_usage TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
GRANT SELECT, INSERT, UPDATE ON supahound.project_usage TO supahound_app;

-- The tier each project bills at, from its last 30 days of requests. New projects start on starter.
ALTER TABLE supahound.projects
  ADD COLUMN billing_tier text NOT NULL DEFAULT 'starter' CHECK (billing_tier IN ('starter', 'pro')),
  ADD COLUMN requests_30d bigint CHECK (requests_30d >= 0),
  ADD COLUMN usage_counted_at timestamptz;

COMMIT;
