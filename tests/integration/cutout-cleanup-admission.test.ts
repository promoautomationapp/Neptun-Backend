import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/database/database";
import { enqueueRejectedCutoutCleanup } from "../../src/modules/ai/cutout-rejection";

describe("PostgreSQL cutout cleanup admission during document saves", () => {
  const db = new Database();
  afterAll(() => db.onModuleDestroy());

  async function organization() {
    return (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Cutout cleanup regression',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
  }

  test("a save without cleanup candidates completes instead of failing UUID/text parameter resolution", async () => {
    const organizationId = await organization();
    await db.transaction((client) =>
      enqueueRejectedCutoutCleanup(client, organizationId),
    );
    const jobs = await db.query(
      "SELECT id FROM job_outbox WHERE organization_id=$1",
      [organizationId],
    );
    expect(jobs).toEqual([]);
  });

  test("an eligible rejected cutout creates a correctly typed tenant job and string payload", async () => {
    const organizationId = await organization();
    const id = randomUUID();
    await db.query(
      "INSERT INTO assets(id,organization_id,storage_key,sha256,size,mime_type,kind,metadata) VALUES($1,$2,$3,$4,1,'image/png','cutout',$5)",
      [
        id,
        organizationId,
        `test-only/${id}.png`,
        "0".repeat(64),
        { cutoutRejected: true },
      ],
    );
    await db.transaction((client) =>
      enqueueRejectedCutoutCleanup(client, organizationId),
    );
    const jobs = await db.query<{
      organization_id: string;
      queue: string;
      payload: unknown;
    }>(
      "SELECT organization_id,queue,payload FROM job_outbox WHERE organization_id=$1",
      [organizationId],
    );
    expect(jobs).toEqual([
      {
        organization_id: organizationId,
        queue: "asset-variants",
        payload: { organizationId, cleanupRejected: true },
      },
    ]);
  });
});
