import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "pg";
import type { Database } from "../../src/database/database";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import { UploadService } from "../../src/modules/assets/assets.module";
import { DocumentAssets } from "../../src/modules/assets/document-assets";
import { ingestAsset } from "../../src/modules/assets/asset-ingest";
import { canonicalAssetInput } from "../../src/modules/assets/image-input";

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>alert("not stored")</script><rect x="4" y="4" width="8" height="8" fill="#ef4023"/></svg>',
);
const actor = { organizationId: randomUUID(), userId: randomUUID() };
const request = { actor } as AuthenticatedRequest;

function assetStore({ revived = false } = {}) {
  const id = randomUUID();
  const files = new Map<string, { bytes: Buffer; mimeType: string }>();
  const query = jest.fn(async (sql: string, values: unknown[]) => {
    if (sql.startsWith("SELECT deleted_at FROM assets"))
      return revived ? [{ deleted_at: new Date() }] : [];
    if (sql.startsWith("INSERT INTO assets"))
      return [
        {
          id,
          organization_id: values[0],
          storage_key: values[1],
          sha256: values[2],
          size: String(values[3]),
          mime_type: values[4],
          width: values[5],
          height: values[6],
          kind: values[7],
          metadata: values[8],
        },
      ];
    return [];
  });
  const storage: StoragePort = {
    put: async (key, bytes, mimeType) => {
      files.set(key, { bytes, mimeType });
    },
    read: async (key) => {
      const file = files.get(key);
      if (!file) throw new Error("Missing test image");
      return file.bytes;
    },
    exists: async (key) => files.has(key),
    remove: async (key) => {
      files.delete(key);
    },
    signedRead: async () => null,
    signedUpload: async () => null,
  };
  return {
    id,
    query,
    files,
    storage,
    db: {
      query,
      transaction: async (work: (client: PoolClient) => Promise<unknown>) =>
        work({
          query: async (sql: string, values: unknown[]) => ({
            rows: await query(sql, values),
          }),
        } as unknown as PoolClient),
    } as unknown as Database,
  };
}

async function transparentAvif() {
  return sharp({
    create: {
      width: 24,
      height: 16,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="24" height="16"><rect x="4" y="4" width="8" height="8" fill="#ef4023"/></svg>',
        ),
      },
    ])
    .avif({ lossless: true })
    .toBuffer();
}

