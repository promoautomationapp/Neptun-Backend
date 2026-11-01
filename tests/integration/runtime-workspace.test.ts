import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import PgBoss from "pg-boss";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import express from "express";
import request from "supertest";
import argon2 from "argon2";
import sharp from "sharp";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { env } from "../../src/config/environment";
import {
  runtimeRolePlan,
  RUNTIME_QUEUES,
} from "../../src/database/runtime-role-plan";
import { ErrorFilter } from "../../src/shared/error.filter";
import { accountJsonParser, bodyBudget } from "../../src/security/body-budget";
import { apiRateLimitMiddleware } from "../../src/security/request-limits";
import { UPLOAD_IMAGE_TYPES } from "../../src/modules/assets/image-input";

test("a restricted runtime can log in, save brochures/settings/posts, upload images, review and operate prepared queues", async () => {
  if (
    !new URL(env.DATABASE_URL).pathname.endsWith("_test") ||
    env.MAIL_DRIVER !== "disabled" ||
    env.OPENAI_API_KEY
  )
    throw new Error(
      "Runtime smoke requires isolated test storage/database and disabled providers.",
    );
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const role = `neptun_runtime_smoke_${suffix}`,
    queueSchema = `runtime_smoke_${suffix}`;
  const owner = new Client({ connectionString: env.DATABASE_URL });
  await owner.connect();
  const ownerBoss = new PgBoss({
    db: {
      executeSql: (sql: string, values: unknown[]) => owner.query(sql, values),
    },
    schema: queueSchema,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  let runtime: Database | undefined,
    app: INestApplication | undefined,
    runtimeBoss: PgBoss | undefined;
  let organization: string | undefined;
  const password = `Smoke-only password ${suffix}!`;
  try {
    await ownerBoss.start();
    for (const queue of RUNTIME_QUEUES) await ownerBoss.createQueue(queue);
    await ownerBoss.stop();
    await owner.query(runtimeRolePlan(role, { queueSchema }));
    organization = (
      await owner.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Runtime smoke',$1) RETURNING id",
        [suffix],
      )
    ).rows[0]!.id;
    const emails = [
      `staff-${suffix}@example.test`,
      `pm-${suffix}@example.test`,
    ];
    for (const [index, email] of emails.entries()) {
      const id = (
        await owner.query<{ id: string }>(
          "INSERT INTO users(email,password_hash,must_change_password) VALUES($1,$2,false) RETURNING id",
          [email, await argon2.hash(password)],
        )
      ).rows[0]!.id;
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role) VALUES($1,$2,$3,$4)",
        [organization, id, index ? "admin" : "editor", index ? "pm" : "staff"],
      );
    }
    const restricted = new URL(env.DATABASE_URL);
    restricted.searchParams.set("options", `-c role=${role}`);
    runtime = new Database(restricted.toString());
    expect(
      (await runtime.query<{ role: string }>("SELECT current_user role"))[0]!
        .role,
    ).toBe(role);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database)
      .useValue(runtime)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    app.use(
      apiRateLimitMiddleware(
        runtime,
        () => `2001:db8:${suffix.slice(0, 4)}::1`,
      ),
    );
    app.use(bodyBudget());
    app.use(accountJsonParser());
    app.use(
      "/api/assets/uploads",
      express.raw({
        type: [...UPLOAD_IMAGE_TYPES],
        limit: "12mb",
        inflate: false,
      }),
    );
    app.use(express.json({ limit: "10mb", inflate: false }));
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    const staff = request.agent(app.getHttpServer()),
      pm = request.agent(app.getHttpServer());
    for (const [index, agent] of [staff, pm].entries())
      await agent
        .post("/api/team/login")
        .send({ email: emails[index], password })
        .expect(201);
    expect(
      (await staff.get("/api/team/session").expect(200)).body.user
        .organizationId,
    ).toBe(organization);

    await staff
      .put("/api/team/settings")
      .send({
        expectedVersion: 0,
        settings: {
          contact: { phone: "Test only" },
          stores: [{ city: "Prishtinë" }],
        },
      })
      .expect(200);
    expect(
      (await pm.get("/api/team/settings").expect(200)).body.settings.stores[0]
        .city,
    ).toBe("Prishtinë");
    const id = randomUUID();
    const campaign = {
      id,
      name: "Restricted brochure smoke",
      products: Array.from({ length: 62 }, (_, index) => ({
        code: `smoke-${suffix}-${index}`,
        regular: 199,
        sale: 149,
        brochureDetails: ["x".repeat(1400)],
      })),
      brochureFormat: "portrait",
    };
    expect(Buffer.byteLength(JSON.stringify({ campaign }))).toBeGreaterThan(
      64 * 1024,
    );
    const created = (
      await staff.post("/api/team/campaigns").send({ campaign }).expect(201)
    ).body.campaign;
    const updated = (
      await pm
        .post("/api/team/campaigns")
        .send({ campaign: { ...created, name: "Saved by reviewer" } })
        .expect(201)
    ).body.campaign;
    await staff
      .post("/api/team/campaigns")
      .send({ campaign: created })
      .expect(409);
    expect(
      (await staff.get(`/api/team/campaigns/${id}`).expect(200)).body.campaign
        .version,
    ).toBe(updated.version);
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "submit" })
      .expect(201);
    const noted = (
      await pm
        .post(`/api/team/campaigns/${id}/review`)
        .send({
          action: "comment",
          text: "Smoke comment",
          pageIndex: 0,
          position: { x: 25, y: 30 },
          mention: emails[0],
        })
        .expect(201)
    ).body.campaign;
    const commentId = noted.reviewComments[0].id;
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "reply", commentId, text: "Smoke reply" })
      .expect(201);
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "fix", commentId })
      .expect(201);
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "submit" })
      .expect(201);
    expect(
      (
        await pm
          .post(`/api/team/campaigns/${id}/review`)
          .send({ action: "complete" })
          .expect(201)
      ).body.campaign.status,
    ).toBe("completed");

    const bytes = await sharp({
      create: { width: 20, height: 10, channels: 4, background: "#123456" },
    })
      .png()
      .toBuffer();
    const intent = (
      await staff
        .post("/api/assets/uploads")
        .send({ size: bytes.length, mimeType: "image/png" })
        .expect(201)
    ).body;
    await staff
      .put(intent.uploadUrl)
      .set("Content-Type", "image/png")
      .send(bytes)
      .expect(200);
    const asset = (
      await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(201)
    ).body;
    await staff.get(asset.url).expect(200);
    await request(app.getHttpServer()).get(asset.url).expect(401);
    const postId = randomUUID();
    await staff
      .post("/api/team/posts")
      .send({
        post: { id: postId, name: "Restricted social smoke", products: [] },
      })
      .expect(201);
    expect(
      (await pm.get(`/api/team/posts/${postId}`).expect(200)).body.post.name,
    ).toBe("Restricted social smoke");
    await staff.get("/api/catalog/refresh").expect(200);

    runtimeBoss = new PgBoss({
      connectionString: restricted.toString(),
      schema: queueSchema,
      migrate: true,
      supervise: true,
      schedule: true,
      maintenanceIntervalSeconds: 1,
    });
    const queueErrors: unknown[] = [];
    runtimeBoss.on("error", (error) => queueErrors.push(error));
    await runtimeBoss.start();
    for (const queue of RUNTIME_QUEUES) await runtimeBoss.createQueue(queue);
    await runtimeBoss.schedule(
      "catalog-daily",
      "0 3 * * *",
      {},
      { tz: "Europe/Belgrade" },
    );
    const job = await runtimeBoss.send("asset-variants", { testOnly: true });
    expect(job).toBeTruthy();
    const fetched = await runtimeBoss.fetch("asset-variants");
    expect(fetched?.[0]?.id).toBe(job);
    await runtimeBoss.complete("asset-variants", job!);
    expect(queueErrors).toEqual([]);
    await runtimeBoss.stop();
    runtimeBoss = undefined;
    await expect(
      runtime.query("CREATE TABLE public.forbidden_runtime_smoke(id int)"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query("UPDATE account_audit SET action=action WHERE false"),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await runtimeBoss?.stop().catch(() => {});
    await ownerBoss.stop().catch(() => {});
    if (app) await app.close();
    else await runtime?.onModuleDestroy();
    await owner.query("ROLLBACK");
    // Disposable business fixtures remain only in the isolated test database,
    // as in workspace.test.ts. Always remove the temporary role/queue schema.
    try {
      await owner.query(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
      await owner.query(`DROP OWNED BY "${role}"`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await owner.end();
    }
  }
}, 60000);
