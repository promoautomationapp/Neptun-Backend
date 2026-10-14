import { directConnection } from "../src/database/direct-connection";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Database } from "../src/database/database";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
import { env } from "../src/config/environment";
const exec = promisify(execFile);
async function main(): Promise<void> {
  const connectionString = directConnection(
    env.DATABASE_URL,
    env.DIRECT_DATABASE_URL,
  );
  const db = new Database(connectionString);
  const client = await db.pool.connect();
  const directory = resolve(
    env.BACKUP_DIR,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storage =
    env.STORAGE_DRIVER === "local"
      ? new LocalStorage(env.LOCAL_STORAGE_DIR)
      : new R2Storage();
  const backup = new LocalStorage(resolve(directory, "objects"));
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const snapshot = (
      await client.query<{ snapshot: string }>(
        "SELECT pg_export_snapshot() snapshot",
      )
    ).rows[0]?.snapshot;
    if (!snapshot) throw new Error("Database snapshot unavailable.");
    const assets = (
      await client.query<{
        id: string;
        organization_id: string;
        storage_key: string;
        sha256: string;
        size: string;
        mime_type: string;
      }>(
        "SELECT id,organization_id,storage_key,sha256,size,mime_type FROM assets ORDER BY storage_key",
      )
    ).rows;
    const url = new URL(connectionString);
    const databaseEnv = {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      ...(url.searchParams.has("sslmode")
        ? { PGSSLMODE: url.searchParams.get("sslmode") ?? "require" }
        : {}),
    };
    await exec(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        `--snapshot=${snapshot}`,
        `--file=${resolve(directory, "database.dump")}`,
      ],
      { env: databaseEnv },
    );
    for (const asset of assets) {
      const bytes = await storage.read(asset.storage_key);
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
        throw new Error("An asset failed checksum verification.");
      await backup.put(asset.storage_key, bytes, asset.mime_type);
    }
    await writeFile(
      resolve(directory, "manifest.json"),
      JSON.stringify(
        { schemaVersion: 1, createdAt: new Date().toISOString(), assets },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await client.query("COMMIT");
    console.log(
      `Backup saved: ${directory} (${assets.length} verified assets)`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await db.onModuleDestroy();
  }
}
void main().catch(() => {
  console.error(
    "Backup failed. Check PostgreSQL tools, connection and storage access. An incomplete backup must not be used for restore.",
  );
  process.exitCode = 1;
});
