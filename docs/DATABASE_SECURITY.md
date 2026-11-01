# Database security review and runtime role plan

Reviewed 1 November 2026. The initial audit was read-only. During the subsequently authorized rollout, a dedicated `neptun_runtime` account was created and its connection/permissions verified. Render's runtime-only start command is deployed and healthy. The account owner completed the Render credential switch; live checks found `neptun_runtime` connections, healthy readiness, authenticated campaign reads and 46/46 loaded campaign-screen images.

## Confirmed controls

- Product searches/batches, settings and document reads/writes bind user values as PostgreSQL parameters. Dynamic table/column fragments come from internal allowlists. The reviewed repositories scope customer data by the organization from the authenticated session, not an organization supplied in the request body.
- Authentication uses Argon2id password hashes, random session tokens stored as keyed hashes, active/verified membership checks on each request, and Secure/HttpOnly/SameSite=Lax production cookies. Account-role changes revoke sessions. The server enforces staff/admin/support and restricted catalog/social access.
- The prepared production connection uses `sslmode=verify-full`. A read-only connection inspection confirmed an authorized TLS 1.3 client socket. Neon's proxy can make `pg_stat_ssl` inside PostgreSQL report false; that value alone does not describe the encrypted client-to-proxy connection.
- The local and prepared production environment files have mode 0600 and contain separate 64-character session/upload secrets. This confirms the files on this machine; it does not independently verify Render's active environment.
- Normal document deletion is a soft disable with a new historical snapshot. Restoring a disabled document requires support permission in the same organization. There is no public route to delete database tables or audit history.

## Remaining hardening and deployment checks

**Runtime credential switch completed.** Render now connects as `neptun_runtime`, with no schema CREATE or audit UPDATE/DELETE privileges. The retained operator `neondb_owner` account owns all 42 public tables and has CREATE ROLE, CREATE DATABASE, REPLICATION and BYPASSRLS attributes; it can update/delete audit history and must stay outside the long-running runtime environment. All 42 public tables currently have row-level security disabled. Application organization filters are a real control, but a future missing filter has no database-level tenant policy as a second boundary.

The role plan below reduces runtime privileges. It does not add tenant RLS: that requires a separate design for transaction-local tenant context across the API and cross-organization workers. A runtime role still needs the application's legitimate organization data; do not describe it as per-tenant database isolation.

**Backups need an operational check.** `scripts/backup.ts` makes a consistent database/object snapshot, verifies object checksums and uses a private directory, but its dump and object copies are not encrypted by the script. Keep backups on an encrypted, separately controlled destination. The code/documented earlier restoration exercise does not establish current Neon point-in-time retention, recent backup success or a current recovery drill. Check the actual Neon plan/retention and access controls separately.

**Channel binding was disabled in node-postgres and is now enabled in source.** The URL contains `channel_binding=require`, but the installed `pg` client requires its separate `enableChannelBinding` option; the inspected pre-change client reported false. The API database pool, worker queue client and migration/queue-preparation clients now pass `enableChannelBinding: true`. This requests SCRAM-SHA-256-PLUS when the TLS server offers it, without weakening certificate verification. It is not a guarantee that the deployed server negotiated channel binding; validate after deployment. Verified TLS was already active.

## Prepare a dedicated runtime role

These commands produce or prepare a plan; they are not part of normal API/worker startup. Review the generated SQL with the database owner first. Do not execute it against production as part of an audit.

```sh
npx tsx scripts/prepare-runtime-role.ts --role=neptun_runtime > /tmp/neptun-runtime-role.sql
```

The SQL creates a **NOLOGIN**, NOINHERIT role with no superuser, role-creation, database-creation, replication or RLS-bypass attributes. It grants:

