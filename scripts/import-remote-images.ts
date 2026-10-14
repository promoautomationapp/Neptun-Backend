import "reflect-metadata";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
import { ingestAsset } from "../src/modules/assets/asset-ingest";
const source = resolve(
  process.argv.find((x) => x.startsWith("--source="))?.slice(9) ??
    "../neptun-campaign-studio",
);
const productSchema = z.object({
  code: z.string(),
  imageUrl: z.string().default(""),
  localImage: z.string().default(""),
  images: z.array(z.string()).default([]),
});
const allowed = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.neptun-ks.com")
    throw new Error("Only original Neptun image URLs are permitted.");
  return url;
};
async function download(url: string): Promise<Buffer> {
  const response = await fetch(allowed(url), {
    signal: AbortSignal.timeout(25_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 14_000_000)
    throw new Error("Remote image exceeds import limit.");
  if (!response.body) throw new Error("Empty image response.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 14_000_000)
        throw new Error("Remote image exceeds import limit.");
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
async function main(): Promise<void> {
  const db = new Database();
  const storage =
    env.STORAGE_DRIVER === "local"
      ? new LocalStorage(env.LOCAL_STORAGE_DIR)
      : new R2Storage();
  const report = {
    mappedAliases: 0,
    downloaded: 0,
    unavailable: [] as { code: string; url: string; reason: string }[],
  };
  try {
    const org = (
      await db.query<{ id: string }>(
        "SELECT id FROM organizations WHERE slug='neptun'",
      )
    )[0]?.id;
    if (!org) throw new Error("Run db:seed first.");
    const products = z
      .object({ products: z.array(productSchema) })
      .parse(
        JSON.parse(
          await readFile(resolve(source, "public/catalog.json"), "utf8"),
        ) as unknown,
      ).products;
    const aliases = await db.query<{ source_path: string; asset_id: string }>(
      "SELECT source_path,asset_id FROM asset_aliases WHERE organization_id=$1",
      [org],
    );
    const byPath = new Map(aliases.map((x) => [x.source_path, x.asset_id]));
    for (const product of products) {
      const local = byPath.get(decodeURIComponent(product.localImage));
      const files = aliases.filter((x) =>
        x.source_path.startsWith(`/catalog-images/${product.code}/`),
      );
      for (const url of product.images) {
        const fingerprint = createHash("md5")
          .update(url)
          .digest("hex")
          .slice(0, 10);
        const matching = files.find((x) =>
          x.source_path.split("/").at(-1)?.includes(`_${fingerprint}.`),
        );
        if (!matching) continue;
        await db.query(
          "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO UPDATE SET asset_id=EXCLUDED.asset_id",
          [org, url, matching.asset_id],
        );
        report.mappedAliases++;
        await db.query(
          "UPDATE product_images pi SET source_url=$3 FROM products p WHERE pi.organization_id=$1 AND p.organization_id=pi.organization_id AND p.id=pi.product_id AND p.code=$2 AND pi.asset_id=$4",
          [org, product.code, url, matching.asset_id],
        );
      }
      if (local && product.imageUrl) {
        await db.query(
          "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [org, product.imageUrl, local],
        );
        continue;
      }
      if (!product.imageUrl) continue;
      const existing = (
        await db.query<{ asset_id: string }>(
          "SELECT asset_id FROM asset_aliases WHERE organization_id=$1 AND source_path=$2",
          [org, product.imageUrl],
        )
      )[0];
      let assetId = existing?.asset_id;
      if (!assetId) {
        try {
          const bytes = await download(product.imageUrl);
          const metadata = await sharp(bytes, {
            limitInputPixels: 67_000_000,
          }).metadata();
          const mime =
            metadata.format === "svg"
              ? "image/svg+xml"
              : `image/${metadata.format}`;
          const asset = await ingestAsset(db, storage, org, bytes, mime, {
            metadata: { importedFrom: product.imageUrl },
          });
          assetId = asset.id;
          await db.query(
            "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [org, product.imageUrl, assetId],
          );
          report.downloaded++;
        } catch (error) {
          report.unavailable.push({
            code: product.code,
            url: product.imageUrl,
            reason: error instanceof Error ? error.message : "Download failed.",
          });
          continue;
        }
      }
      await db.query(
        "UPDATE products SET primary_asset_id=$3 WHERE organization_id=$1 AND code=$2 AND primary_asset_id IS NULL",
        [org, product.code, assetId],
      );
      await db.query(
        "INSERT INTO product_images(organization_id,product_id,asset_id,position,source_url) SELECT organization_id,id,$3,0,$4 FROM products WHERE organization_id=$1 AND code=$2 ON CONFLICT DO NOTHING",
        [org, product.code, assetId, product.imageUrl],
      );
    }
    await mkdir("docs/import-reports", { recursive: true });
    await writeFile(
      "docs/import-reports/remote-images.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        { ...report, unavailable: report.unavailable.length },
        null,
        2,
      ),
    );
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Remote import failed.",
  );
  process.exitCode = 1;
});
