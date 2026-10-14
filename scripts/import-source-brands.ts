import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Database } from "../src/database/database";
import { siteUrl } from "../src/modules/catalog/neptun-source";

async function main() {
  const source = resolve(
    process.argv.find((value) => value.startsWith("--source="))?.slice(9) ??
      "../neptun-campaign-studio",
  );
  const data = z
    .object({
      brands: z.array(
        z.object({
          id: z.number().int().positive(),
          name: z.string().min(1),
          sourceImageUrl: z.string(),
          image: z.string().default(""),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          resolve(source, "data/team-workspace/catalog-brands.json"),
          "utf8",
        ),
      ) as unknown,
    );
  const db = new Database();
  try {
    const organization = (
      await db.query<{ id: string }>(
        "SELECT id FROM organizations WHERE slug='neptun'",
      )
    )[0];
    if (!organization)
      throw new Error(
        "Create the Neptun organization before importing brands.",
      );
    const aliases = await db.query<{ source_path: string; asset_id: string }>(
      "SELECT source_path,asset_id FROM asset_aliases WHERE organization_id=$1 AND source_path=ANY($2::text[])",
      [organization.id, data.brands.map((brand) => brand.image)],
    );
    const assets = new Map(
      aliases.map((alias) => [alias.source_path, alias.asset_id]),
    );
    let mapped = 0;
    await db.transaction(async (client) => {
      for (const brand of data.brands) {
        const image = assets.get(brand.image) ?? null;
        await client.query(
          "INSERT INTO catalog_source_brands(organization_id,source_id,name,source_url,asset_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,source_id) DO NOTHING",
          [
            organization.id,
            brand.id,
            brand.name,
            brand.sourceImageUrl ? siteUrl(brand.sourceImageUrl) : "",
            image,
          ],
        );
        if (image) mapped++;
      }
    });
    console.log(
      JSON.stringify({
        importedBrands: data.brands.length,
        reusedBrandImages: mapped,
      }),
    );
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Brand import failed.",
  );
  process.exitCode = 1;
});
