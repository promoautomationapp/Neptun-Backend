import "reflect-metadata";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { z } from "zod";
import { Database } from "../src/database/database";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
import { env } from "../src/config/environment";
const auditSchema = z.object({
  reference_root: z.string(),
  source_files: z.array(
    z.object({ path: z.string(), sha256: z.string(), bytes: z.number() }),
  ),
});
async function main(): Promise<void> {
  const db = new Database();
  const storage =
    env.STORAGE_DRIVER === "local"
      ? new LocalStorage(env.LOCAL_STORAGE_DIR)
      : new R2Storage();
  try {
    const source = resolve(
      process.argv.find((x) => x.startsWith("--source="))?.slice(9) ??
        "../neptun-campaign-studio",
    );
    const audit = auditSchema.parse(
      JSON.parse(
        await readFile("../neptun-broshura-source-audit.json", "utf8"),
      ) as unknown,
    );
    const org = (
      await db.query<{ id: string }>(
        "SELECT id FROM organizations WHERE slug='neptun'",
      )
    )[0]?.id;
    if (!org) throw new Error("Neptun is not seeded.");
    const aliases = new Map(
      (
        await db.query<{ source_path: string; sha256: string }>(
          "SELECT x.source_path,a.sha256 FROM asset_aliases x JOIN assets a ON a.organization_id=x.organization_id AND a.id=x.asset_id WHERE x.organization_id=$1",
          [org],
        )
      ).map((x) => [x.source_path, x.sha256]),
    );
    const failures: string[] = [];
    let sourceFiles = 0;
    let mediaFiles = 0;
    let fonts = 0;
    for (let offset = 0; offset < audit.source_files.length; offset += 16)
      await Promise.all(
        audit.source_files.slice(offset, offset + 16).map(async (file) => {
          const path = resolve(source, file.path);
          const bytes = await readFile(path);
          sourceFiles++;
          if (
            bytes.length !== file.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== file.sha256
          )
            failures.push(`Reference changed: ${file.path}`);
          if (
            /^(?:public\/(?:assets|fonts|catalog-images)|images)\//.test(
              file.path,
            ) &&
            /\.(?:png|jpe?g|webp|gif|svg|otf|ttf)$/i.test(file.path)
          ) {
            const alias = file.path.startsWith("public/")
              ? "/" + relative(resolve(source, "public"), path)
              : "/" + file.path;
            mediaFiles++;
            if (/\.(?:otf|ttf)$/i.test(file.path)) fonts++;
            if (aliases.get(alias) !== file.sha256)
              failures.push(`Import mismatch: ${file.path}`);
          }
        }),
      );
    const assets = await db.query<{ storage_key: string; sha256: string }>(
      "SELECT storage_key,sha256 FROM assets WHERE organization_id=$1",
      [org],
    );
    for (let offset = 0; offset < assets.length; offset += 16)
      await Promise.all(
        assets.slice(offset, offset + 16).map(async (asset) => {
          if (
            createHash("sha256")
              .update(await storage.read(asset.storage_key))
              .digest("hex") !== asset.sha256
          )
            failures.push(`Storage checksum mismatch: ${asset.storage_key}`);
        }),
      );
    const [counts] = await db.query<{
      products: string;
      primary_images: string;
      campaigns: string;
      posts: string;
      users: string;
    }>(
      `SELECT
   (SELECT count(*) FROM products WHERE organization_id=$1) products,
   (SELECT count(*) FROM products WHERE organization_id=$1 AND primary_asset_id IS NOT NULL) primary_images,
   (SELECT count(*) FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL) campaigns,
   (SELECT count(*) FROM social_posts WHERE organization_id=$1 AND deleted_at IS NULL) posts,
   (SELECT count(*) FROM memberships WHERE organization_id=$1) users`,
      [org],
    );
    const missing = await db.query<{ code: string; name: string }>(
      "SELECT code,name FROM products WHERE organization_id=$1 AND primary_asset_id IS NULL ORDER BY code",
      [org],
    );
    const baseline = z
      .object({
        products: z.array(z.object({ code: z.string(), name: z.string() })),
      })
      .parse(
        JSON.parse(
          await readFile(resolve(source, "public/catalog.json"), "utf8"),
        ) as unknown,
      );
    const actual = await db.query<{ code: string; name: string }>(
      "SELECT code,name FROM products WHERE organization_id=$1",
      [org],
    );
    const names = new Map(actual.map((x) => [x.code, x.name]));
    for (const product of baseline.products)
      if (names.get(product.code) !== product.name)
        failures.push(`Product mismatch: ${product.code}`);
    const result = {
      verifiedAt: new Date().toISOString(),
      passed: failures.length === 0,
      referenceFilesUnchanged: sourceFiles,
      importedSourceMedia: mediaFiles,
      identicalFonts: fonts,
      verifiedStorageObjects: assets.length,
      counts,
      missingPrimaryImages: missing,
      failures,
    };
    await writeFile(
      "docs/import-reports/verification.json",
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        { ...result, missingPrimaryImages: missing.length },
        null,
        2,
      ),
    );
    if (failures.length) process.exitCode = 1;
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Import verification failed.",
  );
  process.exitCode = 1;
});
