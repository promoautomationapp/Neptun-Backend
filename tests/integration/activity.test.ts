import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { Request } from "express";
import request from "supertest";
import type { Agent } from "supertest";
import argon2 from "argon2";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { ErrorFilter } from "../../src/shared/error.filter";
import {
  activityEntry,
  activityFilters,
} from "../../src/modules/activity/activity.module";

describe("administrator activity ledger", () => {
  let app: INestApplication, db: Database, org: string;
  const suffix = randomUUID(),
    password = "Activity local test only 8261!";
  const ids: Record<string, string> = {},
    emails: Record<string, string> = {},
    agents: Record<string, Agent> = {};
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Activity test',$1) RETURNING id",
        [suffix],
      )
    )[0]!.id;
    const other = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Other activity test',$1) RETURNING id",
        [`${suffix}-other`],
      )
    )[0]!.id;
    const passwordHash = await argon2.hash(password);
    for (const [key, role] of [
      ["admin", "admin"],
      ["staff", "staff"],
      ["pm", "pm"],
      ["support", "superadmin"],
      ["other", "admin"],
    ] as const) {
      emails[key] = `${key}-${suffix}@example.test`;
      ids[key] = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password) VALUES($1,$2,$3,false) RETURNING id",
          [emails[key], key, passwordHash],
        )
      )[0]!.id;
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role) VALUES($1,$2,$3,$4,$5)",
        [
          key === "other" ? other : org,
          ids[key],
          role === "staff" ? "editor" : role === "pm" ? "reviewer" : "admin",
          role === "staff" ? "staff" : "pm",
          role,
        ],
      );
      agents[key] = request.agent(app.getHttpServer());
      await agents[key]!.post("/api/team/login")
        .send({ email: emails[key], password })
        .expect(201);
    }
  });
  afterAll(() => app.close());
  test("records real successful and unsuccessful writes/sign-ins without bodies, query strings or spoofed proxy IPs", async () => {
    const campaignId = `audit-${suffix}`;
    const secret = "DO_NOT_RECORD_SECRET_PROMPT_OR_PRIVATE_IMAGE";
    await agents
      .staff!.post(`/api/team/campaigns?token=${secret}`)
      .set("X-Forwarded-For", "203.0.113.99")
      .set("CF-Connecting-IP", "203.0.113.98")
      .send({
        campaign: {
          id: campaignId,
          name: secret,
          products: [],
          prompt: secret,
          image: `https://private.example/${secret}`,
        },
      })
      .expect(201);
    await agents
      .staff!.post("/api/team/campaigns")
      .send({ campaign: { id: campaignId } })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/team/login")
      .send({ email: emails.staff, password: "wrong-secret-password" })
      .expect(401);
    const before = (
      await db.query<{ count: string }>(
        "SELECT count(*)::text count FROM activity_audit WHERE organization_id=$1",
        [org],
      )
    )[0]!.count;
    await agents.staff!.get("/api/team/campaigns").expect(200);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text count FROM activity_audit WHERE organization_id=$1",
          [org],
        )
      )[0]!.count,
    ).toBe(before);
    const response = await agents
      .admin!.get("/api/activity")
      .query({ actor: ids.staff, action: "campaign.save" })
      .expect(200);
    expect(response.body.total).toBe(2);
    expect(
      response.body.records
        .map((row: { outcome: string }) => row.outcome)
        .sort(),
    ).toEqual(["failure", "success"]);
    const saved = response.body.records.find(
      (row: { outcome: string }) => row.outcome === "success",
    );
    expect(saved).toMatchObject({
      action: "campaign.save",
      targetId: campaignId,
      route: "/api/team/campaigns",
      statusCode: 201,
      actor: { email: emails.staff },
    });
    expect(saved.ip).toMatch(/127\.0\.0\.1|::1/);
    const serialized = JSON.stringify(
      await db.query("SELECT * FROM activity_audit WHERE organization_id=$1", [
        org,
      ]),
    );
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("wrong-secret-password");
    expect(serialized).not.toContain("203.0.113.99");
    expect(serialized).not.toContain("203.0.113.98");
    const failures = await agents
      .admin!.get("/api/activity")
      .query({ actor: ids.staff, action: "account.login", outcome: "failure" })
      .expect(200);
    expect(failures.body.records).toHaveLength(1);
    expect(failures.body.records[0].statusCode).toBe(401);
    await agents.staff!.post("/api/team/logout").expect(201);
    expect(
      (
        await agents
          .admin!.get("/api/activity")
          .query({ actor: ids.staff, action: "account.logout" })
      ).body.total,
    ).toBe(1);
  });
  test("isolates tenants and excludes support actors/targets from every regular-admin response", async () => {
    await agents
      .support!.post("/api/team/campaigns")
      .send({
        campaign: {
          id: `support-${suffix}`,
          name: "Support action",
          products: [],
        },
      })
      .expect(201);
    await agents
      .other!.post("/api/team/campaigns")
      .send({
        campaign: { id: `other-${suffix}`, name: "Other tenant", products: [] },
      })
      .expect(201);
    await db.query(
      "INSERT INTO account_audit(organization_id,actor_id,user_id,action,detail) VALUES($1,$2,$3,'user.updated',$4)",
      [
        org,
        ids.admin,
        ids.support,
        { email: emails.support, token: "never-return-detail" },
      ],
    );
    const regular = await agents.admin!.get("/api/activity").expect(200),
      support = await agents.support!.get("/api/activity").expect(200);
    expect(JSON.stringify(regular.body)).not.toContain(emails.support);
    expect(JSON.stringify(regular.body)).not.toContain(ids.support);
    expect(JSON.stringify(regular.body)).not.toContain(`other-${suffix}`);
    expect(JSON.stringify(support.body)).toContain(emails.support);
    const global = await agents
      .support!.get("/api/activity")
      .query({ search: emails.other })
      .expect(200);
    expect(global.body.scope).toBe("all-organizations");
    expect(
      global.body.records.some(
        (row: { targetId: string }) => row.targetId === `other-${suffix}`,
      ),
    ).toBe(true);
    expect(
      global.body.records.every(
        (row: { organization: { id: string } }) => row.organization.id !== org,
      ),
    ).toBe(true);
    const isolated = await agents
      .admin!.get("/api/activity")
      .query({ search: emails.other })
      .expect(200);
    expect(isolated.body.records).toEqual([]);
    expect(JSON.stringify(isolated.body.users)).not.toContain(emails.other);
    expect(JSON.stringify(support.body)).not.toContain("never-return-detail");
    for (const role of ["staff", "pm"]) {
      if (role === "staff")
        await agents
          .staff!.post("/api/team/login")
          .send({ email: emails.staff, password })
          .expect(201);
      await agents[role]!.get("/api/activity").expect(403);
    }
    await request(app.getHttpServer()).get("/api/activity").expect(401);
  });
  test("filters inclusive local dates, user/action/search/outcome and pagination, preserving old history as unknown IP", async () => {
    for (const at of [
      "2026-03-31T21:59:59Z",
      "2026-03-31T22:00:00Z",
      "2026-04-01T21:59:59Z",
      "2026-04-01T22:00:00Z",
    ])
      await db.query(
        "INSERT INTO account_audit(organization_id,actor_id,user_id,action,created_at) VALUES($1,$2,$2,'user.activated',$3)",
        [org, ids.admin, at],
      );
    const page = await agents
      .admin!.get("/api/activity")
      .query({
        from: "2026-04-01",
        to: "2026-04-01",
        actor: ids.admin,
        action: "user.activated",
        search: emails.admin,
        limit: 1,
        page: 2,
      })
      .expect(200);
    expect(page.body.total).toBe(2);
    expect(page.body.records).toHaveLength(1);
    expect(page.body.records[0]).toMatchObject({
      ip: null,
      requestId: null,
      source: "account-history",
    });
    expect(activityFilters.safeParse({ from: "2026-02-30" }).success).toBe(
      false,
    );
    await agents
      .admin!.get("/api/activity")
      .query({ from: "2026-04-02", to: "2026-04-01" })
      .expect(400);
    expect(
      activityEntry({
        method: "POST",
        route: { path: "/api/team/campaigns/:id/presence" },
        body: { password, prompt: password },
      } as Request),
    ).toBeNull();
    expect(
      activityEntry({
        method: "POST",
        route: { path: "/api/ai/jobs" },
        body: { operation: "cutout", params: { prompt: password } },
        params: {},
      } as Request),
    ).toEqual({
      action: "ai.cutout",
      method: "POST",
      route: "/api/ai/jobs",
      targetType: "ai",
      targetId: null,
    });
  });
});
