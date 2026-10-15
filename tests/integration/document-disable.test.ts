import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Agent } from "supertest";
import argon2 from "argon2";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { ErrorFilter } from "../../src/shared/error.filter";

describe("disabled workspace documents", () => {
  let app: INestApplication, db: Database, organizationId: string;
  const suffix = randomUUID(),
    password = "Isolated archive test password 6821!";
  const agents: Record<string, Agent> = {},
    ids: Record<string, string> = {},
    emails: Record<string, string> = {};
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    organizationId = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Document disable test',$1) RETURNING id",
        [suffix],
      )
    )[0]!.id;
    const otherOrg = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Other disable test',$1) RETURNING id",
        [`${suffix}-other`],
      )
    )[0]!.id;
    const hash = await argon2.hash(password);
    for (const role of [
      "admin",
      "staff",
      "pm",
      "superadmin",
      "other",
    ] as const) {
      emails[role] = `${role}-${suffix}@example.test`;
      ids[role] = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password) VALUES($1,$2,$3,false) RETURNING id",
          [emails[role], role, hash],
        )
      )[0]!.id;
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role) VALUES($1,$2,$3,$4,$5)",
        [
          role === "other" ? otherOrg : organizationId,
          ids[role],
          role === "staff" ? "editor" : role === "pm" ? "reviewer" : "admin",
          role === "staff" ? "staff" : "pm",
          role === "other" ? "superadmin" : role,
        ],
      );
      agents[role] = request.agent(app.getHttpServer());
      await agents[role]!.post("/api/team/login")
        .send({ email: emails[role], password })
        .expect(201);
    }
  });
  afterAll(() => app.close());

  test.each(["campaigns", "posts"] as const)(
    "%s retain content/history, hide from clients, block stale autosave and explicitly restore",
    async (collection) => {
      const field = collection === "campaigns" ? "campaign" : "post",
        id = randomUUID();
      const table = collection === "campaigns" ? "campaigns" : "social_posts";
      const saved = (
        await agents
          .admin!.post(`/api/team/${collection}`)
          .send({
            [field]: {
              id,
              name: "Original artwork",
              products: [
                {
                  code: "TV-1",
                  name: "Preserved product",
                  regular: 399,
                  sale: 299,
                },
              ],
              disabledAt: "2026-01-01T00:00:00.000Z",
              disabledBy: "forged@example.test",
            },
          })
          .expect(201)
      ).body[field];
      expect(saved).toMatchObject({
        disabledAt: null,
        disabledBy: null,
        version: 1,
      });
      await agents
        .admin!.delete(`/api/team/${collection}/${id}`)
        .query({ version: 999 })
        .expect(409);
      const disabled = await agents
        .admin!.delete(`/api/team/${collection}/${id}`)
        .query({ version: saved.version })
        .expect(200);
      expect(disabled.body).toEqual({ deleted: true });
      const row = (
        await db.query<{
          layout: typeof saved;
          deleted_at: Date;
          version: number;
        }>(
          `SELECT layout,deleted_at,version FROM ${table} WHERE organization_id=$1 AND id=$2`,
          [organizationId, id],
        )
      )[0]!;
      expect(row.deleted_at).toBeInstanceOf(Date);
      expect(row.layout).toMatchObject({
        products: saved.products,
        disabledBy: emails.admin,
        version: 2,
      });
      const archived = (
        await agents
          .superadmin!.get(`/api/team/${collection}/${id}`)
          .expect(200)
      ).body[field];
      expect(archived.disabledAt).toBe(row.deleted_at.toISOString());
      expect(
        (
          await agents.superadmin!.get(`/api/team/${collection}`).expect(200)
        ).body[collection].some((item: { id: string }) => item.id === id),
      ).toBe(false);
      expect(
        (
          await agents
            .superadmin!.get(`/api/team/${collection}`)
            .query({ includeDisabled: "true" })
            .expect(200)
        ).body[collection].some((item: { id: string }) => item.id === id),
      ).toBe(true);
      for (const role of ["admin", "staff", "pm"]) {
        const agent = agents[role]!;
        expect(
          (
            await agent
              .get(`/api/team/${collection}`)
              .query({ includeDisabled: "true" })
              .expect(200)
          ).body[collection].some((item: { id: string }) => item.id === id),
        ).toBe(false);
        await agent.get(`/api/team/${collection}/${id}`).expect(404);
        await agent
          .post(`/api/team/${collection}`)
          .send({
            [field]: {
              ...saved,
              version: 2,
              name: "Stale autosave",
              disabledAt: null,
            },
          })
          .expect(404);
        await agent
          .post(`/api/team/${collection}/${id}/restore`)
          .send({ version: 2 })
          .expect(403);
      }
      const failedSave = await agents
        .superadmin!.post(`/api/team/${collection}`)
        .send({ [field]: { ...archived, name: "Still disabled" } })
        .expect(409);
      expect(failedSave.body.code).toBe("DOCUMENT_DISABLED");
      await agents.other!.get(`/api/team/${collection}/${id}`).expect(404);
      await agents
        .other!.post(`/api/team/${collection}/${id}/restore`)
        .send({})
        .expect(404);
      if (collection === "campaigns") {
        for (const role of ["admin", "staff", "pm", "superadmin"])
          await agents[role]!.post(`/api/team/campaigns/${id}/review`)
            .send({
              action: "comment",
              pageIndex: 0,
              text: "Must not change disabled artwork",
            })
            .expect(404);
        await agents
          .staff!.post(`/api/team/campaigns/${id}/presence`)
          .send({ sessionId: randomUUID(), mode: "edit" })
          .expect(404);
      }
      expect(
        (
          await db.query<{ layout: typeof saved }>(
            `SELECT layout FROM ${table} WHERE organization_id=$1 AND id=$2`,
            [organizationId, id],
          )
        )[0]!.layout,
      ).toEqual(row.layout);
      await agents
        .superadmin!.post(`/api/team/${collection}/${id}/restore`)
        .send({ version: 999 })
        .expect(409);
      const restored = (
        await agents
          .superadmin!.post(`/api/team/${collection}/${id}/restore`)
          .send({ version: 2 })
          .expect(201)
      ).body[field];
      expect(restored).toMatchObject({
        products: saved.products,
        disabledAt: null,
        disabledBy: null,
        version: 3,
      });
      expect(
        (await agents.staff!.get(`/api/team/${collection}/${id}`).expect(200))
          .body[field].products,
      ).toEqual(saved.products);
      await agents
        .staff!.post(`/api/team/${collection}`)
        .send({
          [field]: { ...saved, version: 2, name: "Old autosave after enable" },
        })
        .expect(409);
      const versions = await db.query<{
        version: number;
        snapshot: typeof saved;
      }>(
        "SELECT version,snapshot FROM document_versions WHERE organization_id=$1 AND kind=$2 AND document_id=$3 ORDER BY version",
        [organizationId, field, id],
      );
      expect(versions.map((item) => item.version)).toEqual([1, 2, 3]);
      expect(versions[1]!.snapshot.disabledAt).toBe(archived.disabledAt);
      expect(versions[2]!.snapshot.disabledAt).toBeNull();
    },
  );

  test("older soft-deleted rows need no reinsertion or migration to appear as disabled", async () => {
    const id = randomUUID();
    await agents
      .admin!.post("/api/team/posts")
      .send({ post: { id, name: "Older retained social post", products: [] } })
      .expect(201);
    await db.query(
      "UPDATE social_posts SET deleted_at=now() WHERE organization_id=$1 AND id=$2",
      [organizationId, id],
    );
    const old = (
      await agents.superadmin!.get(`/api/team/posts/${id}`).expect(200)
    ).body.post;
    expect(old.disabledAt).toEqual(expect.any(String));
    expect(old.disabledBy).toBeNull();
    await agents.admin!.get(`/api/team/posts/${id}`).expect(404);
    const enabled = (
      await agents
        .superadmin!.post(`/api/team/posts/${id}/restore`)
        .send({ version: 1 })
        .expect(201)
    ).body.post;
    expect(enabled).toMatchObject({
      name: "Older retained social post",
      version: 2,
      disabledAt: null,
    });
  });

  test("a racing autosave cannot clear disable metadata or make a disabled row visible", async () => {
    const id = randomUUID();
    const saved = (
      await agents
        .admin!.post("/api/team/posts")
        .send({ post: { id, name: "Race original", products: [] } })
        .expect(201)
    ).body.post;
    const [disabled, saving] = await Promise.all([
      agents.admin!.delete(`/api/team/posts/${id}`),
      agents
        .staff!.post("/api/team/posts")
        .send({ post: { ...saved, name: "Save raced with disable" } }),
    ]);
    expect(disabled.status).toBe(200);
    expect([201, 404]).toContain(saving.status);
    await agents.admin!.get(`/api/team/posts/${id}`).expect(404);
    const row = (
      await db.query<{ layout: typeof saved; deleted_at: Date }>(
        "SELECT layout,deleted_at FROM social_posts WHERE organization_id=$1 AND id=$2",
        [organizationId, id],
      )
    )[0]!;
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.layout.disabledAt).toBe(row.deleted_at.toISOString());
    expect(row.layout.disabledBy).toBe(emails.admin);
  });

  test("superadmin can disable and enable the only Neptun admin without changing their password or verifying email again", async () => {
    await agents
      .admin!.patch(`/api/team/users/${ids.admin}`)
      .send({ status: "disabled" })
      .expect(409);
    await agents
      .superadmin!.patch(`/api/team/users/${ids.admin}`)
      .send({ status: "disabled" })
      .expect(200);
    await agents.admin!.get("/api/team/campaigns").expect(401);
    await agents
      .admin!.post("/api/team/login")
      .send({ email: emails.admin, password })
      .expect(401);
    await agents
      .superadmin!.patch(`/api/team/users/${ids.admin}`)
      .send({ status: "active" })
      .expect(200);
    await agents.admin!.get("/api/team/campaigns").expect(401);
    await agents
      .admin!.post("/api/team/login")
      .send({ email: emails.admin, password })
      .expect(201);
    await agents.admin!.get("/api/team/campaigns").expect(200);
  });
});
