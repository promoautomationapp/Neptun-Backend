import { createHash } from "node:crypto";
import { syncAssets, type SyncAsset } from "../../scripts/storage-sync";
import type { StoragePort } from "../../src/modules/storage/storage.port";

function asset(key: string, bytes: Buffer): SyncAsset {
  return {
    storage_key: key,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime_type: "image/png",
  };
}

function storage(objects: Map<string, Buffer>): StoragePort {
  return {
    read: jest.fn(async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Missing object.");
      return bytes;
    }),
    put: jest.fn(async (key, bytes) => {
      objects.set(key, bytes);
    }),
    exists: jest.fn(async (key) => objects.has(key)),
    remove: jest.fn(),
    signedRead: jest.fn(),
    signedUpload: jest.fn(),
  };
}

describe("verified storage migration", () => {
  test("copies missing media, verifies existing media and preserves local originals", async () => {
    const photo = Buffer.from("original photo pixels");
    const logo = Buffer.from("approved logo pixels");
    const localObjects = new Map([
      ["photo", photo],
      ["logo", logo],
    ]);
    const remoteObjects = new Map([["logo", logo]]);
    const local = storage(localObjects);
    const remote = storage(remoteObjects);
    const rows = [asset("photo", photo), asset("logo", logo)];
    const result = await syncAssets(rows, local, remote);
    expect(result).toMatchObject({
      total: 2,
      verified: 2,
      copied: 1,
      reused: 1,
    });
    expect(remoteObjects.get("photo")).toEqual(photo);
    expect(localObjects.size).toBe(2);
    expect(local.remove).not.toHaveBeenCalled();
    expect(remote.remove).not.toHaveBeenCalled();
    expect(remote.put).toHaveBeenCalledTimes(1);
    const repeat = await syncAssets(rows, local, remote);
    expect(repeat).toMatchObject({ verified: 2, copied: 0, reused: 2 });
    expect(remote.put).toHaveBeenCalledTimes(1);
  });

  test("refuses corrupted local media before uploading it", async () => {
    const original = Buffer.from("original");
    const local = storage(new Map([["photo", Buffer.from("corrupted")]]));
    const remote = storage(new Map());
    await expect(
      syncAssets([asset("photo", original)], local, remote),
    ).rejects.toThrow("local asset failed checksum");
    expect(remote.put).not.toHaveBeenCalled();
  });

  test("reports corrupted remote media without overwriting an existing object", async () => {
    const original = Buffer.from("approved cutout");
    const local = storage(new Map([["cutout", original]]));
    const remote = storage(new Map([["cutout", Buffer.from("different")]]));
    await expect(
      syncAssets([asset("cutout", original)], local, remote),
    ).rejects.toThrow("R2 asset failed checksum");
    expect(remote.put).not.toHaveBeenCalled();
    expect(remote.remove).not.toHaveBeenCalled();
  });

  test("retries an interrupted download and verifies the complete bytes", async () => {
    const original = Buffer.from("approved image");
    const local = storage(new Map([["image", original]]));
    const remote = storage(new Map([["image", original]]));
    remote.read = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
      )
      .mockResolvedValue(original);
    const result = await syncAssets([asset("image", original)], local, remote);
    expect(result).toMatchObject({
      verified: 1,
      copied: 0,
      reused: 1,
      retries: 1,
    });
    expect(remote.read).toHaveBeenCalledTimes(2);
    expect(remote.put).not.toHaveBeenCalled();
  });

  test("limits concurrent transfers and stops scheduling after a failure", async () => {
    const bytes = Buffer.from("photo");
    const rows = Array.from({ length: 6 }, (_, i) => asset(String(i), bytes));
    let active = 0;
    let peak = 0;
    const local = storage(new Map(rows.map((row) => [row.storage_key, bytes])));
    local.read = jest.fn(async (key) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (key === "0") throw new Error("Read failed.");
      return bytes;
    });
    await expect(
      syncAssets(rows, local, null, { concurrency: 2 }),
    ).rejects.toThrow("Read failed.");
    expect(peak).toBe(2);
    expect(local.read).toHaveBeenCalledTimes(2);
  });
});
