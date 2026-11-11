-- Billing with a validated card (issue #25, decision 028).
--
-- billing_accounts: one row per tenant. Holds Stripe IDs, the subscription status the gate reads,
--   the card check result and the accepted terms. No card data: Stripe holds the card.
-- stripe_events: the Stripe event IDs already processed for a tenant, so a replayed webhook
--   changes nothing.
--
-- The scheduler reads billing_accounts (tenant_id, status) only, to skip tenants that have not
-- paid. The app may insert and update billing rows but never delete them: they are the record of
-- what the customer agreed to.

BEGIN;

CREATE TABLE supahound.billing_accounts (
  tenant_id uuid PRIMARY KEY REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  plan text CHECK (plan IN ('builder', 'agency')),
  status text NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  subscription_id text UNIQUE CHECK (subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  seats integer CHECK (seats > 0),
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

COMMIT;
