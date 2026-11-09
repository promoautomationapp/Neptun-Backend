import sharp from "sharp";
import type { Database } from "../../src/database/database";
import type { PoolClient } from "pg";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import { ingestAsset } from "../../src/modules/assets/asset-ingest";
import { generateVariants } from "../../src/worker/variants.processor";
import { withImageConversion } from "../../src/security/image-work";

jest.mock("../../src/modules/assets/asset-ingest", () => ({
  ingestAsset: jest.fn(async () => ({
    id: "00000000-0000-4000-8000-000000000002",
  })),
}));
const organizationId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000003";
const storageKey = "org/tenant/assets/z.png";
async function variantFixture(available: boolean) {
  const events: string[] = [];
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) events.push(String(values[0]));
      else if (sql.includes("FOR SHARE")) {
        events.push("revalidate");
        return {
          rows: available ? [{ id: assetId }] : [],
          rowCount: available ? 1 : 0,
        };
      } else if (sql.startsWith("INSERT INTO asset_variants"))
        events.push("link");
      return { rows: [], rowCount: 0 };
    }),
  };
  let variantReads = 0;
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM assets"))
        return [
          {
            id: assetId,
            storage_key: storageKey,
            mime_type: "image/png",
            metadata: {},
            size: bytes.length,
          },
        ];
      // Prepare one missing derivative; the other already exists.
      return variantReads++ ? [{ exists: true }] : [];
    }),
    transaction: jest.fn(
      async (work: (connection: PoolClient) => Promise<unknown>) => {
        events.push("begin");
        await work(client as unknown as PoolClient);
        events.push("commit");
      },
    ),
  } as unknown as Database;
  const bytes = await sharp({
    create: { width: 20, height: 10, channels: 4, background: "white" },
  })
    .png()
    .toBuffer();
  return {
    db,
    client,
    events,
    storage: { read: jest.fn(async () => bytes) } as unknown as StoragePort,
  };
}

beforeEach(() => jest.clearAllMocks());

test("variant jobs wait for native capacity before reading an original", async () => {
  const fixture = await variantFixture(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const occupying = withImageConversion(() => gate);
  const pending = generateVariants(fixture.db, fixture.storage, {
    organizationId,
    assetId,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fixture.storage.read).not.toHaveBeenCalled();
  release();
  await occupying;
  await pending;
  expect(fixture.storage.read).toHaveBeenCalledWith(
    storageKey,
    expect.any(Number),
  );
});

test.each([0, 33 * 1024 * 1024, "invalid"])(
  "invalid source size %s cannot initiate a storage read",
  async (size) => {
    const fixture = await variantFixture(true);
    (fixture.db.query as jest.Mock).mockResolvedValueOnce([
      {
        id: assetId,
        storage_key: storageKey,
        mime_type: "image/png",
        metadata: {},
        size,
      },
    ]);
    await expect(
      generateVariants(fixture.db, fixture.storage, {
        organizationId,
        assetId,
      }),
    ).rejects.toThrow();
    expect(fixture.storage.read).not.toHaveBeenCalled();
  },
);

test("derivatives use the same sorted key locks as cleanup and retain them through registration", async () => {
  const fixture = await variantFixture(true);
  await generateVariants(fixture.db, fixture.storage, {
    organizationId,
    assetId,
  });
  const keys = fixture.events.filter((event) => event.includes(":asset:"));
  expect(keys).toHaveLength(2);
  expect(keys).toEqual([...keys].sort());
  expect(keys).toContain(`${organizationId}:asset:${storageKey}`);
  expect(fixture.events.indexOf("revalidate")).toBeGreaterThan(
    fixture.events.indexOf(keys[1]!),
  );
  expect(fixture.events.indexOf("link")).toBeGreaterThan(
    fixture.events.indexOf("revalidate"),
  );
  expect(fixture.events.at(-1)).toBe("commit");
  expect(ingestAsset).toHaveBeenCalledWith(
    fixture.db,
    fixture.storage,
    organizationId,
    expect.any(Buffer),
    "image/webp",
    expect.objectContaining({ client: fixture.client, sourceAssetId: assetId }),
  );
});

test("a source rejected or deleted during pixel conversion cannot register replacement derivatives", async () => {
  const fixture = await variantFixture(false);
  await generateVariants(fixture.db, fixture.storage, {
    organizationId,
    assetId,
  });
  expect(ingestAsset).not.toHaveBeenCalled();
  expect(fixture.events).toContain("revalidate");
  expect(fixture.events).not.toContain("link");
  expect(
    fixture.client.query.mock.calls.find(([sql]) =>
      sql.includes("FOR SHARE"),
    )?.[0],
  ).toContain("metadata->>'cutoutRejected' IS DISTINCT FROM 'true'");
});
