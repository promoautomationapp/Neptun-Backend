import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { ProductsRepository } from "../src/modules/products/products.repository";
import type { ProductFilters } from "../src/modules/products/products.repository";
import type { JsonObject } from "../src/shared/json";
async function main(): Promise<void> {
  if (
    !env.TEST_DATABASE_URL ||
    !new URL(env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error(
      "An isolated TEST_DATABASE_URL ending in _test is required.",
    );
  const source = new Database();
  const db = new Database(env.TEST_DATABASE_URL);
  const pool = db.pool;
  let org: string | undefined;
  try {
    const products = await source.query<{
      code: string;
      name: string;
      brand: string;
      model: string;
      category: string;
      subcategory: string;
      category_path: string;
      description: string;
      specs: JsonObject;
    }>(
      "SELECT p.code,p.name,p.brand,p.model,p.category,p.subcategory,p.category_path,p.description,p.specs FROM products p JOIN organizations o ON o.id=p.organization_id WHERE o.slug='neptun'",
    );
    if (!products.length) throw new Error("Import the source catalog first.");
    org = (
      await pool.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
        ["Benchmark", `benchmark-${randomUUID()}`],
      )
    ).rows[0]?.id;
    if (!org) throw new Error("Benchmark tenant creation failed.");
    const rows = Array.from({ length: 10000 }, (_, index) => {
      const product = products[index % products.length];
      if (!product) throw new Error("Fixture missing.");
      return {
        ...product,
        code:
          index < products.length ? product.code : `${product.code}-${index}`,
      };
    });
    await pool.query(
      "INSERT INTO products(organization_id,code,name,brand,model,category,subcategory,category_path,description,specs) SELECT $1,x->>'code',x->>'name',x->>'brand',x->>'model',x->>'category',x->>'subcategory',x->>'category_path',x->>'description',x->'specs' FROM jsonb_array_elements($2::jsonb) x",
      [org, JSON.stringify(rows)],
    );
    await pool.query("ANALYZE products");
    // The repository uses the same database adapter/SQL against an isolated test pool.
    const repo = new ProductsRepository(db);
    const queries = [
      "Samsung 55",
      "samsung55",
      "QE-55Q7F2A",
      "qe 55 q7f2a",
      "samsng 55",
      "84064268",
      "cajnik",
      "telefon",
      "beko",
    ];
    const metrics: Record<
      string,
      { p50Ms: number; p95Ms: number; matches: number }
    > = {};
    for (const q of queries) {
      const filters: ProductFilters = {
        q,
        code: "",
        category: "",
        subcategory: "",
        brand: "",
        limit: 60,
        offset: 0,
      };
      await repo.list(org, filters);
      const samples: number[] = [];
      let matches = 0;
      for (let index = 0; index < 15; index++) {
        const started = performance.now();
        matches = (await repo.list(org, filters)).total;
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      metrics[q] = {
        p50Ms: Number((samples[7] ?? 0).toFixed(2)),
        p95Ms: Number((samples[14] ?? 0).toFixed(2)),
        matches,
      };
    }
    const result = {
      products: 10000,
      measuredAt: new Date().toISOString(),
      measurement:
        "Repository query including count, pagination, sorting and variant joins; local PostgreSQL; 15 measured samples per query after warmup",
      targetP95Ms: 100,
      passed: Object.values(metrics).every((x) => x.p95Ms < 100),
      queries: metrics,
    };
    await writeFile(
      "docs/search-benchmark.json",
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (org) {
      await pool.query("DELETE FROM products WHERE organization_id=$1", [org]);
      await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
    }
    await db.onModuleDestroy();
    await source.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
  process.exitCode = 1;
});
