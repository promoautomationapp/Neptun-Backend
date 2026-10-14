import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Database } from "../../src/database/database";
import { ProductsRepository } from "../../src/modules/products/products.repository";
import { jsonObject } from "../../src/shared/json";
describe("search with reference catalog examples", () => {
  const db = new Database();
  const repo = new ProductsRepository(db);
  let org: string;
  beforeAll(async () => {
    org =
      (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          ["Search", randomUUID()],
        )
      )[0]?.id ?? "";
    const catalog = z
      .object({ products: z.array(jsonObject) })
      .parse(
        JSON.parse(
          await readFile("tests/fixtures/catalog-search.json", "utf8"),
        ) as unknown,
      ).products;
    const selected = catalog.filter((x) =>
      ["84064268", "84064107", "84050506"].includes(String(x.code)),
    );
    for (const product of selected)
      await db.query(
        "INSERT INTO products(organization_id,code,name,brand,model,category,subcategory,specs) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          org,
          product.code,
          product.name,
          product.brand,
          "",
          product.category,
          product.subcategory,
          product.specs,
        ],
      );
    await db.query(
      "INSERT INTO products(organization_id,code,name,brand,ean) VALUES($1,$2,$3,$4,$5)",
      [
        org,
        "fixture-diacritics",
        "Çajnik me ngrohës të shpejtë",
        "Neptun",
        "1234567890123",
      ],
    );
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });
  const search = (q: string) =>
    repo.list(org, {
      q,
      code: "",
      category: "",
      subcategory: "",
      brand: "",
      limit: 60,
      offset: 0,
    });
  test("spaces/case and compact brand/size searches match the same products", async () => {
    const spaced = await search("Samsung 55");
    const dense = await search("samsung55");
    expect(spaced.products.map((x) => x.code)).toEqual(
      dense.products.map((x) => x.code),
    );
    expect(dense.products.some((x) => x.code === "84064268")).toBe(true);
  });
  test("model punctuation and spacing are normalized", async () => {
    for (const query of ["QE-55Q7F2A", "qe55q7f2a", "qe 55 q7f2a"])
      expect(
        (await search(query)).products.some((x) => x.code === "84064107"),
      ).toBe(true);
  });
  test("diacritics and a real brand typo remain searchable", async () => {
    expect((await search("cajnik")).products[0]?.code).toBe(
      "fixture-diacritics",
    );
    expect(
      (await search("samsng 55")).products.some((x) => x.code === "84064268"),
    ).toBe(true);
  });
  test("exact SKU and EAN rank first and another tenant sees no products", async () => {
    expect((await search("84064107")).products[0]?.code).toBe("84064107");
    expect((await search("1234567890123")).products[0]?.code).toBe(
      "fixture-diacritics",
    );
    expect(
      (
        await repo.list(randomUUID(), {
          q: "Samsung",
          code: "",
          category: "",
          subcategory: "",
          brand: "",
          limit: 60,
          offset: 0,
        })
      ).total,
    ).toBe(0);
  });
});
