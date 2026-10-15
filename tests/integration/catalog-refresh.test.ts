import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/database/database";
import { CatalogRepository } from "../../src/modules/catalog/catalog.repository";
import { processCatalogRefresh } from "../../src/modules/catalog/catalog.processor";
import { ProductsRepository } from "../../src/modules/products/products.repository";
import type {
  SourceTransport,
  SiteObject,
} from "../../src/modules/catalog/neptun-source";
const html = (name: string, value: unknown) =>
  `<div data-${name}="${JSON.stringify(value).replaceAll('"', "&quot;")}"></div>`;
const model = (code: string, name: string): SiteObject => ({
  CodeNumber: code,
  Title: name,
  Category: { Id: 174, Name: "TV", Url: "tv" },
  Manufacturer: { Name: "FUEGO" },
  Url: `TV-${code}`,
  RegularPrice: 399,
  RatePrice: 11,
  ActualPrice: 299,
  Images: [],
  ShortDescription: '* Përmasat: 55"<br/>* Wi-Fi',
  NavigationPath: [{ Name: "•TV & AUDIO & VIDEO" }, { Name: "TV" }],
});
const menu = (partial = false) =>
  `<nav id="mainNMenu"><ul><li><a data-label-parent="Shtëpia.nspx">TV & AUDIO & VIDEO</a><ul><li><a href="/tv.nspx">TV</a></li>${partial ? '<li><a href="/soundbar.nspx">Soundbar</a></li>' : ""}</ul></li></ul></nav>`;
