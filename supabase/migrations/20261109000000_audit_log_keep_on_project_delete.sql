-- Removing a watched project (issue #9) deletes its incidents, findings and poll runs, but the
-- audit log is the customer's record of every query Supahound ran. Keep those rows and clear only
-- their project link (decision 022). ON DELETE SET NULL (column) needs Postgres 15 or later.
BEGIN;

ALTER TABLE supahound.audit_log
  DROP CONSTRAINT audit_log_tenant_id_project_id_fkey,
  ADD CONSTRAINT audit_log_tenant_id_project_id_fkey
    FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id)
    ON DELETE SET NULL (project_id);

COMMIT;
