import "reflect-metadata";
import type { Database } from "../../src/database/database";
import { processCatalogRefresh } from "../../src/modules/catalog/catalog.processor";
import { CatalogRepository } from "../../src/modules/catalog/catalog.repository";
import {
  listingProductKey,
  type SiteObject,
  type SourceTransport,
} from "../../src/modules/catalog/neptun-source";

const html = (name: string, model: unknown) =>
  `<div data-${name}="${JSON.stringify(model).replaceAll('"', "&quot;")}"></div>`;
const item = (
  id: number,
  code: string,
  name = `Product ${code}`,
): SiteObject => ({
  Id: id,
  CodeNumber: code,
  Title: name,
  Category: { Id: 40, Name: "Tosterë", Url: "toster" },
  Url: `product-${id}`,
  Images: [],
  RegularPrice: 99,
});

async function crawl(pages: SiteObject[][], total: number) {
  const requests: number[] = [];
  const query = jest.fn(async (sql: string) =>
    sql.includes("RETURNING id") ? [{ id: "run" }] : [],
  );
  const db = { query } as unknown as Database;
  const existing = jest
    .spyOn(CatalogRepository.prototype, "existing")
    .mockResolvedValue([]);
  const upsert = jest
    .spyOn(CatalogRepository.prototype, "upsert")
    .mockResolvedValue(true);
  const transport: SourceTransport = {
    async get(value) {
      const url = new URL(value);
      if (url.pathname === "/")
        return '<nav id="mainNMenu"><ul><li><a href="/toster.nspx">Tosterë</a></li></ul></nav>';
      if (url.pathname === "/toster.nspx") {
        const page = Number(url.searchParams.get("page"));
        requests.push(page);
        return html("categorydetails", {
          Id: 40,
          ParentId: 1,
          NumberOfProducts: total,
          Products: pages[page - 1] || pages.at(-1),
        });
      }
      return html(
        "productModel",
        pages.flat().find((model) => url.pathname.endsWith(String(model.Url))),
      );
    },
  };
  try {
    await processCatalogRefresh(
      db,
      { organizationId: "catalog-fixture", runId: "run" },
      transport,
    );
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    return {
      requests,
      products: upsert.mock.calls.map(([, product]) => product),
      finished: calls.find(([sql]) =>
        sql.includes("status=$2,phase='finished'"),
      )?.[1],
      missingMarked: calls.some(([sql]) =>
        sql.includes("SET source_missing=true"),
      ),
    };
  } finally {
    existing.mockRestore();
    upsert.mockRestore();
  }
}

describe("website listing identity and complete catalog pagination", () => {
  test("completes when a toaster and a bundle have different website IDs but share one SKU", async () => {
    const result = await crawl(
      [
        [item(46322, "84065793", "Ariete toaster"), item(55, "2")],
        [item(1000432, "84065793", "Positano bundle"), item(66, "3")],
      ],
      4,
    );
    expect(result.requests).toEqual([1, 2]);
    expect(result.finished?.[1]).toBe("completed");
    expect(result.products.map((product) => product.code)).toEqual([
      "84065793",
      "2",
      "3",
    ]);
    expect(result.products[0]?.name).toBe("Ariete toaster");
  });

  test("continues through overlapping pages until every website entry is read", async () => {
    const products = [1, 2, 3, 4].map((id) => item(id, String(id)));
    const result = await crawl(
      [
        [products[0]!, products[1]!],
        [products[1]!, products[2]!],
        [products[3]!],
      ],
      4,
    );
    expect(result.requests).toEqual([1, 2, 3]);
    expect(result.finished?.[1]).toBe("completed");
    expect(result.products).toHaveLength(4);
  });

  test("still fails a truly repeated listing without marking saved products missing", async () => {
    const page = [item(1, "1"), item(2, "2")];
    const result = await crawl([page, page], 4);
    expect(result.requests).toEqual([1, 2]);
    expect(result.finished?.[1]).toBe("failed");
    expect(result.finished?.[8]).toContain("repeated a listing page");
    expect(result.missingMarked).toBe(false);
  });

  test("uses stable source URLs or normalized SKUs only when a website ID is absent", () => {
    expect(listingProductKey({ Id: 5, Url: "first", CodeNumber: " 42 " })).toBe(
      "id:5",
    );
    expect(listingProductKey({ Url: "bundle", CodeNumber: "42" })).toBe(
      "url:bundle",
    );
    expect(listingProductKey({ CodeNumber: " 42 \u00a0" })).toBe("code:42");
  });
});
