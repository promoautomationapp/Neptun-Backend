import { createHash } from "node:crypto";
import type { Database } from "../../database/database";
import type { StoragePort } from "../storage/storage.port";
import { ingestAsset } from "../assets/asset-ingest";
import { downloadPublic } from "../../shared/public-download";
import { CatalogBrandsRepository } from "./catalog-brands";
import { CatalogRepository } from "./catalog.repository";
import {
  discoverCategories,
  normalizeProductCode,
  discoverBrands,
  embeddedModel,
  productModel,
  siteTransport,
  mapConcurrent,
  healthyFullCrawl,
  siteUrl,
  type SourceTransport,
  type SourceProduct,
  type CategoryListing,
  type SiteObject,
} from "./neptun-source";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function processCatalogRefresh(
  db: Database,
  payload: { organizationId: string; runId: string },
  transport: SourceTransport = siteTransport,
): Promise<void> {
  const { organizationId, runId } = payload;
  const repository = new CatalogRepository(db);
  const claimed = await db.query<{ id: string }>(
    "UPDATE catalog_sync_runs SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now(),phase='categories' WHERE organization_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING id",
    [organizationId, runId],
  );
  if (!claimed.length) return;
  const beat = setInterval(() => {
    void db
      .query("UPDATE catalog_sync_runs SET heartbeat_at=now() WHERE id=$1", [
        runId,
      ])
      .catch(() => {});
  }, 15_000);
  beat.unref();
  try {
    const homepage = await transport.get("https://www.neptun-ks.com/");
    const listings = discoverCategories(homepage);
    const sourceBrands = new CatalogBrandsRepository(db);
    for (const brand of discoverBrands(homepage))
      await sourceBrands.record(organizationId, brand);
    if (!listings.length)
      throw new Error(
        "Neptun returned an empty category menu. The existing catalog was kept.",
      );
    const categories = new Map<number, CategoryListing>();
    const collected = new Map<string, { model: SiteObject; path: string[] }>();
    let failedListings = 0;
    let listingsDone = 0;
    const listingErrors: string[] = [];
    await mapConcurrent(listings, 4, async (listing) => {
      try {
        let page = 1;
        let expected = 0;
        let read = 0;
        let pages = 1;
        const pageSignatures = new Set<string>();
        do {
          const url = new URL(listing.url);
          url.searchParams.set("items", "100");
          url.searchParams.set("page", String(page));
          const model = embeddedModel(
            await transport.get(url.href),
            "categorydetails",
          );
          const items = model.Products;
          if (!Array.isArray(items))
            throw new Error("Invalid category products.");
          expected = Number(model.NumberOfProducts) || 0;
          if (page === 1) {
            listing.id = Number(model.Id) || 0;
            listing.parentId = Number(model.ParentId) || 0;
            if (listing.id) categories.set(listing.id, listing);
          }
          const signature = items
            .map((item: SiteObject) => String(item.CodeNumber))
            .join("|");
          if (items.length && pageSignatures.has(signature))
            throw new Error(
              "Neptun repeated a listing page; catalog completeness cannot be confirmed.",
            );
          pageSignatures.add(signature);
          for (const item of items) {
            const code = normalizeProductCode(item.CodeNumber);
            if (!code)
              throw new Error("A listing product has no product code.");
            const previous = collected.get(code);
            if (!previous || listing.path.length > previous.path.length)
              collected.set(code, { model: item, path: listing.path });
          }
          read += items.length;
          pages = Math.max(1, Math.ceil(expected / (items.length || 100)));
          if (!items.length && read < expected)
            throw new Error(
              "Neptun listing ended before its stated product count.",
            );
          page++;
        } while (read < expected && page <= Math.min(pages + 1, 200));
        if (read < expected)
          throw new Error("Neptun category pagination was incomplete.");
      } catch (error) {
        failedListings++;
        listingErrors.push(
          `${listing.path.join(" > ")}: ${error instanceof Error ? error.message : "unavailable"}`,
        );
      }
      listingsDone++;
      await db.query(
        "UPDATE catalog_sync_runs SET processed=$2,total=$3,heartbeat_at=now() WHERE id=$1",
        [runId, listingsDone, listings.length],
      );
    });
    if (!collected.size)
      throw new Error(
        "No products were returned. The existing catalog was kept.",
      );
    for (const [id, listing] of categories)
      await db.query(
        "INSERT INTO catalog_source_categories(organization_id,source_id,parent_source_id,name,path,source_url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,source_id) DO UPDATE SET parent_source_id=EXCLUDED.parent_source_id,name=EXCLUDED.name,path=EXCLUDED.path,source_url=EXCLUDED.source_url,last_seen_at=now()",
        [
          organizationId,
          id,
          listing.parentId,
          listing.path.at(-1),
          listing.path.join(" > "),
          listing.url,
        ],
      );
    await db.query(
      "UPDATE catalog_sync_runs SET phase='products',processed=0,total=$2,hierarchy=$3,heartbeat_at=now() WHERE id=$1",
      [
        runId,
        collected.size,
        JSON.stringify(
          [...categories.values()].map((x) => ({
            id: x.id,
            parentId: x.parentId,
            path: x.path,
            name: x.path.at(-1),
            url: x.url,
          })),
        ),
      ],
    );
    const existing = await repository.existing(organizationId);
    const byCode = new Map(existing.map((x) => [x.code, x]));
    let processed = 0,
      added = 0,
      updated = 0,
      unchanged = 0,
      failedProducts = 0;
    await mapConcurrent([...collected], 4, async ([code, entry]) => {
      const current = byCode.get(code);
      const manufacturer = entry.model.Manufacturer;
      if (manufacturer?.Id && manufacturer.Name && manufacturer.Logo)
        await sourceBrands.record(organizationId, {
          id: Number(manufacturer.Id),
          name: String(manufacturer.Name),
          sourceImageUrl: siteUrl(manufacturer.Logo),
        });
      const category = categories.get(Number(entry.model.Category?.Id));
      const path = category?.path ?? entry.path;
      const fingerprint = hash({
        model: entry.model,
        path,
        hierarchyVersion: 2,
      });
      const previous = current?.source;
      const lastDetails =
        typeof previous?.detailCheckedAt === "string"
          ? Date.parse(previous.detailCheckedAt)
          : 0;
      // Listings are checked every run; unchanged details are refreshed weekly.
      if (
        current &&
        previous?.fingerprint === fingerprint &&
        Date.now() - lastDetails < 7 * 86_400_000
      ) {
        await db.query(
          "UPDATE products SET source_last_seen_at=now(),source_missing=false,source_missing_since=NULL WHERE organization_id=$1 AND id=$2",
          [organizationId, current.id],
        );
        unchanged++;
      } else {
        let product = productModel(entry.model, path, fingerprint);
        try {
          const model = embeddedModel(
            await transport.get(product.url),
            "productModel",
          );
          const detail = productModel(model, path, fingerprint);
          if (detail.code !== product.code)
            throw new Error(
              "The detail page belongs to a different product code.",
            );
          product = detail;
          product.detailCheckedAt = new Date().toISOString();
        } catch {
          failedProducts++;
          if (current) {
            const prior = previous as unknown as Partial<SourceProduct>;
            product = {
              ...product,
              description: prior.description ?? product.description,
              specs: prior.specs ?? product.specs,
              model: prior.model ?? product.model,
              warranty: product.warranty || prior.warranty || "",
            };
          }
        }
        const inserted = await repository.upsert(
          organizationId,
          product,
          runId,
        );
        if (inserted) added++;
        else updated++;
      }
      processed++;
      if (processed % 10 === 0 || processed === collected.size)
        await db.query(
          "UPDATE catalog_sync_runs SET processed=$2,added=$3,updated=$4,unchanged=$5,failed_products=$6,heartbeat_at=now() WHERE id=$1",
          [runId, processed, added, updated, unchanged, failedProducts],
        );
    });
    let missing = 0;
    const previousSite = existing.filter(
      (x) =>
        !!x.source.product_url ||
        !!x.source.url ||
        x.source.site === "neptun-ks.com",
    );
    const healthy = healthyFullCrawl(
      previousSite.length,
      collected.size,
      failedListings,
    );
    if (healthy) {
      const rows = await db.query<{ id: string }>(
        "UPDATE products SET source_missing=true,source_missing_since=COALESCE(source_missing_since,now()),updated_at=now() WHERE organization_id=$1 AND deleted_at IS NULL AND NOT(code=ANY($2::text[])) AND (product_url LIKE 'https://%neptun-ks.com/%') AND source_missing=false RETURNING id",
        [organizationId, [...collected.keys()]],
      );
      missing = rows.length;
    }
    const error = !healthy
      ? `Refresh was incomplete (${failedListings} category failures). Missing products were not marked. ${listingErrors.slice(0, 2).join("; ")}`
      : failedProducts
        ? `${failedProducts} product detail pages could not be loaded; existing details were kept where available.`
        : null;
    await db.query(
      "UPDATE catalog_sync_runs SET status=$2,phase='finished',processed=$3,added=$4,updated=$5,unchanged=$6,missing=$7,failed_products=$8,error=$9,completed_at=now(),heartbeat_at=now() WHERE id=$1",
      [
        runId,
        healthy ? "completed" : "failed",
        processed,
        added,
        updated,
        unchanged,
        missing,
        failedProducts,
        error,
      ],
    );
  } catch (error) {
    await db.query(
      "UPDATE catalog_sync_runs SET status='failed',phase='finished',error=$2,completed_at=now(),heartbeat_at=now() WHERE id=$1",
      [
        runId,
        error instanceof Error ? error.message : "Catalog refresh failed.",
      ],
    );
    throw error;
  } finally {
    clearInterval(beat);
  }
}
export async function processCatalogImages(
  db: Database,
  storage: StoragePort,
  payload: { organizationId: string; productId: string; imageUrls: string[] },
): Promise<void> {
  const { organizationId, productId } = payload;
  const latest = (
    await db.query<{ source: JsonObjectLike }>(
      "SELECT source FROM products WHERE organization_id=$1 AND id=$2",
      [organizationId, productId],
    )
  )[0];
  if (!latest) return;
  if (
    Array.isArray(latest.source.imageUrls) &&
    JSON.stringify(latest.source.imageUrls.map((url) => siteUrl(url))) !==
      JSON.stringify(payload.imageUrls.map(siteUrl))
  )
    return;
  const existing = await db.query<{ source_url: string; asset_id: string }>(
    "SELECT source_url,asset_id FROM product_images WHERE organization_id=$1 AND product_id=$2 ORDER BY position",
    [organizationId, productId],
  );
  const known = new Map(
    existing.filter((x) => x.source_url).map((x) => [x.source_url, x.asset_id]),
  );
  // Register pre-imported CSV image mappings without downloading them again.
  if (existing.length && !known.size) {
    const rows = await db.query<{ source: JsonObjectLike }>(
      "SELECT source FROM products WHERE organization_id=$1 AND id=$2",
      [organizationId, productId],
    );
    const urls = String(rows[0]?.source.all_image_urls ?? "")
      .split(" | ")
      .filter(Boolean);
    for (
      let index = 0;
      index < Math.min(urls.length, existing.length);
      index++
    ) {
      const sourceUrl = siteUrl(urls[index]);
      await db.query(
        "UPDATE product_images SET source_url=$4 WHERE organization_id=$1 AND product_id=$2 AND asset_id=$3",
        [organizationId, productId, existing[index]!.asset_id, sourceUrl],
      );
      known.set(sourceUrl, existing[index]!.asset_id);
    }
  }
  for (const [position, value] of payload.imageUrls.entries()) {
    const url = siteUrl(value);
    let assetId = known.get(url);
    if (!assetId) {
      const download = await downloadPublic(
        url,
        15_000_000,
        undefined,
        (source) => {
          if (!["www.neptun-ks.com", "neptun-ks.com"].includes(source.hostname))
            throw new Error("Catalog images must come from Neptun.");
        },
      );
      if (
        ![
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "image/avif",
        ].includes(download.mimeType)
      )
        throw new Error("Neptun did not return an image.");
      const asset = await ingestAsset(
        db,
        storage,
        organizationId,
        download.bytes,
        download.mimeType,
        { metadata: { sourceUrl: url, productId } },
      );
      assetId = asset.id;
      await db.query(
        "INSERT INTO product_images(organization_id,product_id,asset_id,position,source_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,product_id,asset_id) DO UPDATE SET source_url=EXCLUDED.source_url,position=EXCLUDED.position",
        [organizationId, productId, assetId, position, url],
      );
    }
    await db.query(
      "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO UPDATE SET asset_id=EXCLUDED.asset_id",
      [organizationId, url, assetId],
    );
    if (position === 0)
      await db.query(
        "UPDATE products SET primary_asset_id=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 AND (source->'imageUrls' IS NULL OR source->'imageUrls'=$4::jsonb)",
        [
          organizationId,
          productId,
          assetId,
          JSON.stringify(payload.imageUrls.map(siteUrl)),
        ],
      );
  }
}
type JsonObjectLike = Record<string, unknown>;
