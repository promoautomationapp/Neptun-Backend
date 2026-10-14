import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import { DocumentAssets } from "../../src/modules/assets/document-assets";

describe("recursive document asset validation", () => {
  test("nested bundle photos, wallpapers and page layers resolve in one tenant-scoped alias query", async () => {
    const id = randomUUID();
    const query = jest
      .fn()
      .mockResolvedValue([
        { source_path: "/assets/shared.png", asset_id: id, available: true },
      ]);
    const assets = new DocumentAssets(
      { query } as unknown as Database,
      {} as StoragePort,
    );
    const input = {
      products: [
        {
          code: "bundle",
          sale: 599,
          bundleProducts: [
            {
              code: "tv",
              image: "/assets/shared.png",
              screenArtwork: {
                image: "/assets/shared.png",
                box: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
              },
            },
          ],
        },
      ],
      pageArtworks: {
        "product-0": [
          { image: "/assets/shared.png", x: 15, y: 30, opacity: 0.6 },
        ],
      },
      pages: { 0: { backgroundImage: "/assets/shared.png" } },
    };
    const result = await assets.externalize("organization", input);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "organization",
      ["/assets/shared.png"],
    ]);
    expect(JSON.stringify(result)).not.toContain("/assets/shared.png");
    expect(
      JSON.stringify(result).match(new RegExp(`/api/assets/${id}`, "g")),
    ).toHaveLength(4);
    expect(input.products[0]?.sale).toBe(599);
    expect(input.products[0]?.bundleProducts[0]?.screenArtwork.box).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.6,
    });
    expect(input.pages[0].backgroundImage).toBe("/assets/shared.png");
  });

  test("a deleted alias target cannot be smuggled into a document's nested artwork", async () => {
    const query = jest.fn().mockResolvedValue([
      {
        source_path: "/assets/deleted.png",
        asset_id: randomUUID(),
        available: false,
      },
    ]);
    const assets = new DocumentAssets(
      { query } as unknown as Database,
      {} as StoragePort,
    );
    await expect(
      assets.externalize("organization", {
        products: [
          {
            code: "bundle",
            bundleProducts: [
              { code: "tv", screenArtwork: { image: "/assets/deleted.png" } },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("legacy unknown paths remain intact and repeated managed UUIDs need only one ownership check", async () => {
    const id = randomUUID();
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id }])
      .mockResolvedValueOnce([]);
    const assets = new DocumentAssets(
      { query } as unknown as Database,
      {} as StoragePort,
    );
    const result = await assets.externalize("organization", {
      coverLogoSource: "/assets/not-yet-imported.png",
      products: [
        {
          image: `/api/assets/${id}`,
          productArtworks: [
            { image: `https://api.example.test/api/assets/${id}` },
          ],
        },
      ],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual(["organization", [id]]);
    expect(result.coverLogoSource).toBe("/assets/not-yet-imported.png");
    expect(
      JSON.stringify(result).match(new RegExp(`/api/assets/${id}`, "g")),
    ).toHaveLength(2);
  });
});
