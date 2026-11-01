import { randomUUID } from "node:crypto";
import { Client } from "pg";
import PgBoss from "pg-boss";
import { env } from "../../src/config/environment";
import {
  runtimeRolePlan,
  RUNTIME_QUEUES,
} from "../../src/database/runtime-role-plan";

test("the reviewed runtime role can use existing queues and application data but cannot alter schema, audit history or queue schema versions", async () => {
  if (!new URL(env.DATABASE_URL).pathname.endsWith("_test"))
    throw new Error(
      "Runtime permission checks require an isolated _test database.",
    );
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const schema = `runtime_queue_test_${suffix}`,
    role = `neptun_runtime_test_${suffix}`;
  const client = new Client({
    connectionString: env.DATABASE_URL,
    statement_timeout: 10000,
  });
  await client.connect();
  const adapter = {
    executeSql: (text: string, values: unknown[]) => client.query(text, values),
  };
  const ownerBoss = new PgBoss({
    db: adapter,
    schema,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  let runtimeBoss: PgBoss | undefined;
  try {
    await ownerBoss.start();
    for (const queue of RUNTIME_QUEUES) await ownerBoss.createQueue(queue);
    await ownerBoss.stop();
    await client.query("BEGIN");
    // Keep role, grants and test records inside one rollback-only transaction.
    const plan = runtimeRolePlan(role, { queueSchema: schema })
      .replace(/^BEGIN;$/m, "")
      .replace(/^COMMIT;$/m, "");
    await client.query(plan);
    // Refreshing a dedicated role must also remove stale column grants;
    // PostgreSQL's table-level REVOKE alone does not remove them.
    await client.query(`GRANT UPDATE (action) ON account_audit TO "${role}"`);
    await client.query(
      runtimeRolePlan(role, { grantsOnly: true, queueSchema: schema })
        .replace(/^BEGIN;$/m, "")
        .replace(/^COMMIT;$/m, ""),
    );
    const organization = randomUUID();
    await client.query(
      "INSERT INTO organizations(id,name,slug) VALUES($1,'Runtime permission test',$2)",
      [organization, suffix],
    );
    await client.query(`SET LOCAL ROLE "${role}"`);
    runtimeBoss = new PgBoss({
      db: adapter,
      schema,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await runtimeBoss.start();
    await runtimeBoss.createQueue("catalog-refresh");
    expect(
      await runtimeBoss.send("catalog-refresh", { permissionTest: true }),
    ).toBeTruthy();
    await runtimeBoss.stop();
    await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      organization,
    ]);
    await client.query(
      "INSERT INTO settings(organization_id,value) VALUES($1,'{}')",
      [organization],
    );
    await client.query(
      "INSERT INTO account_audit(organization_id,action) VALUES($1,'permission.test')",
      [organization],
    );
    // Exercise the previously missing upload, notification and import-status
    // privileges, and the real INSERT-only review projection behavior.
    const user = randomUUID(),
      campaign = randomUUID(),
      thread = randomUUID();
    await client.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only-hash')",
      [user, `runtime-${suffix}@example.test`],
    );
    await client.query(
      "INSERT INTO memberships(organization_id,user_id,role,review_role) VALUES($1,$2,'editor','staff')",
      [organization, user],
    );
    await client.query(
      "INSERT INTO campaigns(organization_id,id,name,layout) VALUES($1,$2,'Runtime test','{}')",
      [organization, campaign],
    );
    const upload = (
      await client.query<{ id: string }>(
        "INSERT INTO upload_intents(organization_id,storage_key,max_size,mime_type,expires_at) VALUES($1,'pending',1024,'image/png',now()+interval '5 minutes') RETURNING id",
        [organization],
      )
    ).rows[0]!.id;
    await client.query(
      "UPDATE upload_intents SET storage_key='test/expected.png' WHERE id=$1",
      [upload],
    );
    expect(
      (
        await client.query(
          "SELECT storage_key FROM upload_intents WHERE id=$1 FOR UPDATE",
          [upload],
        )
      ).rows[0]?.storage_key,
    ).toBe("test/expected.png");
    const notification = (
      await client.query<{ id: string }>(
        "INSERT INTO workspace_notifications(organization_id,recipient_id,event_id,type,campaign_id,campaign_name,actor_role,actor_name,message) VALUES($1,$2,$3,'review_comment',$4,'Runtime test','pm','Reviewer','Comment') RETURNING id",
        [organization, user, randomUUID(), campaign],
      )
    ).rows[0]!.id;
    await client.query(
      "UPDATE workspace_notifications SET read_at=now() WHERE id=$1",
      [notification],
    );
    await client.query(
      "SELECT imported_at FROM import_sources WHERE organization_id=$1",
      [organization],
    );
    await client.query(
      "INSERT INTO review_threads(organization_id,id,campaign_id,page_index) VALUES($1,$2,$3,0) ON CONFLICT(organization_id,id) DO UPDATE SET fixed=EXCLUDED.fixed",
      [organization, thread, campaign],
    );
    await client.query(
      "INSERT INTO review_comments(organization_id,id,thread_id,text,author_email,created_at) VALUES($1,$2,$3,'Comment','reviewer@example.test',now()) ON CONFLICT(organization_id,id) DO NOTHING",
      [organization, randomUUID(), thread],
    );
    await client.query(
      "INSERT INTO review_history(organization_id,id,campaign_id,event) VALUES($1,$2,$3,'{}') ON CONFLICT DO NOTHING",
      [organization, randomUUID(), campaign],
    );
    await client.query(
      "UPDATE campaigns SET deleted_at=now() WHERE organization_id=$1 AND id=$2",
      [organization, campaign],
    );
    await client.query(
      "UPDATE campaigns SET deleted_at=NULL WHERE organization_id=$1 AND id=$2",
      [organization, campaign],
    );

    // Inventory covers every application table and all DML found in src (not
    // operator import/provision/migration scripts). New tables fail this gate.
    const rows = (
      await client.query<{
        name: string;
        selects: boolean;
        inserts: boolean;
        updates: boolean;
        deletes: boolean;
      }>(`
      SELECT c.relname name,
        has_table_privilege(current_user,c.oid,'SELECT') selects,
        has_table_privilege(current_user,c.oid,'INSERT') inserts,
        has_table_privilege(current_user,c.oid,'UPDATE') updates,
        has_table_privilege(current_user,c.oid,'DELETE') deletes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname
    `)
    ).rows;
    const mutable =
      "account_tokens ai_jobs ai_proofread_checks ai_results asset_aliases assets brochures campaign_edit_presence catalog_source_brands catalog_source_categories catalog_sync_runs email_outbox identity_rate_limits job_outbox lifestyle_quota memberships product_images products review_threads settings social_posts upload_intents users workspace_notifications campaigns".split(
        " ",
      );
    const append =
      "account_audit activity_audit ai_usage asset_variants brand_assets document_versions lifestyle_acceptances review_comments review_history".split(
        " ",
      );
    const replace = "brochure_pages campaign_products sessions".split(" ");
    const deletable =
      "sessions identity_rate_limits campaign_products brochure_pages campaign_edit_presence".split(
        " ",
      );
    const read = "organizations import_sources".split(" ");
    const deniedTables = "schema_migrations invitations exports".split(" ");
    expect(rows.map((row) => row.name).sort()).toEqual(
      [...mutable, ...append, ...replace, ...read, ...deniedTables].sort(),
    );
    for (const row of rows)
      expect(row).toEqual({
        name: row.name,
        selects: !deniedTables.includes(row.name),
        inserts:
          mutable.includes(row.name) ||
          append.includes(row.name) ||
          replace.includes(row.name),
        updates: mutable.includes(row.name),
        deletes: deletable.includes(row.name),
      });
    expect(
      (
        await client.query(
          "SELECT action FROM account_audit WHERE organization_id=$1",
          [organization],
        )
      ).rows,
    ).toEqual([{ action: "permission.test" }]);
    async function denied(sql: string) {
      await client.query("SAVEPOINT permission_check");
      try {
        await expect(client.query(sql)).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT permission_check");
      }
    }
    await denied("CREATE TABLE public.runtime_forbidden(id int)");
    await denied("UPDATE account_audit SET action='changed' WHERE false");
    await denied("DELETE FROM account_audit WHERE false");
    await denied("DELETE FROM document_versions WHERE false");
    await denied("UPDATE review_comments SET text='changed' WHERE false");
    await denied("UPDATE review_history SET event='{}' WHERE false");
    await denied("UPDATE ai_usage SET cost_usd=0 WHERE false");
    await denied("UPDATE import_sources SET report='{}' WHERE false");
    await denied("UPDATE organizations SET name='changed' WHERE false");
    await denied("DELETE FROM users WHERE false");
    await denied(`UPDATE "${schema}".version SET version=0`);
    await denied(
      `SELECT "${schema}".create_queue('unexpected-new-queue','{}')`,
    );
    await denied("SELECT * FROM schema_migrations");
  } finally {
    await runtimeBoss?.stop().catch(() => {});
    await ownerBoss.stop().catch(() => {});
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`DROP ROLE IF EXISTS "${role}"`);
    await client.end();
  }
});

test("the SQL planner rejects arbitrary identifiers and does not accept passwords or silently reuse owner roles", () => {
  for (const role of [
    "neondb_owner",
    "postgres",
    "neptun_runtime; DROP TABLE users",
    "neptun_runtime' injected",
  ])
    expect(() => runtimeRolePlan(role)).toThrow();
  expect(() =>
    runtimeRolePlan("neptun_runtime", {
      queueSchema: "pgboss; DROP TABLE users",
    }),
  ).toThrow();
  const plan = runtimeRolePlan();
  expect(plan).toContain(
    "NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
  );
  expect(plan).not.toMatch(/PASSWORD\s+'/);
});
