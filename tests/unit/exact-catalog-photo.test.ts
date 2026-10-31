import type { Database } from "../../src/database/database";
import type { Actor } from "../../src/modules/auth/domain/actor";
import { productImageSearchInputSchema } from "../../src/modules/ai/domain/product-image-search";
import {
  exactCatalogPhotoMatches,
  findExactCatalogPhoto,
  type CatalogPhotoIdentity,
} from "../../src/modules/ai/exact-catalog-photo";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import type { DocumentAssets } from "../../src/modules/assets/document-assets";
import type { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
const actor: Actor = {
  organizationId: "org",
  userId: "user",
  email: "staff@example.test",
  role: "editor",
  reviewRole: "staff",
  accountRole: "staff",
  mustChangePassword: false,
};
const input = productImageSearchInputSchema.parse({
  code: "8406-2252",
  name: "FUEGO soundbar F999 Black",
  brand: "FUEGO",
  model: "F999",
});
const row: CatalogPhotoIdentity = {
  id: "product",
  code: "84062252",
  name: input.name,
  brand: "FUEGO",
  model: "F999",
  specs: { Color: "Black" },
  product_url: "https://www.neptun-ks.com/product/f999",
  image_url: "https://www.neptun-ks.com/images/f999.png",
  primary_asset_id: "12345678-1234-4234-8234-123456789012",
};
test("reuses a normalized exact SKU/model across categories while rejecting changed variants, models and bundle scope", () => {
  expect(exactCatalogPhotoMatches(input, row)).toBe(true);
  expect(
    exactCatalogPhotoMatches(
      {
        ...input,
        category: "Another category",
        subcategory: "Sound equipment",
      },
      row,
    ),
  ).toBe(true);
  expect(
    exactCatalogPhotoMatches(
      { ...input, name: "FUEGO soundbar F999 White", variants: ["white"] },
      row,
    ),
  ).toBe(false);
  expect(exactCatalogPhotoMatches(input, { ...row, model: "F999B" })).toBe(
    false,
  );
  expect(
    exactCatalogPhotoMatches(
      { ...input, name: "SET FUEGO soundbar F999 Black", bundle: true },
      row,
    ),
  ).toBe(false);
  expect(
    exactCatalogPhotoMatches(input, {
      ...row,
      name: "SET FUEGO soundbar F999 Black",
    }),
  ).toBe(false);
  expect(
    exactCatalogPhotoMatches(
      { ...input, name: "Unknown Apple product", brand: "APPLE", model: "" },
      { ...row, name: "Apple", brand: "APPLE", model: "" },
    ),
  ).toBe(false);
});
test("returns an already owned photo before creating a job or contacting a provider", async () => {
  const query = jest.fn().mockResolvedValue([row]);
  const transaction = jest.fn();
  const db = { query, transaction } as unknown as Database;
  const repository = new AiRepository(
    db,
    {} as DocumentAssets,
    {} as LifestyleRepository,
  );
  const result = await repository.enqueue(actor, {
    operation: "product_image_search",
    params: input,
    regenerate: false,
  });
  expect(result).toMatchObject({
    cached: true,
    status: "succeeded",
    result: {
      found: true,
      image: `/api/assets/${row.primary_asset_id}`,
      source: "catalog",
      matchedModel: "F999",
    },
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(query.mock.calls[0]?.[0]).toContain("p.organization_id=$1");
  expect(query.mock.calls[0]?.[0]).toContain("a.deleted_at IS NULL");
});
test("catalog photo lookup follows catalog permissions and limits category paths", async () => {
  const query = jest.fn().mockResolvedValue([]);
  const db = { query } as unknown as Database;
  const access = {
    mode: "custom" as const,
    canDisableBrochures: true,
    canViewSocialPosts: true,
    canViewCatalog: false,
    catalogCategoryPaths: null,
  };
  expect(
    await findExactCatalogPhoto(db, { ...actor, access }, input),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
  await findExactCatalogPhoto(
    db,
    {
      ...actor,
      access: {
        ...access,
        canViewCatalog: true,
        catalogCategoryPaths: ["Audio"],
      },
    },
    input,
  );
  expect(query.mock.calls[0]?.[0]).toContain("p.category_path=");
  expect(query.mock.calls[0]?.[1]).toContain("Audio");
});