- Application SELECT/INSERT/UPDATE only on an explicit table list.
- DELETE only where current runtime code needs cleanup/replacement: sessions, rate limits, presence, brochure page projections and campaign product projections.
- SELECT/INSERT on audit, usage and historical review/version tables, with no UPDATE/DELETE.
- SELECT on organizations and column-level UPDATE on its ID solely because PostgreSQL requires an UPDATE privilege for the Settings `SELECT FOR UPDATE` lock.
- SELECT-only import metadata for catalog last-success status; upload-intent and notification INSERT/UPDATE access for existing upload/review flows.
- Pg-boss data access and existing-queue function execution, with read-only schema version plus updates to its maintenance timestamps. No schema ownership, schema CREATE or table DDL is granted.

The plan revokes CREATE on `public`/`pgboss` from PUBLIC because otherwise every role inherits it. Review any other database clients before applying that change. It rejects pre-existing PUBLIC table grants and privileged/owning/membership-bearing runtime roles rather than silently trusting them. It does not change the owner's password or demote the owner.

### Runtime SQL inventory

This inventory maps the API and worker SQL in `src`, including `ON CONFLICT DO UPDATE` and row locks. It excludes short-lived operator scripts (imports, initial administrator provisioning and migrations). It is a reviewed deployment draft, not evidence that all production flows have run under the new credential.

| Tables                                                                                                                                                             | Runtime privileges             | Source purpose                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `organizations`                                                                                                                                                    | SELECT; UPDATE on `id` only    | Tenant lookup, Settings row lock; organization creation/name/slug/settings changes remain operator-only     |
| `import_sources`                                                                                                                                                   | SELECT                         | Catalog last-success fallback in `CatalogRepository.status`                                                 |
| `account_tokens`, `identity_rate_limits`, `memberships`, `users`                                                                                                   | SELECT, INSERT, UPDATE         | Account invites, verification, passwords, roles and rate counters                                           |
| `sessions`                                                                                                                                                         | SELECT, INSERT, DELETE         | Login, logout and session revocation; no UPDATE                                                             |
| `settings`, `campaigns`, `social_posts`, `brochures`, `review_threads`                                                                                             | SELECT, INSERT, UPDATE         | Optimistic saves, review state, projections, soft deletion and restore                                      |
| `campaign_products`, `brochure_pages`                                                                                                                              | SELECT, INSERT, DELETE         | Rebuild current document projections; no UPDATE                                                             |
| `campaign_edit_presence`                                                                                                                                           | SELECT, INSERT, UPDATE, DELETE | Live presence upsert/removal                                                                                |
| `upload_intents`, `assets`, `asset_aliases`, `product_images`, `products`                                                                                          | SELECT, INSERT, UPDATE         | Staged uploads, immutable asset upsert/aliasing and catalog refresh                                         |
| `catalog_source_categories`, `catalog_source_brands`, `catalog_sync_runs`, `job_outbox`                                                                            | SELECT, INSERT, UPDATE         | Catalog hierarchy/run state and durable worker dispatch                                                     |
| `ai_jobs`, `ai_results`, `ai_proofread_checks`, `lifestyle_quota`, `email_outbox`, `workspace_notifications`                                                       | SELECT, INSERT, UPDATE         | Authorized AI jobs/quota, encrypted email outbox, notification read state; no DELETE paths                  |
| `account_audit`, `activity_audit`, `document_versions`, `review_comments`, `review_history`, `ai_usage`, `asset_variants`, `brand_assets`, `lifestyle_acceptances` | SELECT, INSERT                 | Append-only audit/history, usage and immutable relationships; comments/history use `ON CONFLICT DO NOTHING` |
| `schema_migrations`, `invitations`, `exports`                                                                                                                      | None                           | Owner-only migrations, unused legacy invitations/server-side export table                                   |

DELETE is additionally allowed on `identity_rate_limits` for expired counter cleanup. No runtime DELETE exists for AI, exports, email, users, memberships, review history or audit tables. The current worker only updates email status/scrubs its encrypted payload and updates AI status; it does not delete those records. The isolated runtime-role test checks all 42 public tables against this inventory, exercises upload/notification/review/status privileges and queue insertion, and proves dangerous schema/history changes are denied. Before a rollout, also exercise complete API/worker scenarios under the new credential on staging.