describe("uploaded SVG and AVIF images", () => {
  test("rejects huge vector rasterization before it allocates the PNG pixels", async () => {
    const huge = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="4000"><rect width="8000" height="4000" fill="red"/></svg>',
    );
    await expect(canonicalAssetInput(huge, "image/svg+xml")).rejects.toThrow(
      "16 megapixels",
    );
  });
  test("locks content-addressed storage before inspection and gives revived assets fresh variant work", async () => {
    const store = assetStore({ revived: true });
    const exists = jest
      .spyOn(store.storage, "exists")
      .mockImplementation(async () => {
        expect(store.query.mock.calls[0]?.[0]).toContain(
          "pg_advisory_xact_lock",
        );
        return false;
      });
    await ingestAsset(
      store.db,
      store.storage,
      actor.organizationId,
      await sharp(svg).png().toBuffer(),
      "image/png",
    );
    expect(exists).toHaveBeenCalledTimes(1);
    const variants = store.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO job_outbox"),
    );
    expect(variants?.[1][1]).toMatch(
      new RegExp(
        `^variants:${actor.organizationId}:${store.id}:1:[a-f0-9-]{36}$`,
      ),
    );
  });
  test.each(["image/svg+xml", "image/avif"])(
    "accepts %s upload intent while preserving source-size and file-type limits",
    async (mimeType) => {
      const id = randomUUID();
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ id }])
        .mockResolvedValue([]);
      const signedUpload = jest.fn().mockResolvedValue(null);
      const uploads = new UploadService(
        { query } as unknown as Database,
        { signedUpload } as unknown as StoragePort,
      );
      expect(
        await uploads.create(request, { size: 100, mimeType }),
      ).toMatchObject({ id, headers: { "Content-Type": mimeType } });
      expect(signedUpload).toHaveBeenCalledWith(
        `org/${actor.organizationId}/staging/${id}`,
        mimeType,
      );
      await expect(
        uploads.create(request, { size: 13 * 1024 * 1024, mimeType }),
      ).rejects.toThrow();
      await expect(
        uploads.create(request, { size: 100, mimeType: "text/html" }),
      ).rejects.toThrow();
    },
  );

  test.each(["image/svg+xml", "image/avif"])(
    "stores %s as checksummed PNG with its original bounds and transparent background",
    async (mimeType) => {
      const source = mimeType === "image/avif" ? await transparentAvif() : svg;
      const store = assetStore();
      const asset = await ingestAsset(
        store.db,
        store.storage,
        actor.organizationId,
        source,
        mimeType,
      );
      const saved = store.files.get(asset.storage_key);
      expect(asset).toMatchObject({
        mime_type: "image/png",
        width: 24,
        height: 16,
      });
      expect(asset.storage_key).toMatch(/\.png$/);
      expect(saved?.mimeType).toBe("image/png");
      if (!saved) throw new Error("No stored image");
      expect(asset.sha256).toBe(
        createHash("sha256").update(saved.bytes).digest("hex"),
      );
      expect(saved.bytes.includes(Buffer.from("<script>"))).toBe(false);
      const pixels = await sharp(saved.bytes).ensureAlpha().raw().toBuffer();
      expect(pixels[3]).toBe(0);
      expect(pixels[(6 * 24 + 6) * 4 + 3]).toBe(255);
      expect(pixels[(6 * 24 + 6) * 4]).toBeGreaterThan(220);
    },
  );

  test("rejects MIME mismatches, invalid images and oversized SVG dimensions before storing bytes", async () => {
    const avif = await transparentAvif();
    for (const [bytes, mimeType] of [
      [svg, "image/avif"],
      [avif, "image/svg+xml"],
      [Buffer.from("broken"), "image/svg+xml"],
      [Buffer.alloc(0), "image/avif"],
      [Buffer.from('<svg width="100000" height="100000"/>'), "image/svg+xml"],
    ] as const) {
      const store = assetStore();
      await expect(
        ingestAsset(
          store.db,
          store.storage,
          actor.organizationId,
          bytes,
          mimeType,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.files.size).toBe(0);
      expect(store.query).not.toHaveBeenCalled();
    }
  });

  test("retains existing PNG bytes and all non-image font/PDF input bytes without conversion", async () => {
    const png = await sharp(svg).png().toBuffer();
    const input = await canonicalAssetInput(png, "image/png");
    expect(input.bytes).toBe(png);
    for (const [mimeType, extension] of [
      ["font/otf", "otf"],
      ["font/ttf", "ttf"],
      ["application/pdf", "pdf"],
    ] as const) {
      const store = assetStore();
      const bytes = Buffer.from(`original-${extension}`);
      const asset = await ingestAsset(
        store.db,
        store.storage,
        actor.organizationId,
        bytes,
        mimeType,
        { enqueueVariants: false },
      );
      expect(asset.storage_key.endsWith(`.${extension}`)).toBe(true);
      expect(store.files.get(asset.storage_key)).toEqual({ bytes, mimeType });
    }
  });

  test.each(["base64 SVG", "encoded SVG", "base64 AVIF"])(
    "externalizes nested %s document images through the same PNG path and deduplicates repeated sources",
    async (variant) => {
      const dataUrl =
        variant === "encoded SVG"
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.toString())}`
          : variant === "base64 AVIF"
            ? `data:image/avif;base64,${(await transparentAvif()).toString("base64")}`
            : `data:image/svg+xml;base64,${svg.toString("base64")}`;
      const store = assetStore();
      const documents = new DocumentAssets(store.db, store.storage);
      const result = await documents.externalize(actor.organizationId, {
        coverLogoSource: dataUrl,
        products: [{ bundleProducts: [{ screenArtwork: { image: dataUrl } }] }],
      });
      expect(result).toEqual({
        coverLogoSource: `/api/assets/${store.id}`,
        products: [
          {
            bundleProducts: [
              { screenArtwork: { image: `/api/assets/${store.id}` } },
            ],
          },
        ],
      });
      expect(store.files.size).toBe(1);
      expect([...store.files.values()][0]?.mimeType).toBe("image/png");
      expect(
        store.query.mock.calls.filter(([sql]) =>
          sql.startsWith("INSERT INTO assets"),
        ),
      ).toHaveLength(1);
    },
  );

  test("keeps the embedded-image size limit and rejects invalid encoded SVG documents", async () => {
    const store = assetStore();
    const documents = new DocumentAssets(store.db, store.storage);
    await expect(
      documents.externalize(actor.organizationId, {
        image: "data:image/svg+xml,%ZZ",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const large = `data:image/svg+xml;base64,${Buffer.alloc(32 * 1024 * 1024 + 1, 32).toString("base64")}`;
    await expect(
      documents.externalize(actor.organizationId, { image: large }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.files.size).toBe(0);
  });
});
