import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import sharp from "sharp";
import { z } from "zod";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
import { ingestAsset } from "../src/modules/assets/asset-ingest";
import { jsonObject } from "../src/shared/json";

const source = resolve(
  process.argv.find((x) => x.startsWith("--source="))?.slice(9) ??
    "../neptun-campaign-studio",
);
const dryRun = process.argv.includes("--dry-run");
const types: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? files(resolve(path, entry.name))
        : Promise.resolve([resolve(path, entry.name)]),
    ),
  );
  return groups.flat();
}
async function main(): Promise<void> {
  const db = new Database();
  const storage =
    env.STORAGE_DRIVER === "local"
      ? new LocalStorage(env.LOCAL_STORAGE_DIR)
      : new R2Storage();
  try {
    const organization = (
      await db.query<{ id: string }>(
        "SELECT id FROM organizations WHERE slug='neptun'",
      )
    )[0];
    if (!organization) throw new Error("Run db:seed first.");
    const csv = await readFile(
      resolve(source, "data/neptun_products.csv"),
      "utf8",
    );
    const rows = z.array(z.record(z.string(), z.string())).parse(
      parse(csv, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        relax_quotes: true,
      }),
    );
    // Current browser snapshot preserves the reference's established field conversion and duplicate ordering.
    const baseline = z
      .object({ products: z.array(jsonObject) })
      .parse(
        JSON.parse(
          await readFile(resolve(source, "public/catalog.json"), "utf8"),
        ) as unknown,
      );
    const rawByCode = new Map(
      rows.map((row) => [String(row.code ?? "").trim(), row]),
    );
    const paths = (
      await Promise.all(
        [
          "public/catalog-images",
          "images",
          "public/assets",
          "public/fonts",
        ].map((path) => files(resolve(source, path))),
      )
    )
      .flat()
      .filter((path) => types[extname(path).toLowerCase()]);
    const report = {
      dryRun,
      csvRows: rows.length,
      products: baseline.products.length,
      sourceFiles: paths.length,
      uniqueAssets: 0,
      errorProducts: [] as string[],
      missingImages: [] as string[],
      sourceBytes: 0,
      importedProducts: 0,
      mimeCorrections: [] as {
        path: string;
        declared: string;
        detected: string;
      }[],
      sanitizedSvgAssets: [] as string[],
    };
    const hashes = new Set<string>();
    const aliases = new Map<string, string>();
    for (const [index, path] of paths.entries()) {
      const bytes = await readFile(path);
      const sha = createHash("sha256").update(bytes).digest("hex");
      hashes.add(sha);
      report.sourceBytes += bytes.length;
      const sourcePath =
        "/" + relative(resolve(source, "public"), path).replaceAll("\\", "/");
      const alias = path.startsWith(resolve(source, "public") + "/")
        ? sourcePath
        : "/" + relative(source, path).replaceAll("\\", "/");
      if (dryRun) aliases.set(alias, sha);
      if (!dryRun) {
        let mime = types[extname(path).toLowerCase()];
        if (!mime) continue;
        if (mime.startsWith("image/")) {
          const details = await sharp(bytes, {
            limitInputPixels: 67_000_000,
          }).metadata();
          const detected =
            details.format === "svg"
              ? "image/svg+xml"
              : `image/${details.format}`;
          if (detected !== mime) {
            report.mimeCorrections.push({
              path: relative(source, path),
              declared: mime,
              detected,
            });
            mime = detected;
          }
        }
        const asset = await ingestAsset(
          db,
          storage,
          organization.id,
          bytes,
          mime,
          {
            metadata: { importedFrom: relative(source, path) },
            kind:
              alias.startsWith("/assets/") || alias.startsWith("/fonts/")
                ? "design"
                : "original",
          },
        );
        const copied = await storage.read(asset.storage_key);
        const copiedHash = createHash("sha256").update(copied).digest("hex");
        if (
          copiedHash !== asset.sha256 ||
          (mime !== "image/svg+xml" && copiedHash !== sha)
        )
          throw new Error(`Checksum mismatch for ${relative(source, path)}`);
        if (mime === "image/svg+xml" && copiedHash !== sha)
          report.sanitizedSvgAssets.push(relative(source, path));
        await db.query(
          "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO NOTHING",
          [organization.id, alias, asset.id],
        );
        aliases.set(alias, asset.id);
      }
      if ((index + 1) % 1000 === 0)
        console.log(
          `${dryRun ? "Verified" : "Imported"} ${index + 1}/${paths.length} source assets`,
        );
    }
    report.uniqueAssets = hashes.size;
    for (const product of baseline.products) {
      const code = z.string().parse(product.code);
      const name = z.string().parse(product.name);
      if (name === "Error") report.errorProducts.push(code);
      const primary =
        typeof product.localImage === "string"
          ? aliases.get(decodeURIComponent(product.localImage))
          : undefined;
      if (!primary) report.missingImages.push(code);
      if (dryRun) continue;
      const specs = jsonObject.parse(product.specs ?? {});
      const raw = rawByCode.get(code) ?? {};
      const model = Object.entries(specs).find(([key]) =>
        /model/i.test(key),
      )?.[1];
      const text = (key: string) =>
        typeof product[key] === "string" ? product[key] : "";
      await db.transaction(async (client) => {
        const result = await client.query<{ id: string }>(
          "INSERT INTO products(organization_id,code,name,brand,model,category,subcategory,category_path,description,warranty,regular,currency,specs,availability,product_url,source,primary_asset_id,source_missing,source_missing_since) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,CASE WHEN $18 THEN now() ELSE NULL END) ON CONFLICT(organization_id,code) DO UPDATE SET code=EXCLUDED.code RETURNING id",
          [
            organization.id,
            code,
            name,
            text("brand"),
            typeof model === "string" ? model : "",
            text("category"),
            text("subcategory"),
            text("categoryPath"),
            text("description"),
            text("warranty"),
            typeof product.regular === "number" ? product.regular : null,
            text("currency") || "EUR",
            specs,
            text("availability"),
            text("url"),
            raw,
            primary ?? null,
            product.sourceMissing === true,
          ],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("Product import failed.");
        const prefix = `/catalog-images/${code}/`;
        const matches = [...aliases]
          .filter(([alias]) => alias.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b));
        for (const [position, [, assetId]] of matches.entries())
          await client.query(
            "INSERT INTO product_images(organization_id,product_id,asset_id,position) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [organization.id, id, assetId, position],
          );
      });
      report.importedProducts++;
    }
    const sourceHash = createHash("sha256").update(csv).digest("hex");
    if (!dryRun)
      await db.query(
        "INSERT INTO import_sources(organization_id,source_key,sha256,report) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [organization.id, "catalog-v1", sourceHash, report],
      );
    await mkdir("docs/import-reports", { recursive: true });
    await writeFile(
      `docs/import-reports/catalog-${dryRun ? "dry-run" : "import"}.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        {
          ...report,
          errorProducts: report.errorProducts.length,
          missingImages: report.missingImages.length,
          mimeCorrections: report.mimeCorrections.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Import failed.");
  process.exitCode = 1;
});
