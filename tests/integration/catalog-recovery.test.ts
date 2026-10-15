import "reflect-metadata";
import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";
import { Database } from "../../src/database/database";
import { recoverInterruptedCatalogJobs } from "../../src/worker/catalog-recovery";

describe("catalog worker restart recovery", () => {
  const db = new Database();
  const organizations: string[] = [];
  beforeAll(async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
    try {
      await boss.start();
      await boss.createQueue("catalog-refresh");
    } finally {
      await boss.stop();
    }
  });
  afterEach(async () => {
    await db.query(
      "DELETE FROM pgboss.job WHERE data->>'organizationId'=ANY($1::text[])",
      [organizations],
    );
    await db.query(
      "DELETE FROM catalog_sync_runs WHERE organization_id=ANY($1::uuid[])",
      [organizations],
    );
    await db.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
      organizations,
    ]);
    organizations.length = 0;
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });

  async function job(
    options: {
      fresh?: boolean;
      completed?: boolean;
      retries?: number;
      queueFailed?: boolean;
      wrongTenant?: boolean;
    } = {},
  ) {
    const organizationId = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Recovery test',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
    organizations.push(organizationId);
    const runId = (
      await db.query<{ id: string }>(
        "INSERT INTO catalog_sync_runs(organization_id,trigger,status,heartbeat_at) VALUES($1,'manual',$2,now()-$3::interval) RETURNING id",
        [
          organizationId,
          options.completed ? "completed" : "running",
          options.fresh ? "0 seconds" : "5 minutes",
        ],
      )
    )[0]!.id;
    const id = randomUUID();
    await db.query(
      "INSERT INTO pgboss.job(id,name,state,started_on,retry_count,data) VALUES($1,'catalog-refresh',$2,now()-interval '5 minutes',$3,$4)",
      [
        id,
        options.queueFailed ? "failed" : "active",
        options.retries ?? 0,
        {
          organizationId: options.wrongTenant ? randomUUID() : organizationId,
          runId,
        },
      ],
    );
    return { id, runId };
  }

  test("requeues the same interrupted job once, atomically with its run", async () => {
    const created = await job();
    const results = await Promise.all([
      recoverInterruptedCatalogJobs(db),
      recoverInterruptedCatalogJobs(db),
    ]);
    expect(results.reduce((sum, result) => sum + result.requeued, 0)).toBe(1);
    const queued = (
      await db.query<{
        state: string;
        retry_count: number;
        started_on: Date | null;
      }>(
        "SELECT state,retry_count,started_on FROM pgboss.job WHERE name='catalog-refresh' AND id=$1",
        [created.id],
      )
    )[0]!;
    expect(queued).toMatchObject({
      state: "created",
      retry_count: 1,
      started_on: null,
    });
    expect(
      (
        await db.query(
          "SELECT status,phase FROM catalog_sync_runs WHERE id=$1",
          [created.runId],
        )
      )[0],
    ).toMatchObject({ status: "queued", phase: "recovering" });
    expect(await recoverInterruptedCatalogJobs(db)).toEqual({
      requeued: 0,
      failed: 0,
    });
  });
  test("leaves healthy heartbeats, completed runs and mismatched tenants alone", async () => {
    await job({ fresh: true });
    await job({ completed: true });
    const mismatched = await job({ wrongTenant: true });
    // Include the intentionally mismatched queue payload in test cleanup.
    organizations.push(
      (
        await db.query<{ org: string }>(
          "SELECT data->>'organizationId' org FROM pgboss.job WHERE name='catalog-refresh' AND id=$1",
          [mismatched.id],
        )
      )[0]!.org,
    );
    expect(await recoverInterruptedCatalogJobs(db)).toEqual({
      requeued: 0,
      failed: 0,
    });
  });
  test("recovers an expired queue job whose run was interrupted", async () => {
    await job({ queueFailed: true });
    expect(await recoverInterruptedCatalogJobs(db)).toEqual({
      requeued: 1,
      failed: 0,
    });
  });
  test("stops after three interruptions and releases the active-run constraint", async () => {
    const created = await job({ retries: 3 });
    expect(await recoverInterruptedCatalogJobs(db)).toEqual({
      requeued: 0,
      failed: 1,
    });
    expect(
      (
        await db.query(
          "SELECT status,error FROM catalog_sync_runs WHERE id=$1",
          [created.runId],
        )
      )[0],
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("interrupted repeatedly"),
    });
    expect(
      (
        await db.query(
          "SELECT state FROM pgboss.job WHERE name='catalog-refresh' AND id=$1",
          [created.id],
        )
      )[0]?.state,
    ).toBe("failed");
    const organizationId = organizations[0]!;
    expect(
      await db.query(
        "INSERT INTO catalog_sync_runs(organization_id,trigger) VALUES($1,'manual') RETURNING status",
        [organizationId],
      ),
    ).toEqual([{ status: "queued" }]);
  });
});
