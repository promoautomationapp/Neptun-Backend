import { CatalogBrandsRepository } from "../../src/modules/catalog/catalog-brands";
import type { Database } from "../../src/database/database";

describe("complete catalog brand discovery", () => {
  test("includes manufacturers without downloaded logos and preserves available source artwork", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          source_id: 12,
          name: "Apple",
          source_url: "https://www.neptun-ks.com/apple.png",
          asset_id: "source-logo",
          error: null,
        },
      ])
      .mockResolvedValueOnce([
        { name: " APPLE " },
        ...Array.from({ length: 125 }, (_, index) => ({
          name: `Manufacturer ${index}`,
        })),
      ]);
    const result = await new CatalogBrandsRepository({
      query,
    } as unknown as Database).list("neptun");
    expect(result.brands).toHaveLength(126);
    expect(result.brands.find((brand) => brand.name === "Apple")).toMatchObject(
      { id: 12, image: "/api/assets/source-logo" },
    );
    expect(
      result.brands.find((brand) => brand.name === "Manufacturer 124"),
    ).toMatchObject({ image: "", sourceImageUrl: "" });
    expect(
      query.mock.calls.every(
        ([, values]) => JSON.stringify(values) === JSON.stringify(["neptun"]),
      ),
    ).toBe(true);
  });
  test.each([{ paths: ["IT"] }, { paths: [] }])(
    "applies the same organization and category scope $paths to logo records and product brands",
    async ({ paths }) => {
      const query = jest.fn().mockResolvedValue([]);
      await new CatalogBrandsRepository({ query } as unknown as Database).list(
        "neptun",
        paths,
      );
      expect(query).toHaveBeenCalledTimes(2);
      for (const [sql, values] of query.mock.calls) {
        expect(sql).toContain("organization_id=$1");
        if (paths.length) {
          expect(sql).toContain("p.category_path=$2");
          expect(sql).toContain("p.category_path LIKE $3");
          expect(values).toEqual(["neptun", "IT", "IT > %"]);
        } else {
          expect(sql).toContain("AND false");
          expect(values).toEqual(["neptun"]);
        }
      }
    },
  );
});
