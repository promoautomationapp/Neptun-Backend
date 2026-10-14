import { createHash } from "node:crypto";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { LocalStorage } from "../src/modules/storage/local.storage";
import { R2Storage } from "../src/modules/storage/r2.storage";
async function main(): Promise<void> {
  const db = new Database();
  const local = new LocalStorage(env.LOCAL_STORAGE_DIR);
  const dryRun = process.argv.includes("--dry-run");
  let copied = 0,
    verified = 0;
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
    const rows = await db.query<{
      storage_key: string;
      sha256: string;
      mime_type: string;
    }>(
      "SELECT storage_key,sha256,mime_type FROM assets WHERE deleted_at IS NULL ORDER BY storage_key",
    );
    for (const row of rows) {
      const bytes = await local.read(row.storage_key);
      if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
        throw new Error("A local asset failed checksum verification.");
      verified++;
      if (remote) {
        if (!(await remote.exists(row.storage_key))) {
          await remote.put(row.storage_key, bytes, row.mime_type);
          copied++;
        }
        const stored = await remote.read(row.storage_key);
        if (createHash("sha256").update(stored).digest("hex") !== row.sha256)
          throw new Error("An R2 asset failed checksum verification.");
      }
      if (verified % 1000 === 0)
        console.log(`Verified ${verified}/${rows.length} assets`);
    }
    console.log(JSON.stringify({ dryRun, verified, copied }));
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Storage sync failed.",
  );
  process.exitCode = 1;
});
