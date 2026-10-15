import "reflect-metadata";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
import { DocumentAssets } from "../src/modules/assets/document-assets";
import { EmailService } from "../src/modules/email/email.service";
import { NotificationsRepository } from "../src/modules/notifications/notifications.repository";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import {
  campaignSchema,
  postSchema,
} from "../src/modules/documents/domain/document";
import { jsonObject } from "../src/shared/json";
import type { Actor } from "../src/modules/auth/domain/actor";
import { ingestAsset } from "../src/modules/assets/asset-ingest";
const source = resolve(
  process.argv.find((x) => x.startsWith("--source="))?.slice(9) ??
    "../neptun-campaign-studio",
);
async function main(): Promise<void> {
  const db = new Database();
  const storage =
    env.STORAGE_DRIVER === "local"
      ? new LocalStorage(env.LOCAL_STORAGE_DIR)
      : new R2Storage();
  try {
    const member = (
      await db.query<{
        organization_id: string;
        user_id: string;
        email: string;
        role: Actor["role"];
        review_role: Actor["reviewRole"];
        account_role: NonNullable<Actor["accountRole"]>;
      }>(
        "SELECT m.organization_id,m.user_id,u.email,m.role,m.review_role,m.account_role FROM memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id WHERE o.slug='neptun' AND m.status='active' AND m.role IN ('editor','admin') ORDER BY CASE WHEN m.review_role='staff' THEN 0 WHEN m.account_role='admin' THEN 1 ELSE 2 END,u.email LIMIT 1",
      )
    )[0];
    if (!member)
      throw new Error(
        "Create an active Neptun administrator or editor before importing the workspace.",
      );
    const actor: Actor = {
      organizationId: member.organization_id,
      userId: member.user_id,
      email: member.email,
      role: member.role,
      reviewRole: member.review_role,
      accountRole: member.account_role,
      mustChangePassword: true,
    };
    const assets = new DocumentAssets(db, storage);
    const documents = new DocumentsRepository(
      db,
      assets,
      new NotificationsRepository(db, new EmailService(db)),
    );
    const embeddedHashes = new Set<string>();
    const collectImages = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectImages);
        return;
      }
      if (value && typeof value === "object") {
        Object.values(value).forEach(collectImages);
        return;
      }
      if (typeof value === "string" && /^data:image\/[^;]+;base64,/.test(value))
        embeddedHashes.add(
          createHash("sha256")
            .update(Buffer.from(value.slice(value.indexOf(",") + 1), "base64"))
            .digest("hex"),
        );
    };
    const report = {
      campaigns: 0,
      posts: 0,
      embeddedImages: 0,
      versionsRetained: true,
      files: [] as string[],
    };
    for (const [file, kind, schema] of [
      ["team-campaigns.json", "campaign", campaignSchema],
      ["team-posts.json", "post", postSchema],
    ] as const) {
      const bytes = await readFile(
        resolve(source, "data/team-workspace", file),
      );
      const values = z
        .array(schema)
        .parse(JSON.parse(bytes.toString()) as unknown);
      collectImages(values);
      for (const value of values) {
        await documents.save(actor, kind, value, true);
        if (kind === "campaign") report.campaigns++;
        else report.posts++;
      }
      const sha = createHash("sha256").update(bytes).digest("hex");
      await db.query(
        "INSERT INTO import_sources(organization_id,source_key,sha256,report) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [actor.organizationId, file, sha, { count: values.length }],
      );
      report.files.push(file);
    }
    try {
      const settings = jsonObject.parse(
        JSON.parse(
          await readFile(
            resolve(source, "data/team-workspace/team-settings.json"),
            "utf8",
          ),
        ) as unknown,
      );
      const normalized = await assets.externalize(
        actor.organizationId,
        settings,
        actor.userId,
      );
      await db.query(
        "INSERT INTO settings(organization_id,value) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [actor.organizationId, normalized],
      );
      report.files.push("team-settings.json");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    // Preserve already prepared cutout and brand caches without making an AI call.
    const { readdir } = await import("node:fs/promises");
    for (const folder of ["cutout-cache", "brand-prepared/cache"]) {
      const path = resolve(
        source,
        "public/assets",
        folder === "cutout-cache" ? "ai-cutouts/cache" : folder,
      );
      let files: string[];
      try {
        files = await readdir(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      for (const file of files.filter((x) => x.endsWith(".png"))) {
        const asset = await ingestAsset(
          db,
          storage,
          actor.organizationId,
          await readFile(resolve(path, file)),
          "image/png",
          { kind: folder === "cutout-cache" ? "cutout" : "brand-prep" },
        );
        await db.query(
          "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [
            actor.organizationId,
            `/api/${folder === "cutout-cache" ? "ai-cutouts" : "brand-logos"}/${file}`,
            asset.id,
          ],
        );
        await db.query(
          "INSERT INTO ai_results(organization_id,operation,cache_key,model,quality,params_json,prompt_version,output_asset_id,status,created_by,completed_at) VALUES($1,$2,$3,$4,'high',$5,'legacy-file-cache-v1',$6,'completed',$7,now()) ON CONFLICT(organization_id,cache_key) DO NOTHING",
          [
            actor.organizationId,
            folder === "cutout-cache" ? "cutout" : "brand_prep",
            `legacy:${folder}:${file}`,
            env.OPENAI_IMAGE_MODEL,
            { legacyFilename: file, inputMetadataAvailable: false },
            asset.id,
            actor.userId,
          ],
        );
      }
    }
    const brandIndex = jsonObject.parse(
      JSON.parse(
        await readFile(
          resolve(source, "public/assets/brand-prepared/cache/index.json"),
          "utf8",
        ),
      ) as unknown,
    );
    for (const [brand, url] of Object.entries(brandIndex)) {
      if (typeof url !== "string") continue;
      const filename = url.split("/").at(-1);
      if (!filename) continue;
      await db.query(
        "INSERT INTO brand_assets(organization_id,brand,asset_id,version) SELECT organization_id,$2,asset_id,1 FROM asset_aliases WHERE organization_id=$1 AND source_path=$3 ON CONFLICT DO NOTHING",
        [
          actor.organizationId,
          brand,
          `/assets/brand-prepared/cache/${filename}`,
        ],
      );
    }
    // Canonicalize newly reconciled local/remote URLs in saved layouts; keep immutable previous snapshots.
    for (const kind of ["campaign", "post"] as const) {
      for (const document of await documents.list(actor.organizationId, kind)) {
        const normalized = await assets.externalize(
          actor.organizationId,
          document,
          actor.userId,
        );
        if (JSON.stringify(normalized) === JSON.stringify(document)) continue;
        const version = (document.version ?? 1) + 1;
        normalized.version = version;
        const table = kind === "campaign" ? "campaigns" : "social_posts";
        await db.transaction(async (client) => {
          const updated = await client.query(
            `UPDATE ${table} SET layout=$3,version=$4 WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING id`,
            [
              actor.organizationId,
              document.id,
              normalized,
              version,
              document.version,
            ],
          );
          if (updated.rows.length)
            await client.query(
              "INSERT INTO document_versions(organization_id,kind,document_id,version,snapshot) VALUES($1,$2,$3,$4,$5)",
              [actor.organizationId, kind, document.id, version, normalized],
            );
        });
      }
    }
    for (const campaign of await documents.list(
      actor.organizationId,
      "campaign",
    ))
      await documents.rebuildProjections(actor.organizationId, campaign.id);
    report.embeddedImages = embeddedHashes.size;
    await mkdir("docs/import-reports", { recursive: true });
    await writeFile(
      "docs/import-reports/workspace-import.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Workspace import failed.",
  );
  process.exitCode = 1;
});
