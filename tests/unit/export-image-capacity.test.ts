import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import { ExportImageService } from "../../src/modules/assets/export-image";
import { ingestAsset } from "../../src/modules/assets/asset-ingest";

jest.mock("../../src/modules/assets/asset-ingest", () => ({
  ingestAsset: jest.fn(),
}));
const asset = {
  id: "asset",
  storage_key: "org/one/image.png",
  size: "3",
  mime_type: "image/png",
  deleted_at: null,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  download: (
    url: string,
  ) => Promise<{ url: string; mimeType: string; bytes: Buffer }>,
  cached = false,
) {
  const client = {
    query: jest.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT a.*") ? (cached ? [asset] : []) : [],
    })),
  };
  const db = {
    query: jest.fn(async () => (cached ? [asset] : [])),
    transaction: jest.fn(
      async (run: (connection: unknown) => Promise<unknown>) => run(client),
    ),
  };
  const storage = { exists: jest.fn(async () => true) };
  return {
    db,
    service: new ExportImageService(
      db as unknown as Database,
      storage as unknown as StoragePort,
      download,
    ),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  (ingestAsset as jest.Mock).mockResolvedValue(asset);
});

test("duplicate concurrent export misses reuse one download and do not retain duplicate image buffers", async () => {
  const gate = deferred();
  const download = jest.fn(async (url: string) => {
    await gate.promise;
    return { url, mimeType: "image/png", bytes: Buffer.from("png") };
  });
  const { service, db } = fixture(download);
  const pending = Array.from({ length: 20 }, () =>
    service.cached("org", "user", "https://www.neptun-ks.com/photo.png"),
  );
  await tick();
  expect(download).toHaveBeenCalledTimes(1);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  gate.resolve();
  expect(await Promise.all(pending)).toHaveLength(20);
});

test("different misses have bounded byte-free waiters and excess requests get 429 before a transaction", async () => {
  const gate = deferred();
  const download = jest.fn(async (url: string) => {
    await gate.promise;
    return { url, mimeType: "image/png", bytes: Buffer.from("png") };
  });
  const { service, db } = fixture(download);
  const pending = Array.from({ length: 12 }, (_, index) =>
    service
      .cached("org", "user", `https://www.neptun-ks.com/${index}.png`)
      .then(
        () => 200,
        (error: { getStatus(): number }) => error.getStatus(),
      ),
  );
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  expect(db.transaction).toHaveBeenCalledTimes(2);
  gate.resolve();
  const statuses = await Promise.all(pending);
  expect(statuses.filter((status) => status === 200)).toHaveLength(10);
  expect(statuses.filter((status) => status === 429)).toHaveLength(2);
});

test("cached images bypass miss admission and failed downloads release capacity for retries", async () => {
  const never = jest.fn();
  const cached = fixture(never, true);
  expect(
    await cached.service.cached(
      "org",
      "user",
      "https://www.neptun-ks.com/photo.png",
    ),
  ).toEqual(asset);
  expect(never).not.toHaveBeenCalled();
  expect(cached.db.transaction).not.toHaveBeenCalled();
  const download = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      url: "https://www.neptun-ks.com/photo.png",
      mimeType: "image/png",
      bytes: Buffer.from("png"),
    });
  const { service } = fixture(download);
  await expect(
    service.cached("org", "user", "https://www.neptun-ks.com/photo.png"),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    service.cached("org", "user", "https://www.neptun-ks.com/photo.png"),
  ).resolves.toEqual(asset);
});
