import "reflect-metadata";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import type { Response } from "express";
import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";
import { UploadService } from "../../src/modules/assets/assets.module";
import { sendStoredAsset } from "../../src/modules/assets/asset-response";
import { canonicalAssetInput } from "../../src/modules/assets/image-input";
import {
  MAX_STORED_ASSET_BYTES,
  withImageConversion,
} from "../../src/security/image-work";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response() {
  const emitter = Object.assign(new EventEmitter(), {
    destroyed: false,
    send: jest.fn(),
    destroy: jest.fn(),
  });
  emitter.send.mockReturnValue(emitter);
  emitter.destroy.mockImplementation(() => {
    emitter.destroyed = true;
    emitter.emit("close");
  });
  return { emitter, reply: emitter as unknown as Response };
}

test("large media reads share the byte budget until the response finishes or disconnects", async () => {
  const read = jest.fn().mockResolvedValue(Buffer.from("original"));
  const storage = { read } as unknown as StoragePort;
  const asset = {
    storage_key: "owned/original.png",
    size: String(MAX_STORED_ASSET_BYTES),
  };
  const replies = [response(), response(), response()];
  const pending = replies.map(({ reply }) =>
    sendStoredAsset(storage, asset, reply, () => undefined),
  );
  try {
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(
      asset.storage_key,
      MAX_STORED_ASSET_BYTES,
    );
    expect(replies[0]!.emitter.send).toHaveBeenCalledWith(
      Buffer.from("original"),
    );
    expect(replies[2]!.emitter.send).not.toHaveBeenCalled();
    replies[0]!.emitter.emit("finish");
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
    expect(replies[2]!.emitter.send).toHaveBeenCalledWith(
      Buffer.from("original"),
    );
    replies[1]!.emitter.emit("close");
    replies[2]!.emitter.emit("finish");
    await Promise.all(pending);
  } finally {
    replies.forEach(({ emitter }) => emitter.emit("close"));
    await Promise.allSettled(pending);
  }
});
test("gallery loads admit eight small reads, queue only a bounded number, and reject the excess before R2", async () => {
  const read = jest.fn().mockResolvedValue(Buffer.from("image"));
  const storage = { read } as unknown as StoragePort;
  const replies = Array.from({ length: 72 }, response);
  const asset = { storage_key: "owned/gallery.png", size: "100" };
  const pending = replies.map(({ reply }) =>
    sendStoredAsset(storage, asset, reply, () => undefined),
  );
  const excessResponse = response();
  try {
    await expect(
      sendStoredAsset(storage, asset, excessResponse.reply, () => undefined),
    ).rejects.toMatchObject({
      status: 429,
      response: { retryAfterSeconds: 1 },
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(8);
    expect(excessResponse.emitter.send).not.toHaveBeenCalled();
  } finally {
    // Mark queued clients disconnected, so they release without starting reads.
    replies.forEach(({ emitter }) => {
      emitter.destroyed = true;
      emitter.emit("close");
    });
    await Promise.allSettled(pending);
  }
});
test("stored metadata and actual returned bytes both constrain reads while existing 22MiB assets remain supported", async () => {
  const read = jest.fn().mockResolvedValue(Buffer.from("original"));
  const storage = { read } as unknown as StoragePort;
  const configure = jest.fn();
  await expect(
    sendStoredAsset(
      storage,
      { size: String(MAX_STORED_ASSET_BYTES + 1), storage_key: "too-large" },
      response().reply,
      configure,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce(Buffer.from("oversize"));
  await expect(
    sendStoredAsset(
      storage,
      { size: "3", storage_key: "changed-object" },
      response().reply,
      configure,
    ),
  ).rejects.toMatchObject({ status: 502 });
  expect(configure).not.toHaveBeenCalled();
  const normal = response();
  const pending = sendStoredAsset(
    storage,
    { size: "22955703", storage_key: "existing-large.png" },
    normal.reply,
    configure,
  );
  await flush();
  normal.emitter.emit("finish");
  await pending;
  expect(read).toHaveBeenLastCalledWith("existing-large.png", 22955703);
});
test("bodyless confirmations are bounded before acquiring another database connection", async () => {
  const first = deferred<never>(),
    second = deferred<never>();
  const transaction = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockRejectedValue(new Error("released slot"));
  const service = new UploadService(
    { transaction } as unknown as Database,
    {} as StoragePort,
  );
  const request = {
    actor: { organizationId: "owned" },
  } as AuthenticatedRequest;
  const running = [
    service.confirm(request, "one").catch((error: unknown) => error),
    service.confirm(request, "two").catch((error: unknown) => error),
  ];
  try {
    await expect(service.confirm(request, "three")).rejects.toMatchObject({
      status: 429,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    first.reject(new Error("first failed"));
    await running[0];
    await expect(service.confirm(request, "four")).rejects.toThrow(
      "released slot",
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  } finally {
    second.reject(new Error("second failed"));
    await Promise.all(running);
  }
});
test("native SVG conversions retain small sequential batches and reject overflow beyond their bounded waiting room", async () => {
  const held = deferred<void>();
  const running = withImageConversion(() => held.promise);
  const converted = jest.fn();
  const waiting = Array.from({ length: 4 }, (_, index) =>
    withImageConversion(() => converted(index)),
  );
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
  );
  try {
    expect(converted).not.toHaveBeenCalled();
    await expect(
      canonicalAssetInput(svg, "image/svg+xml"),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: "IMAGE_WORK_BUSY" },
    });
    expect(converted).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    await Promise.all([running, ...waiting]);
  }
  expect(converted.mock.calls).toEqual([[0], [1], [2], [3]]);
  const batch = await Promise.all([
    canonicalAssetInput(svg, "image/svg+xml"),
    canonicalAssetInput(svg, "image/svg+xml"),
  ]);
  expect(batch).toEqual([
    expect.objectContaining({ mimeType: "image/png", width: 20, height: 20 }),
    expect.objectContaining({ mimeType: "image/png", width: 20, height: 20 }),
  ]);
  const avif = await sharp(svg).avif().toBuffer();
  const catalogBatch = await Promise.all([
    canonicalAssetInput(avif, "image/avif"),
    canonicalAssetInput(avif, "image/avif"),
  ]);
  expect(catalogBatch).toEqual([
    expect.objectContaining({ mimeType: "image/png", width: 20, height: 20 }),
    expect.objectContaining({ mimeType: "image/png", width: 20, height: 20 }),
  ]);
});

test("duplicate confirmations coalesce by organization and intent without spending extra work slots", async () => {
  const pending = deferred<{
    assetId: string;
    url: string;
    sha256: string;
    stagingKey: string;
  }>();
  const result = {
    assetId: "owned-asset",
    url: "/api/assets/owned-asset",
    sha256: "digest",
    stagingKey: "owned/staging/intent",
  };
  const transaction = jest
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(result);
  const remove = jest.fn().mockResolvedValue(undefined);
  const service = new UploadService(
    { transaction } as unknown as Database,
    { remove } as unknown as StoragePort,
  );
  const request = {
    actor: { organizationId: "tenant-a" },
  } as AuthenticatedRequest;
  const duplicates = Array.from({ length: 24 }, () =>
    service.confirm(request, "same-intent"),
  );
  expect(transaction).toHaveBeenCalledTimes(1);
  pending.resolve(result);
  const confirmed = await Promise.all(duplicates);
  expect(confirmed).toHaveLength(24);
  expect(confirmed.every((item) => item.assetId === "owned-asset")).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
  await service.confirm(request, "same-intent");
  expect(transaction).toHaveBeenCalledTimes(2); // Completed work is removed from the in-flight map.
});
test("confirmation coalescing never shares an operation across organizations and clears rejected work", async () => {
  const first = deferred<never>(),
    second = deferred<never>();
  const transaction = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockRejectedValue(new Error("fresh attempt"));
  const service = new UploadService(
    { transaction } as unknown as Database,
    {} as StoragePort,
  );
  const request = (organizationId: string) =>
    ({ actor: { organizationId } }) as AuthenticatedRequest;
  const a = service
    .confirm(request("a"), "same-intent")
    .catch((error: unknown) => error);
  const b = service
    .confirm(request("b"), "same-intent")
    .catch((error: unknown) => error);
  try {
    expect(transaction).toHaveBeenCalledTimes(2);
    await expect(
      service.confirm(request("c"), "same-intent"),
    ).rejects.toMatchObject({ status: 429 });
    first.reject(new Error("failed read"));
    await a;
    await expect(service.confirm(request("a"), "same-intent")).rejects.toThrow(
      "fresh attempt",
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  } finally {
    second.reject(new Error("finished"));
    await Promise.all([a, b]);
  }
});
