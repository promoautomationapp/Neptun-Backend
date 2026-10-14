# Neptun Broshura backend

The full brochure editor connects to this backend for PostgreSQL records and private asset storage. Local development is running; production deployment and final feature-parity checks remain pending.

Use Node 22 and the locally installed PostgreSQL; Docker is not required. The existing project at `../neptun-campaign-studio` is read-only. Never run new migration or import commands inside that directory.

## Local setup

1. `npm ci`
2. For this machine, `.env` already uses the verified local PostgreSQL role `brikenaahmeti`. For another machine, copy `.env.example` to `.env`, adjust the database user/password, and replace the secret placeholders with independently generated random secrets. Do not copy credentials from the reference application.
3. `npm run db:create`
4. `npm run db:migrate`
5. `npm run db:seed`
6. `npm run import:catalog -- --dry-run`
7. `npm run import:catalog`
8. `npm run import:remote-images`
9. `npm run import:workspace`
10. In separate terminals: `npm run dev` and `npm run worker`.
11. From `../neptun-broshura-frontend`, run `npm ci` then `npm run dev`.

API: `http://localhost:3000`. Frontend: `http://localhost:5173`. Reference port 5171 is unchanged. Every importer accepts `--source=/absolute/reference/path` and is safe to rerun. Source reconciliation reports are in `docs/import-reports`.

Seed accounts are `pm@neptun-ks.com` (admin, PM review role), `staff@neptun-ks.com` and `staff2@neptun-ks.com` (editor, Staff review role). Their initial password is in your private backend `.env`, under `SEED_DEFAULT_PASSWORD`. The seed never resets an existing password. All users are flagged to change the initial password. The old PM account retains its review behavior and additionally gains administrative permissions.

The API uses httpOnly session cookies, organization-scoped repositories and tenant-prefixed object keys. Product images, uploads, saved artwork, fonts and generated media are stored outside the frontend. Development objects and backups default to `~/.local/share/neptun-broshura/objects` and `~/.local/share/neptun-broshura/backups`; `LOCAL_STORAGE_DIR` and `BACKUP_DIR` can override these backend-only paths. Production requires private R2 storage. See [storage architecture](docs/STORAGE_ARCHITECTURE.md). The standard sign-in logo and eight reference brochure fonts have dedicated public routes; document and product asset routes require authentication. Immutable private images use a private browser cache with `Vary: Cookie`, separating cached responses between sessions and preventing shared caches from bypassing tenant authorization.

Keep `OPENAI_API_KEY` empty until you want to test paid AI. Automated tests use mocks and do not call OpenAI. Exact defaults: `gpt-4o-mini`, `gpt-image-2.5-sunburst`, high-quality PNG, one output. AI commands return a completed saved result or HTTP 202 plus a job identifier; read paths never call AI. Interrupted provider responses become `uncertain`, requiring explicit review/regeneration instead of an automatic second billable request. Technical HTTP retries are capped at three attempts and honor Retry-After. Individual text fields are also reused across reordered and overlapping batches, including checks that found no correction. See [automatic AI reuse](docs/AI_REUSE.md).

## Validation

`npm run typecheck`, `npm test`, `npm run build`, `npm run lint`.

Tests require a `TEST_DATABASE_URL` ending in `_test`. The runner creates that isolated database, applies migrations, and uses disposable tenant fixtures. It refuses to use the application database. Worker image variants are generated once and registered in PostgreSQL.

The brochure sync passes 51 backend tests, including complete layout persistence, recursive bundle wallpapers, four undo/redo restores and delivery of all eight original fonts. See [brochure fixes and remaining integration work](docs/BROCHURE_FIXES.md).

Local `QUEUE_POLL_SECONDS=1` is useful while importing. The example production-oriented default is 10 seconds. A continuously running Postgres queue prevents Neon from fully sleeping; reduce operating hours or stop the worker when idle if autosuspend is important. The current deployment design uses one worker; configured provider concurrency is enforced within that worker. Text concurrency defaults to two and is limited to four with the current connection pool. Set `DIRECT_DATABASE_URL` to the matching unpooled Neon URL for the worker, migration and backup tools. The API may use the pooled `DATABASE_URL`; localhost already provides a direct connection.

See [R2 setup](docs/R2_SETUP.md), [backup and restore](docs/RESTORE.md), [deployment preparation](docs/DEPLOYMENT.md), and [migration status](docs/MIGRATION_STATUS.md). No deployment command is included in the local workflow.

Import/font/source checksum verification: `npm run verify:imports`. Local isolated restore verification: `npm run verify:restore -- --backup=<directory>`. Both scripts are read-only toward the reference project and working database.