After applying the reviewed plan, use psql's hidden `\password neptun_runtime` prompt to assign a unique password, then explicitly enable LOGIN. Store the new credential only in the approved secret manager/runtime environment. Do not add passwords or connection URLs to generated SQL, Git, command arguments, logs or this document.

For future migrations, regenerate the existing role's explicit grants with `--grants-only`, review them, then validate permissions again. New tables/queue partitions are deliberately not granted through broad default privileges.

## Pg-boss and startup prerequisites

The pinned pg-boss version currently uses schema version 24. `src/worker.ts` starts pg-boss with its default migration behavior and calls `createQueue`. Pg-boss's `create_queue` returns immediately for an existing queue; a **new** queue requires partition/table DDL. Therefore granting broad schema CREATE to runtime is unnecessary when required queues have been prepared by the owner.

Prepare both the application migrations and pg-boss schema/partitions with a separate owner credential on a trusted operator/deployment machine. The queue preparation command defaults to a dry run:

```sh
npx tsx scripts/prepare-runtime-queues.ts
```

Only after deployment authorization, set `MIGRATION_DATABASE_URL` privately to the unpooled owner connection and run:

```sh
npx tsx scripts/prepare-runtime-queues.ts --execute --database=EXPECTED_DATABASE_NAME
```

This installs/upgrades the pinned pg-boss schema and precreates the seven application queues plus its internal cron queue. It registers no consumers, starts no schedule, sends no jobs, sends no email and calls no AI provider. The database-name guard and explicit migration variable prevent accidental fallback to runtime credentials.

Run application migrations separately with the owner on that trusted machine. The current `scripts/migrate.ts` reads the existing database configuration; supply owner configuration only to that short-lived migration process. Remove it from the runtime configuration afterward.

**Do not switch credentials while keeping the current `npm run start:combined` command unchanged.** That script first runs owner-level application migrations. After the owner migration and queue preparation steps are verified, use `node dist/scripts/start-combined.js` as the runtime-only start command, with restricted `DATABASE_URL` and matching unpooled `DIRECT_DATABASE_URL`. Do not retain the owner/migration URL in Render's long-running application environment. Future pg-boss/schema upgrades must repeat the authorized preparation step before deployment; missing migrations should fail startup visibly, not prompt a privilege grant to runtime.

The isolated `runtime-workspace.test.ts` now exercises actual Nest sign-in/session, a 62-product brochure save/update/conflict, settings, image upload/read, social post save/read, comments/replies/resolution/review completion and prepared queue scheduling/fetch/completion under the restricted role. External providers are disabled; it sends no real mail or AI request. The role inventory separately checks all 42 tables and denied DDL/history mutations.

During the authorized rollout, a real TLS connection as `neptun_runtime` verified normal read/save/upload grants and denied schema CREATE/audit mutations using metadata. Render's start command was changed to `node dist/scripts/start-combined.js`; the deployment succeeded and `/ready` returned 200. The private `render-runtime-update.env` file outside Git contains only the two replacement connection settings. The account owner entered these settings and the post-deploy checks passed: `/ready` returned 200, `pg_stat_activity` showed 10 runtime connections, and the existing authenticated platform session loaded campaign data and all 46 campaign-screen images. The existing owner account is retained for operator migrations/rollback, not normal runtime access. No production document or email was created for these checks.

After the connection switch, verify live authenticated reads, queue startup and expected runtime connections in `pg_stat_activity`. PostgreSQL's default PUBLIC CONNECT can permit connections to other databases; this plan grants application table access only in the selected database and does not claim network or per-tenant isolation. Keep the current deployment available until the live checks pass. No owner credential should remain in the long-running Render environment.
