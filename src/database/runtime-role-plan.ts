/** Reviewable provisioning only. This module neither connects nor handles passwords. */
export const RUNTIME_QUEUES = [
  "catalog-refresh",
  "catalog-images",
  "catalog-brand-images",
  "catalog-daily",
  "asset-variants",
  "cutout-cleanup",
  "ai-image",
  "ai-text",
  "__pgboss__send-it",
] as const;

const mutableTables = [
  "account_tokens",
  "ai_jobs",
  "ai_proofread_checks",
  "ai_results",
  "asset_aliases",
  "assets",
  "brochures",
  "campaign_edit_presence",
  "campaigns",
  "catalog_source_brands",
  "catalog_source_categories",
  "catalog_sync_runs",
  "email_outbox",
  "identity_rate_limits",
  "job_outbox",
  "lifestyle_quota",
  "memberships",
  "product_images",
  "products",
  "review_threads",
  "settings",
  "social_posts",
  "upload_intents",
  "users",
  "workspace_notifications",
];
const appendOnlyTables = [
  "account_audit",
  "activity_audit",
  "ai_usage",
  "asset_variants",
  "brand_assets",
  "document_versions",
  "lifestyle_acceptances",
  "review_comments",
  "review_history",
];
const replaceableTables = ["brochure_pages", "campaign_products", "sessions"];
const deletableTables = [
  "sessions",
  "identity_rate_limits",
  "campaign_products",
  "brochure_pages",
  "campaign_edit_presence",
];

export function runtimeRolePlan(
  role = "neptun_runtime",
  options: { grantsOnly?: boolean; queueSchema?: string } = {},
): string {
  if (!/^neptun_runtime(?:_[a-z0-9_]+)?$/.test(role) || role.length > 63)
    throw new Error(
      "Choose a neptun_runtime role name using lowercase letters, digits and underscores.",
    );
  const queue = options.queueSchema || "pgboss";
  if (!/^[a-z][a-z0-9_]*$/.test(queue) || queue.length > 63)
    throw new Error("Invalid queue schema identifier.");
  const identifier = (value: string) => `"${value}"`;
  const tables = (values: string[]) =>
    values.map((table) => `public.${identifier(table)}`).join(", ");
  const runtime = identifier(role),
    schema = identifier(queue);
  return `-- REVIEW BEFORE APPLYING. Run with the schema owner after application/queue migrations.
-- The new role is deliberately NOLOGIN. This plan contains no password or connection URL.
-- Existing roles: use grantsOnly only after checking they are dedicated application roles.
BEGIN;
${options.grantsOnly ? "" : `CREATE ROLE ${runtime} WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`}
DO $neptun_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
    RAISE EXCEPTION 'Runtime role does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit))
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='${role}')
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='${role}' AND n.nspname IN ('public','${queue}')) THEN
    RAISE EXCEPTION 'Runtime role must be unprivileged, have no role memberships and own no application objects';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE grantee='PUBLIC' AND table_schema IN ('public','${queue}')) THEN
    RAISE EXCEPTION 'Review and remove PUBLIC table grants before provisioning a private runtime role';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${role}');
END
$neptun_role$;
-- PUBLIC CREATE would otherwise be inherited by every role. Review other clients first.
REVOKE CREATE ON SCHEMA public, ${schema} FROM PUBLIC;
REVOKE ALL ON SCHEMA public, ${schema} FROM ${runtime};
GRANT USAGE ON SCHEMA public, ${schema} TO ${runtime};
REVOKE ALL ON ALL TABLES IN SCHEMA public, ${schema} FROM ${runtime};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, ${schema} FROM ${runtime};
-- Table REVOKE does not clear earlier column-level privileges. Rebuild those
-- too when refreshing an existing dedicated runtime role's reviewed grants.
DO $neptun_columns$
DECLARE old_grant record;
BEGIN
  FOR old_grant IN SELECT table_schema,table_name,column_name,privilege_type
    FROM information_schema.column_privileges
    WHERE grantee='${role}' AND table_schema IN ('public','${queue}')
  LOOP
    EXECUTE format('REVOKE %s (%I) ON TABLE %I.%I FROM %I', old_grant.privilege_type,
      old_grant.column_name,old_grant.table_schema,old_grant.table_name,'${role}');
  END LOOP;
END
$neptun_columns$;
GRANT SELECT ON public.organizations TO ${runtime};
GRANT SELECT ON public.import_sources TO ${runtime};
-- SELECT FOR UPDATE in Settings needs UPDATE on at least one organization column.
GRANT UPDATE (id) ON public.organizations TO ${runtime};
GRANT SELECT, INSERT, UPDATE ON ${tables(mutableTables)} TO ${runtime};
GRANT SELECT, INSERT ON ${tables(replaceableTables)} TO ${runtime};
GRANT DELETE ON ${tables(deletableTables)} TO ${runtime};
GRANT SELECT, INSERT ON ${tables(appendOnlyTables)} TO ${runtime};
-- Runtime cannot modify import metadata or access migration records, legacy
-- invitations or the currently unused server-side exports table.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime};
REVOKE ALL ON ${schema}.version FROM ${runtime};
GRANT SELECT ON ${schema}.version TO ${runtime};
GRANT UPDATE (maintained_on, cron_on, monitored_on) ON ${schema}.version TO ${runtime};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime};
GRANT USAGE ON TYPE ${schema}.job_state TO ${runtime};
GRANT EXECUTE ON FUNCTION ${schema}.create_queue(text, json) TO ${runtime};
COMMIT;
-- Activate only after permission checks: use psql \\password ${role} (hidden prompt),
-- then ALTER ROLE ${runtime} LOGIN. Never paste the password into this plan or Git.
`;
}
