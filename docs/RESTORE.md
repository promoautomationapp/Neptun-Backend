# Backups and restoration

Back up PostgreSQL together with all referenced immutable storage objects. A database-only backup cannot restore product photos, uploaded design files, fonts or generated assets. Originals and previous document versions are retained; export retention applies only to disposable export output.

`npm run backup` creates a private timestamped directory under `BACKUP_DIR` (default `~/.local/share/neptun-broshura/backups`, outside the checkout), containing a PostgreSQL custom-format dump, an asset manifest and a checksum-verified object copy. It exports one repeatable-read database snapshot and passes it to pg_dump so the asset manifest and database describe the same state. Requires local `pg_dump` on PATH. The script reads database credentials from `.env` and does not print them.

Restore into a new empty database first; do not overwrite the working database during a verification exercise:

1. Create a new database with pgAdmin or `createdb <new-empty-db-name>`.
2. Run `pg_restore --no-owner --no-acl --dbname=<new-empty-db-name> <backup-directory>/database.dump` with matching PostgreSQL connection environment variables.
3. Copy the backup `objects` directory to a new storage directory; set `LOCAL_STORAGE_DIR` to that directory and `DATABASE_URL` to the restored database.
4. Verify manifest SHA-256 values, product/asset/document counts, three-user sign-in, saved layout geometry, private asset denial for another organization, and representative export output.
5. Resume API/worker only after this check. Stale `running` AI jobs and pending proofreading claims are treated as uncertain and must not blindly repeat a possibly billable provider request. Keep the `ai_proofread_checks` table with the result/job tables so successful no-correction checks survive restoration.

Do not commit dumps, backups, object copies or `.env`. Backups contain private data and password hashes; store them encrypted on a separately controlled volume/account. Test restoration regularly. Local full-schema restoration and checksums for all 15,779 immutable objects passed on 6 October 2026; see restore-verification.json. Run `npm run verify:restore -- --backup=<directory>` to reproduce the isolated exercise. UI/export recovery acceptance is still pending.

For production, use Neon point-in-time restoration/branches according to the project's actual retention plan, with storage manifests/backups aligned to the restored database time. R2 object keys are immutable and old AI/document asset versions remain available. Deletion of referenced originals or historical objects is prohibited by the retention design. Record the application/render revision alongside backups.

Reference: [Neon restore documentation](https://neon.com/docs/manage/projects#restore-a-project).
