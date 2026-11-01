import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "../../src/modules/storage/local.storage";
import { StorageReadLimitError } from "../../src/modules/storage/storage-read-limit";
import { UploadService } from "../../src/modules/assets/assets.module";
import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";

it("local storage applies the same byte cap and still reads exact-size and existing uncapped files", async () => {
  const root = await mkdtemp(join(tmpdir(), "neptun-storage-limit-"));
  try {
    const storage = new LocalStorage(root);
    await storage.put(
      "org/test/staging/intent",
      Buffer.from("123456"),
      "image/png",
    );
    await expect(
      storage.read("org/test/staging/intent", 5),
    ).rejects.toBeInstanceOf(StorageReadLimitError);
    await expect(storage.read("org/test/staging/intent", 6)).resolves.toEqual(
      Buffer.from("123456"),
    );
    await expect(storage.read("org/test/staging/intent")).resolves.toEqual(
      Buffer.from("123456"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("confirmation supplies the tenant-owned intent limit and returns a validation error without ingestion on overflow", async () => {
  const row = {
    storage_key: "org/owned/staging/intent",
    max_size: "100",
    mime_type: "image/png",
    asset_id: null,
    valid: true,
  };
  const query = jest.fn().mockResolvedValue({ rows: [row] });
  const db = {
    transaction: async (
      work: (client: { query: typeof query }) => Promise<unknown>,
    ) => work({ query }),
  } as unknown as Database;
  const read = jest.fn().mockRejectedValue(new StorageReadLimitError());
  const storage = { exists: async () => true, read } as unknown as StoragePort;
  const request = {
    actor: { organizationId: "owned", userId: "user" },
  } as AuthenticatedRequest;
  await expect(
    new UploadService(db, storage).confirm(request, "intent"),
  ).rejects.toMatchObject({
    status: 400,
    message: "Invalid or oversized upload.",
  });
  expect(read).toHaveBeenCalledWith(row.storage_key, 100);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual(["owned", "intent"]);
});
