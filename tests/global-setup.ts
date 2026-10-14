import "./setup-env";
import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
export default async function setup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Test connection is missing.");
  const url = new URL(connectionString);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name))
    throw new Error("Unsafe test database name.");
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    if (
      !(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
        .rows.length
    )
      await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz DEFAULT now())",
    );
    for (const file of (await readdir("drizzle"))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(join("drizzle", file), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const prior = (
        await db.query<{ sha256: string }>(
          "SELECT sha256 FROM schema_migrations WHERE name=$1",
          [file],
        )
      ).rows[0];
      if (prior) {
        if (prior.sha256 !== hash)
          throw new Error("Applied test migration changed.");
        continue;
      }
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query(
          "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)",
          [file, hash],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }
    // Authentication throttles are durable; each isolated test run starts its own clean limits.
    await db.query("DELETE FROM identity_rate_limits");
  } finally {
    await db.end();
  }
}
