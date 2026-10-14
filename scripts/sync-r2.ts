import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
import { syncAssets, type SyncAsset } from "./storage-sync";
async function main(): Promise<void> {
  const db = new Database();
  const local = new LocalStorage(env.LOCAL_STORAGE_DIR);
  const dryRun = process.argv.includes("--dry-run");
  try {
    if (
      !dryRun &&
      ![
        env.R2_ACCOUNT_ID,
        env.R2_ACCESS_KEY_ID,
        env.R2_SECRET_ACCESS_KEY,
        env.R2_BUCKET,
      ].every(Boolean)
    )
      throw new Error(
        "Fill the backend R2 connection variables before syncing.",
      );
    const remote = dryRun ? null : new R2Storage();
    const rows = await db.query<SyncAsset>(
      "SELECT storage_key,sha256,mime_type FROM assets WHERE deleted_at IS NULL ORDER BY storage_key",
    );
    const progress = await syncAssets(rows, local, remote, {
      concurrency: Number(
        process.argv
          .find((value) => value.startsWith("--concurrency="))
          ?.slice(14) ?? "8",
      ),
      onProgress: ({ verified, total }) => {
        if (verified % 100 === 0 || verified === total)
          console.log(`Verified ${verified}/${total} assets`);
      },
    });
    console.log(JSON.stringify({ dryRun, ...progress }));
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Storage sync failed.",
  );
  if (typeof error === "object" && error !== null) {
    const detail = error as {
      name?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    console.error(
      JSON.stringify({
        errorType: detail.name,
        code: detail.code,
        httpStatus: detail.$metadata?.httpStatusCode,
      }),
    );
  }
  process.exitCode = 1;
});
