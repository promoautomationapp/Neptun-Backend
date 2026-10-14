import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { directConnection } from "../src/database/direct-connection";
import { Client } from "pg";
import { env } from "../src/config/environment";

async function main(): Promise<void> {
  const client = new Client({
    connectionString: directConnection(
      env.DATABASE_URL,
      env.DIRECT_DATABASE_URL,
    ),
  });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('neptun_schema_migration'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(resolve("drizzle")))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(resolve("drizzle", name), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const found = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (found.rows[0]) {
        if (found.rows[0].sha256 !== hash)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)",
          [name, hash],
        );
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Operation failed");
  process.exitCode = 1;
});
