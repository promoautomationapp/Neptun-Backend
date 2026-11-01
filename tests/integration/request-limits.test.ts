import "reflect-metadata";
import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Database } from "../../src/database/database";
import { env } from "../../src/config/environment";
import {
  apiRateLimitMiddleware,
  normalizeClientIp,
  reserveBillableAiRequest,
  type ApiRateLimits,
} from "../../src/security/request-limits";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
import { DocumentAssets } from "../../src/modules/assets/document-assets";
import { LocalStorage } from "../../src/modules/storage/local.storage";
import type { Actor } from "../../src/modules/auth/domain/actor";

const configured: ApiRateLimits = {
  generalPerSecond: 6,
  generalPerMinute: 600,
  assetsPerSecond: 120,
  assetsPerMinute: 2400,
};
function clientIp() {
  return `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
}
function hash(namespace: string, identity: string, seconds: number) {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`request-rate:${namespace}:${seconds}:${identity}`)
    .digest("hex");
}
describe("durable API and billable AI admission limits", () => {
  const db = new Database();
  afterAll(() => db.onModuleDestroy());
  function server(ip: string | undefined, limits = configured) {
    const app = express();
    app.use(apiRateLimitMiddleware(db, ip ? () => ip : undefined, limits));
    app.use(express.json({ limit: "1kb" }));
    app.get(
      ["/api/probe", "/api/assets/:id", "/health", "/ready"],
      (_req, res) => res.json({ ok: true }),
    );
    app.post("/api/probe", (_req, res) => res.json({ ok: true }));
    return app;
  }
  test("concurrent API instances share an atomic burst counter and emit Retry-After before parsing bodies", async () => {
    const ip = clientIp();
    const apps = [
      server(ip, { ...configured, generalPerMinute: 6 }),
      server(ip, { ...configured, generalPerMinute: 6 }),
    ];
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        request(apps[index % 2]!).get("/api/probe"),
      ),
    );
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(6);
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(14);
    for (const reply of replies.filter((reply) => reply.status === 429)) {
      expect(reply.body).toMatchObject({
        code: "API_RATE_LIMITED",
        retryAfterSeconds: expect.any(Number),
      });
      expect(Number(reply.headers["retry-after"])).toBeGreaterThan(0);
    }
    const oversized = await request(
      server(ip, { ...configured, generalPerMinute: 6 }),
    )
      .post("/api/probe")
      .send({ body: "x".repeat(5000) });
    expect(oversized.status).toBe(429);
  });
  test("minute policy survives another process and window expiry resets atomically", async () => {
    const ip = clientIp();
    const limits = {
      ...configured,
      generalPerSecond: 100,
      generalPerMinute: 3,
    };
    for (let index = 0; index < 3; index++)
      await request(server(ip, limits)).get("/api/probe").expect(200);
    const blocked = await request(server(ip, limits))
      .get("/api/probe")
      .expect(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(1);
    await db.query(
      "UPDATE identity_rate_limits SET expires_at=now()-interval '1 second' WHERE key_hash=ANY($1::text[])",
      [
        [
          hash("api", normalizeClientIp(ip), 1),
          hash("api", normalizeClientIp(ip), 60),
        ],
      ],
    );
    await request(server(ip, limits)).get("/api/probe").expect(200);
  });
  test("a62-photo page plus fonts uses a separate asset budget and does not prevent API saves", async () => {
    const ip = clientIp();
    const app = server(ip, { ...configured, generalPerSecond: 2 });
    const images = await Promise.all(
      Array.from({ length: 68 }, (_, index) =>
        request(app).get(`/api/assets/photo-${index}`),
      ),
    );
    expect(images.every((reply) => reply.status === 200)).toBe(true);
    await request(app).post("/api/probe").send({ name: "Saved" }).expect(200);
    await request(app).get("/api/probe").expect(200);
    await request(app).get("/api/probe").expect(429);
    await request(app).get("/health").expect(200);
    await request(app).get("/ready").expect(200);
  });
  test("changing forwarded headers never changes the default socket-based bucket", async () => {
    // Unique namespace is unavailable by design, so expire only this local test peer's counters.
    const peer = "127.0.0.1";
    await db.query(
      "DELETE FROM identity_rate_limits WHERE key_hash=ANY($1::text[])",
      [[hash("api", peer, 1), hash("api", peer, 60)]],
    );
    const app = server(undefined, {
      ...configured,
      generalPerSecond: 1,
      generalPerMinute: 1,
    });
    await request(app)
      .get("/api/probe")
      .set("X-Forwarded-For", "203.0.113.1")
      .set("CF-Connecting-IP", "203.0.113.2")
      .expect(200);
    await request(app)
      .get("/api/probe")
      .set("X-Forwarded-For", "203.0.113.3")
      .set("CF-Connecting-IP", "203.0.113.4")
      .expect(429);
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe(peer);
    expect(normalizeClientIp("::ffff:7f00:1")).toBe(peer);
    expect(normalizeClientIp("127.0.0.1:9000")).toBe("unknown");
    expect(normalizeClientIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
      "2001:db8::1",
    );
  });
  test("simultaneous AI reservations cannot overspend across instances and rolled back jobs are free", async () => {
    const org = randomUUID();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        db.transaction((client) =>
          reserveBillableAiRequest(client, org, {
            per15Minutes: 3,
            perHour: 6,
          }),
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(3);
    const errors = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => (outcome as PromiseRejectedResult).reason);
    expect(
      errors.every(
        (error) =>
          error.getStatus() === 429 &&
          error.getResponse().code === "AI_RATE_LIMITED",
      ),
    ).toBe(true);
    const rollbackOrg = randomUUID();
    await expect(
      db.transaction(async (client) => {
        await reserveBillableAiRequest(client, rollbackOrg, {
          per15Minutes: 1,
          perHour: 1,
        });
        throw new Error("Job creation failed");
      }),
    ).rejects.toThrow("Job creation failed");
    await db.transaction((client) =>
      reserveBillableAiRequest(client, rollbackOrg, {
        per15Minutes: 1,
        perHour: 1,
      }),
    );
    await expect(
      db.transaction((client) =>
        reserveBillableAiRequest(client, rollbackOrg, {
          per15Minutes: 1,
          perHour: 1,
        }),
      ),
    ).rejects.toMatchObject({ status: 429 });
  });
  test("an AI short-window reset cannot reset the separate hourly allowance", async () => {
    const org = randomUUID(),
      limits = { per15Minutes: 1, perHour: 2 };
    await db.transaction((client) =>
      reserveBillableAiRequest(client, org, limits),
    );
    for (let iteration = 0; iteration < 2; iteration++) {
      await db.query(
        "UPDATE identity_rate_limits SET expires_at=now()-interval '1 second' WHERE key_hash=$1",
        [hash("new-ai-job", org, 900)],
      );
      const reserved = db.transaction((client) =>
        reserveBillableAiRequest(client, org, limits),
      );
      if (iteration === 0) await reserved;
      else
        await expect(reserved).rejects.toMatchObject({
          status: 429,
          response: {
            code: "AI_RATE_LIMITED",
            retryAfterSeconds: expect.any(Number),
          },
        });
    }
  });
  test("new unique jobs stop at the organization allowance while active and completed cache reuse remain available", async () => {
    const before = {
      key: env.OPENAI_API_KEY,
      short: env.AI_NEW_JOBS_LIMIT_15_MINUTES,
      long: env.AI_NEW_JOBS_LIMIT_PER_HOUR,
    };
    env.OPENAI_API_KEY = "nonfunctional-test-placeholder";
    env.AI_NEW_JOBS_LIMIT_15_MINUTES = 2;
    env.AI_NEW_JOBS_LIMIT_PER_HOUR = 2;
    try {
      const org = (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES('AI rate test',$1) RETURNING id",
          [randomUUID()],
        )
      )[0]!.id;
      const user = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,password_hash) VALUES($1,'unused') RETURNING id",
          [`${randomUUID()}@example.test`],
        )
      )[0]!.id;
      const actor: Actor = {
        organizationId: org,
        userId: user,
        email: "rate@example.test",
        role: "editor",
        reviewRole: "staff",
        mustChangePassword: false,
      };
      const repo = new AiRepository(
        db,
        new DocumentAssets(db, new LocalStorage(env.LOCAL_STORAGE_DIR)),
        new LifestyleRepository(db),
      );
      const action = (text: string) => ({
        operation: "text_generate" as const,
        params: { text },
        regenerate: false,
      });
      const first = await repo.enqueue(actor, action("First queued request"));
      await repo.enqueue(actor, action("Second queued request"));
      const active = await repo.enqueue(actor, action("First queued request"));
      expect(active).toMatchObject({ cached: true, jobId: first.jobId });
      await expect(
        repo.enqueue(actor, action("Third rejected request")),
      ).rejects.toMatchObject({ status: 429 });
      await db.query(
        "UPDATE ai_results SET status='completed',output_text='Approved' WHERE organization_id=$1 AND id=$2",
        [org, first.resultId],
      );
      const completed = await repo.enqueue(
        actor,
        action("First queued request"),
      );
      expect(completed).toMatchObject({
        cached: true,
        status: "succeeded",
        resultId: first.resultId,
      });
      const count = (
        await db.query<{ count: string }>(
          "SELECT count(*)::text count FROM ai_jobs WHERE organization_id=$1",
          [org],
        )
      )[0]!.count;
      expect(count).toBe("2");
    } finally {
      env.OPENAI_API_KEY = before.key;
      env.AI_NEW_JOBS_LIMIT_15_MINUTES = before.short;
      env.AI_NEW_JOBS_LIMIT_PER_HOUR = before.long;
    }
  });
});
