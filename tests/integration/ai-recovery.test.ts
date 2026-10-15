import "reflect-metadata";
import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";
import { Database } from "../../src/database/database";
import { recoverInterruptedAiJobs } from "../../src/worker/ai/recovery";

describe("interrupted AI jobs", () => {
  const db = new Database();
  let organizationId: string;
  beforeAll(async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
    try {
      await boss.start();
      await boss.createQueue("ai-image");
    } finally {
      await boss.stop();
    }
    organizationId = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('AI recovery',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
  });
  afterEach(async () => {
    await db.query("DELETE FROM pgboss.job WHERE data->>'organizationId'=$1", [
      organizationId,
    ]);
    await db.query("DELETE FROM job_outbox WHERE organization_id=$1", [
      organizationId,
    ]);
    await db.query("DELETE FROM ai_jobs WHERE organization_id=$1", [
      organizationId,
    ]);
    await db.query("DELETE FROM ai_results WHERE organization_id=$1", [
      organizationId,
    ]);
  });
  afterAll(async () => {
    await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await db.onModuleDestroy();
  });

  async function job(
    status: "queued" | "running" | "succeeded",
    queueState: string | null,
    options: {
      fresh?: boolean;
      undispatched?: boolean;
      wrongTenant?: boolean;
    } = {},
  ) {
    const resultId = (
      await db.query<{ id: string }>(
        "INSERT INTO ai_results(organization_id,operation,cache_key,model,prompt_version,status) VALUES($1,'cutout',$2,'mock','test',$3) RETURNING id",
        [
          organizationId,
          randomUUID(),
          status === "succeeded" ? "completed" : "pending",
        ],
      )
    )[0]!.id;
    const jobId = (
      await db.query<{ id: string }>(
        "INSERT INTO ai_jobs(organization_id,result_id,cache_key,payload,status,created_at,started_at) VALUES($1,$2,$3,'{}',$4,now()-interval '20 minutes',CASE WHEN $4='queued' THEN NULL ELSE now()-$5::interval END) RETURNING id",
        [
          organizationId,
          resultId,
          randomUUID(),
          status,
          options.fresh ? "30 seconds" : "20 minutes",
        ],
      )
    )[0]!.id;
    const id = randomUUID();
    const payload = {
      organizationId: options.wrongTenant ? randomUUID() : organizationId,
      jobId,
    };
    await db.query(
      "INSERT INTO job_outbox(id,organization_id,queue,job_key,payload,dispatched_at) VALUES($1,$2,'ai-image',$3,$4,CASE WHEN $5 THEN NULL ELSE now()-$6::interval END)",
      [
        id,
        organizationId,
        randomUUID(),
        payload,
        options.undispatched ?? false,
        options.fresh ? "30 seconds" : "20 minutes",
      ],
    );
    if (queueState)
      await db.query(
        "INSERT INTO pgboss.job(id,name,state,data,started_on) VALUES($1,'ai-image',$2,$3,now()-interval '20 minutes')",
        [id, queueState, { organizationId, jobId }],
      );
    return { jobId, resultId };
  }
  test("finishes orphaned queued work and marks dispatched work uncertain without scheduling another call", async () => {
    const queued = await job("queued", "failed");
    const running = await job("running", null);
    const results = await Promise.all([
      recoverInterruptedAiJobs(db),
      recoverInterruptedAiJobs(db),
    ]);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.uncertain, 0)).toBe(1);
    expect(
      (
        await db.query(
          "SELECT status,finished_at IS NOT NULL finished FROM ai_jobs WHERE id=$1",
          [queued.jobId],
        )
      )[0],
    ).toEqual({ status: "failed", finished: true });
    expect(
      (
        await db.query("SELECT status FROM ai_results WHERE id=$1", [
          running.resultId,
        ])
      )[0]?.status,
    ).toBe("uncertain");
    expect(
      (
        await db.query(
          "SELECT count(*) count FROM job_outbox WHERE organization_id=$1",
          [organizationId],
        )
      )[0]?.count,
    ).toBe("2");
    expect(await recoverInterruptedAiJobs(db)).toEqual({
      failed: 0,
      uncertain: 0,
    });
  });
  test("preserves live queues, grace periods, undispatched work, tenant mismatches and completed results", async () => {
    for (const state of ["created", "retry", "active"])
      await job("running", state);
    await job("running", "failed", { fresh: true });
    await job("queued", null, { fresh: true });
    await job("queued", null, { undispatched: true });
    await job("running", "failed", { wrongTenant: true });
    const completed = await job("succeeded", "completed");
    expect(await recoverInterruptedAiJobs(db)).toEqual({
      failed: 0,
      uncertain: 0,
    });
    expect(
      (
        await db.query("SELECT status FROM ai_results WHERE id=$1", [
          completed.resultId,
        ])
      )[0]?.status,
    ).toBe("completed");
  });
});
