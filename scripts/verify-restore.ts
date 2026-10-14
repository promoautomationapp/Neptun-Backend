import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { z } from "zod";
import { env } from "../src/config/environment";
import { LocalStorage } from "../src/modules/storage/local.storage";
const exec = promisify(execFile);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  assets: z.array(
    z.object({
      id: z.uuid(),
      organization_id: z.uuid(),
      storage_key: z.string(),
      sha256: z.string(),
      size: z.string(),
      mime_type: z.string(),
    }),
  ),
});
async function main(): Promise<void> {
  const argument = process.argv
    .find((x) => x.startsWith("--backup="))
    ?.slice(9);
  if (!argument) throw new Error("Pass --backup=<backup directory>.");
  const directory = resolve(argument);
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(resolve(directory, "manifest.json"), "utf8"),
    ) as unknown,
  );
  const url = new URL(env.DATABASE_URL);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname))
    throw new Error(
      "Restore verification may only create a temporary local database.",
    );
  const databaseName = `neptun_restore_${randomUUID().replaceAll("-", "")}_test`;
  url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  let restored: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    restored = new Pool({ connectionString: url.toString(), max: 2 });
    const pgEnv = {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: databaseName,
    };
    await exec(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        `--dbname=${databaseName}`,
        resolve(directory, "database.dump"),
      ],
      { env: pgEnv, maxBuffer: 4 * 1024 * 1024 },
    );
    const assets = (
      await restored.query<{
        id: string;
        storage_key: string;
        sha256: string;
        size: string;
      }>("SELECT id,storage_key,sha256,size FROM assets ORDER BY storage_key")
    ).rows;
    if (assets.length !== manifest.assets.length)
      throw new Error("Restored asset count differs from the manifest.");
    const byId = new Map(assets.map((x) => [x.id, x]));
    const storage = new LocalStorage(resolve(directory, "objects"));
    for (let offset = 0; offset < manifest.assets.length; offset += 16)
      await Promise.all(
        manifest.assets.slice(offset, offset + 16).map(async (asset) => {
          const row = byId.get(asset.id);
          if (
            !row ||
            row.storage_key !== asset.storage_key ||
            row.sha256 !== asset.sha256 ||
            row.size !== asset.size
          )
            throw new Error(
              "Restored asset metadata differs from the manifest.",
            );
          const bytes = await storage.read(asset.storage_key);
          if (
            bytes.length !== Number(asset.size) ||
            createHash("sha256").update(bytes).digest("hex") !== asset.sha256
          )
            throw new Error(
              "Restored object checksum differs from the manifest.",
            );
        }),
      );
    const tables = [
      "products",
      "product_images",
      "campaigns",
      "campaign_products",
      "brochures",
      "brochure_pages",
      "social_posts",
      "document_versions",
      "review_threads",
      "review_comments",
      "settings",
      "users",
      "memberships",
      "ai_results",
      "ai_jobs",
    ];
    if (
      (
        await restored.query<{ name: string | null }>(
          "SELECT to_regclass('public.ai_proofread_checks')::text name",
        )
      ).rows[0]?.name
    )
      tables.push("ai_proofread_checks");
    const counts: Record<string, number> = {};
    for (const table of tables)
      counts[table] = Number(
        (
          await restored.query<{ count: string }>(
            `SELECT count(*) count FROM ${table}`,
          )
        ).rows[0]?.count ?? 0,
      );
    const result = {
      verifiedAt: new Date().toISOString(),
      passed: true,
      backupCreatedAt: manifest.createdAt,
      verifiedObjects: assets.length,
      counts,
      temporaryDatabaseRemoved: true,
      scope:
        "Local pg_restore, full schema and immutable object checksums. Frontend/export disaster recovery acceptance remains pending.",
    };
    await restored.end();
    restored = undefined;
    await admin.query(`DROP DATABASE "${databaseName}"`);
    created = false;
    await writeFile(
      "docs/restore-verification.json",
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await restored?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Restore verification failed.",
  );
  process.exitCode = 1;
});