describe("durable incremental catalog refresh", () => {
  const db = new Database();
  const repository = new CatalogRepository(db);
  let org: string;
  beforeAll(async () => {
    org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Catalog test',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
    for (const code of ["100", "200"])
      await db.query(
        "INSERT INTO products(organization_id,code,name,category,subcategory,category_path,product_url,source) VALUES($1,$2,$3,'SHTEPIA','TV','SHTEPIA > •TV & AUDIO & VIDEO > TV',$4,$5)",
        [
          org,
          code,
          `Old ${code}`,
          `https://www.neptun-ks.com/categories/tv/TV-${code}`,
          { product_url: `https://www.neptun-ks.com/categories/tv/TV-${code}` },
        ],
      );
    await db.query(
      "INSERT INTO campaigns(organization_id,id,name,status,layout) VALUES($1,'saved-campaign','Saved','in_progress',$2)",
      [
        org,
        {
          products: [
            { code: "100", name: "My edited brochure title", sale: 123 },
          ],
        },
      ],
    );
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });
  test("allows one scheduled run per Belgrade day while manual refresh stays available", async () => {
    const dailyOrg = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Daily schedule test',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
    const first = await repository.enqueue(dailyOrg, "daily");
    await db.query(
      "UPDATE catalog_sync_runs SET status='completed',completed_at=now() WHERE id=$1",
      [first.runId],
    );
    const repeated = await Promise.all([
      repository.enqueue(dailyOrg, "daily"),
      repository.enqueue(dailyOrg, "daily"),
    ]);
    expect(repeated.every((run) => run.runId === first.runId)).toBe(true);
    const manual = await repository.enqueue(dailyOrg, "manual");
    expect(manual.runId).not.toBe(first.runId);
    await db.query(
      "UPDATE catalog_sync_runs SET status='completed',completed_at=now() WHERE id=$1",
      [manual.runId],
    );
    await db.query(
      "UPDATE catalog_sync_runs SET created_at=created_at-interval '1 day' WHERE id=$1",
      [first.runId],
    );
    const tomorrow = await repository.enqueue(dailyOrg, "daily");
    expect(tomorrow.runId).not.toBe(first.runId);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM catalog_sync_runs WHERE organization_id=$1 AND trigger='daily'",
          [dailyOrg],
        )
      )[0]!.count,
    ).toBe("2");
  });
  test("repairs legacy hierarchy and de-duplicates concurrent queued refreshes", async () => {
    expect(await repository.repairHierarchy(org)).toBe(2);
    const [a, b] = await Promise.all([
      repository.enqueue(org, "manual"),
      repository.enqueue(org, "daily"),
    ]);
    expect(a.runId).toBe(b.runId);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM catalog_sync_runs WHERE organization_id=$1 AND status='queued'",
          [org],
        )
      )[0]?.count,
    ).toBe("1");
  });
  test("updates by stable code, adds new, marks absent without deleting and leaves brochure edits", async () => {
    const products = [
      { ...model("100", "Updated 100"), CodeNumber: " 100 " },
      model("300", "New 300"),
    ];
    const transport: SourceTransport = {
      async get(url) {
        if (url === "https://www.neptun-ks.com/") return menu();
        if (url.includes("tv.nspx"))
          return html("categorydetails", {
            Id: 174,
            ParentId: 1,
            NumberOfProducts: products.length,
            Products: products,
          });
        return html(
          "productModel",
          products.find((p) => url.endsWith(String(p.Url)))!,
        );
      },
    };
    const status = await repository.status(org);
    await processCatalogRefresh(
      db,
      { organizationId: org, runId: status.runId! },
      transport,
    );
    const finished = await repository.status(org);
    expect(finished.status).toBe("completed");
    expect(finished.added).toBe(1);
    expect(finished.updated).toBe(1);
    expect(finished.missing).toBe(1);
    expect(finished.lastSuccessfulAt).toBeTruthy();
    const rows = await db.query<{
      code: string;
      name: string;
      regular: string;
      source_missing: boolean;
      category_path: string;
    }>(
      "SELECT code,name,regular,source_missing,category_path FROM products WHERE organization_id=$1 ORDER BY code",
      [org],
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.regular).toBe("399.00");
    expect(rows[0]?.source_missing).toBe(false);
    expect(rows[0]?.category_path).toBe("TV & AUDIO & VIDEO > TV");
    expect(rows[1]?.source_missing).toBe(true);
    expect(rows[2]?.name).toBe("New 300");
    const saved = (
      await db.query<{
        layout: { products: { name: string; sale: number }[] };
      }>(
        "SELECT layout FROM campaigns WHERE organization_id=$1 AND id='saved-campaign'",
        [org],
      )
    )[0]!.layout;
    expect(saved.products[0]).toEqual({
      code: "100",
      name: "My edited brochure title",
      sale: 123,
    });
    expect(
      (await new ProductsRepository(db).facets(org)).paths[0]?.categoryPath,
    ).toBe("TV & AUDIO & VIDEO > TV");
    expect((await repository.status(randomUUID())).runId).toBeNull();
  });
  test("unchanged products avoid fetching details again and failed listings never mark missing", async () => {
    const products = [
      { ...model("100", "Updated 100"), CodeNumber: " 100 " },
      model("300", "New 300"),
    ];
    let details = 0;
    const transport: SourceTransport = {
      async get(url) {
        if (url === "https://www.neptun-ks.com/") return menu();
        if (url.includes("tv.nspx"))
          return html("categorydetails", {
            Id: 174,
            ParentId: 1,
            NumberOfProducts: 2,
            Products: products,
          });
        details++;
        return html("productModel", products[0]);
      },
    };
    const run = await repository.enqueue(org, "manual");
    await processCatalogRefresh(
      db,
      { organizationId: org, runId: run.runId! },
      transport,
    );
    expect(details).toBe(0);
    expect((await repository.status(org)).unchanged).toBe(2);
    await db.query(
      "UPDATE products SET source_missing=false WHERE organization_id=$1 AND code='200'",
      [org],
    );
    const partial: SourceTransport = {
      async get(url) {
        if (url === "https://www.neptun-ks.com/") return menu(true);
        if (url.includes("soundbar")) throw new Error("Network interrupted");
        return transport.get(url);
      },
    };
    const next = await repository.enqueue(org, "manual");
    await processCatalogRefresh(
      db,
      { organizationId: org, runId: next.runId! },
      partial,
    );
    expect((await repository.status(org)).status).toBe("failed");
    expect(
      (
        await db.query<{ source_missing: boolean }>(
          "SELECT source_missing FROM products WHERE organization_id=$1 AND code='200'",
          [org],
        )
      )[0]?.source_missing,
    ).toBe(false);
  });
});
