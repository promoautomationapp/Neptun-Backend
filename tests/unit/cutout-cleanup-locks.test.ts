import type { PoolClient } from "pg";
import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import { lockDocumentAssets } from "../../src/modules/assets/document-asset-locks";
import { cleanupRejectedCutouts } from "../../src/worker/cutout-cleanup";

const organizationId = "00000000-0000-4000-8000-000000000001";
const parent = {
  id: "00000000-0000-4000-8000-000000000003",
  storage_key: "org/tenant/assets/z.png",
};
const variant = {
  id: "00000000-0000-4000-8000-000000000002",
  storage_key: "org/tenant/assets/a.webp",
};
function fixture(
  options: {
    inUse?: boolean;
    newVariant?: boolean;
    failStorage?: boolean;
  } = {},
) {
  const events: string[] = [];
  let variantReads = 0;
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM asset_variants v JOIN assets")) {
        events.push("variants");
        variantReads++;
        return {
          rows: options.newVariant && variantReads === 1 ? [] : [variant],
          rowCount: 1,
        };
      }
      if (sql.includes("pg_advisory_xact_lock"))
        events.push(`key:${String(values[0])}`);
      else if (sql.includes("ORDER BY id FOR UPDATE")) events.push("rows");
      else if (sql.startsWith("SELECT a.id FROM assets")) {
        events.push("recheck");
        return {
          rows: options.inUse ? [] : [{ id: parent.id }],
          rowCount: options.inUse ? 0 : 1,
        };
      } else if (sql.includes("SET deleted_at")) events.push("tombstone");
      else if (sql.includes("cutoutRemoved")) events.push("removed");
      return { rows: [], rowCount: 0 };
    }),
  };
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith("SELECT a.id,a.storage_key")) return [parent];
    events.push("continuation");
    return [];
  });
  const db = {
    query,
    transaction: jest.fn(
      async (work: (connection: PoolClient) => Promise<unknown>) => {
        events.push("begin");
        try {
          const result = await work(client as unknown as PoolClient);
          events.push("commit");
          return result;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      },
    ),
  } as unknown as Database;
  const remove = jest.fn(async (key: string) => {
    events.push(`remove:${key}`);
    if (options.failStorage) throw new Error("Storage temporarily unavailable");
  });
  return {
    db,
    client,
    query,
    events,
    remove,
    storage: { remove } as unknown as StoragePort,
  };
}

test("document references are deduplicated, sorted and locked again within the save transaction", async () => {
  const query = jest.fn(async () => ({
    rows: [{ id: variant.id }, { id: parent.id }],
  }));
  await lockDocumentAssets({ query } as unknown as PoolClient, organizationId, {
    products: [
      { image: `/api/assets/${parent.id}` },
      {
        image: `/api/assets/${variant.id}`,
        original: `/api/assets/${parent.id}`,
      },
    ],
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY id FOR SHARE"),
    [organizationId, [variant.id, parent.id]],
  );
});

test("a photo deleted after initial externalization prevents saving its stale reference", async () => {
  const query = jest.fn(async () => ({ rows: [] }));
  await expect(
    lockDocumentAssets({ query } as unknown as PoolClient, organizationId, {
      image: `/api/assets/${parent.id}`,
    }),
  ).rejects.toThrow("unavailable asset");
});

test("cleanup serializes bytes with ingest, locks rows and rechecks live references before removing them", async () => {
  const test = fixture();
  await cleanupRejectedCutouts(test.db, test.storage, { organizationId });
  expect(test.events).toEqual([
    "begin",
    "variants",
    `key:${organizationId}:asset:${variant.storage_key}`,
    `key:${organizationId}:asset:${parent.storage_key}`,
    "variants",
    "rows",
    "recheck",
    "tombstone",
    `remove:${variant.storage_key}`,
    `remove:${parent.storage_key}`,
    "removed",
    "commit",
  ]);
  expect(test.query.mock.calls[0]?.[0]).toContain(
    "a.kind IN ('cutout','design')",
  );
  expect(
    test.client.query.mock.calls.find(([sql]) =>
      sql.includes("ORDER BY id FOR UPDATE"),
    )?.[1],
  ).toEqual([organizationId, [variant.id, parent.id]]);
});

test("a document save or validated replacement that wins the lock race preserves its bytes", async () => {
  const test = fixture({ inUse: true });
  await cleanupRejectedCutouts(test.db, test.storage, { organizationId });
  expect(test.events).toContain("recheck");
  expect(test.events).not.toContain("tombstone");
  expect(test.remove).not.toHaveBeenCalled();
});

test("a derivative appearing while parent locking waits is retried with every key included", async () => {
  const test = fixture({ newVariant: true });
  await cleanupRejectedCutouts(test.db, test.storage, { organizationId });
  expect(test.remove).not.toHaveBeenCalled();
  expect(test.events).toContain("continuation");
  expect(test.events).not.toContain("tombstone");
});

test("a storage failure rolls back the deletion receipt and keeps cleanup retryable", async () => {
  const test = fixture({ failStorage: true });
  await expect(
    cleanupRejectedCutouts(test.db, test.storage, { organizationId }),
  ).rejects.toThrow("temporarily unavailable");
  expect(test.events).toContain("rollback");
  expect(test.events).not.toContain("removed");
  expect(test.events).not.toContain("commit");
});
