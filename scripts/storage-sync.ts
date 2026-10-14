import { createHash } from "node:crypto";
import type { StoragePort } from "../src/modules/storage/storage.port";
import { isTransientStorageError } from "../src/modules/storage/storage-retry";

export interface SyncAsset {
  storage_key: string;
  sha256: string;
  mime_type: string;
}

export interface SyncProgress {
  total: number;
  verified: number;
  copied: number;
  reused: number;
  bytes: number;
  retries: number;
}

export async function syncAssets(
  rows: readonly SyncAsset[],
  local: StoragePort,
  remote: StoragePort | null,
  options: {
    concurrency?: number;
    onProgress?: (progress: SyncProgress) => void;
  } = {},
): Promise<SyncProgress> {
  const concurrency = options.concurrency ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Storage sync concurrency must be between 1 and 16.");
  const progress: SyncProgress = {
    total: rows.length,
    verified: 0,
    copied: 0,
    reused: 0,
    bytes: 0,
    retries: 0,
  };
  const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 3 || !isTransientStorageError(error)) throw error;
        progress.retries++;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  };
  let next = 0;
  let failed = false;
  let failure: unknown;
  const checksum = (bytes: Buffer): string =>
    createHash("sha256").update(bytes).digest("hex");
  const worker = async (): Promise<void> => {
    while (!failed && next < rows.length) {
      const row = rows[next++];
      if (!row) return;
      try {
        const bytes = await local.read(row.storage_key);
        if (checksum(bytes) !== row.sha256)
          throw new Error("A local asset failed checksum verification.");
        if (remote) {
          if (await retry(() => remote.exists(row.storage_key))) {
            progress.reused++;
          } else {
            await retry(() =>
              remote.put(row.storage_key, bytes, row.mime_type),
            );
            progress.copied++;
          }
          const stored = await retry(() => remote.read(row.storage_key));
          if (checksum(stored) !== row.sha256)
            throw new Error("An R2 asset failed checksum verification.");
        }
        progress.verified++;
        progress.bytes += bytes.length;
        options.onProgress?.({ ...progress });
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()),
  );
  if (failed) throw failure;
  return progress;
}
