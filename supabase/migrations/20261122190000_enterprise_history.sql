-- Enterprise history (issue #170, decision 048).
--
-- A workspace marked Enterprise sees and keeps one year of incident history, findings and
-- security events; every other workspace keeps today's windows (30 days, decision 035; 90 days,
-- decision 044). A staff-exempt workspace (decision 029) gets the same year without this column.
--
-- enterprise_at is when an operator marked the workspace Enterprise, after terms were agreed by
-- hand (Enterprise has no Stripe price, decision 028). The app reads it and never writes it.
-- Clearing it is the downgrade: older history is hidden at once and deleted by the daily data job
-- only once the workspace no longer pays (decision 037). Nothing new is stored per row.
--
-- Additive: one nullable column, no default, no existing row changes, no new grant (supahound_app
-- already holds SELECT and UPDATE on the table; the scheduler does not need it).

ALTER TABLE supahound.billing_accounts ADD COLUMN enterprise_at timestamptz;

COMMENT ON COLUMN supahound.billing_accounts.enterprise_at IS
  'Decision 048: when an operator marked this workspace Enterprise (1-year history); NULL otherwise. Set by hand, never by the app.';
