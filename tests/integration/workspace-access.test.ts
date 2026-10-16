import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request, { type Agent } from "supertest";
import argon2 from "argon2";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { ErrorFilter } from "../../src/shared/error.filter";
import { EmailService } from "../../src/modules/email/email.service";
import { defaultWorkspaceAccess } from "../../src/modules/auth/domain/workspace-access";

describe("per-member workspace access", () => {
  let app: INestApplication, db: Database, org: string, mail: EmailService;
  const suffix = randomUUID(),
    password = "Workspace access password 5819!";
  const agents: Record<string, Agent> = {},
    ids: Record<string, string> = {};
  const campaignId = randomUUID(),
    postId = randomUUID();
  const restricted = {
    ...defaultWorkspaceAccess(),
    mode: "custom",
    canDisableBrochures: false,
    canViewSocialPosts: false,
    catalogCategoryPaths: ["IT > Computers"],
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    mail = app.get(EmailService);
    org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Access test',$1) RETURNING id",
        [suffix],
      )
    )[0]!.id;
    const hash = await argon2.hash(password);
    for (const role of ["admin", "staff", "pm", "superadmin"] as const) {
      ids[role] = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password) VALUES($1,$2,$3,false) RETURNING id",
          [`${role}-${suffix}@example.test`, role, hash],
        )
      )[0]!.id;
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role) VALUES($1,$2,$3,$4,$5)",
        [
          org,
          ids[role],
          role === "staff" ? "editor" : role === "pm" ? "reviewer" : "admin",
          role === "staff" ? "staff" : "pm",
          role,
        ],
      );
      agents[role] = request.agent(app.getHttpServer());
      await agents[role]!.post("/api/team/login")
        .send({ email: `${role}-${suffix}@example.test`, password })
        .expect(201);
    }
    for (const [code, path, brand] of [
      ["allowed", "IT > Computers > Laptops", "Allowed brand"],
      ["outside", "IT > Accessories", "Hidden brand"],
      ["other-root", "TV > OLED", "Other brand"],
      ["prefix-trap", "IT > Computers extra", "Hidden brand"],
    ]) {
      await db.query(
        "INSERT INTO products(organization_id,code,name,category,subcategory,category_path,brand) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          org,
          code,
          code,
          path!.split(" > ")[0],
          path!.split(" > ")[1],
          path,
          brand,
        ],
      );
    }
    let sourceId = 1;
    for (const path of [
      "IT",
      "IT > Computers",
      "IT > Computers > Laptops",
      "IT > Computers > Desktops",
      "IT > Accessories",
      "TV > OLED",
    ])
      await db.query(
        "INSERT INTO catalog_source_categories(organization_id,source_id,parent_source_id,name,path,source_url) VALUES($1,$2,0,$3,$4,$5)",
        [
          org,
          sourceId++,
          path.split(" > ").at(-1),
          path,
          "https://example.test/category",
        ],
      );
    await agents
      .admin!.post("/api/team/campaigns")
      .send({
        campaign: {
          id: campaignId,
          name: "Shared brochure",
          products: [{ code: "outside", name: "Existing shared product" }],
        },
      })
      .expect(201);
    await agents
      .admin!.post("/api/team/posts")
      .send({ post: { id: postId, name: "Shared post", products: [] } })
      .expect(201);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  test("default accounts retain access; changes apply to the existing session and are audited", async () => {
    expect(
      (await agents.staff!.get("/api/team/session").expect(200)).body.user
        .access,
    ).toEqual(defaultWorkspaceAccess());
    const changed = await agents
      .admin!.patch(`/api/team/users/${ids.staff}`)
      .send({ access: restricted })
      .expect(200);
    expect(changed.body.user.access).toEqual(restricted);
    expect(
      (await agents.staff!.get("/api/team/session").expect(200)).body.user
        .access,
    ).toEqual(restricted);
    const audit = await db.query<{ detail: { access: unknown } }>(
      "SELECT detail FROM account_audit WHERE user_id=$1 AND action='user.updated' ORDER BY created_at DESC LIMIT 1",
      [ids.staff],
    );
    expect(audit[0]!.detail.access).toEqual(restricted);
    await agents
      .staff!.patch(`/api/team/users/${ids.staff}`)
      .send({ access: defaultWorkspaceAccess() })
      .expect(403);
  });

  test("search, exact-code batch, facets and direct filters cannot escape an allowed branch", async () => {
    const list = await agents.staff!.get("/api/products").expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.products.map((p: { code: string }) => p.code)).toEqual([
      "allowed",
    ]);
    for (const query of [
      { q: "outside" },
      { code: "outside" },
      { categoryPath: "TV" },
      { categoryPath: "IT > Accessories" },
      { brand: "Hidden brand" },
    ])
      expect(
        (await agents.staff!.get("/api/products").query(query).expect(200)).body
          .total,
      ).toBe(0);
    const batch = await agents
      .staff!.post("/api/products/batch")
      .send({ codes: ["allowed", "outside", "other-root", "prefix-trap"] })
      .expect(201);
    expect(batch.body.products.map((p: { code: string }) => p.code)).toEqual([
      "allowed",
    ]);
    const facets = (await agents.staff!.get("/api/products/facets").expect(200))
      .body;
    expect(facets.brands).toEqual(["Allowed brand"]);
    expect(
      facets.sourceCategories.map(
        (c: { categoryPath: string }) => c.categoryPath,
      ),
    ).toEqual([
      "IT",
      "IT > Computers",
      "IT > Computers > Desktops",
      "IT > Computers > Laptops",
    ]);
    expect(facets.paths).toHaveLength(1);
  });

  test("hidden social endpoints and brochure disable are denied while shared brochures remain available", async () => {
    await agents.staff!.get(`/api/team/campaigns/${campaignId}`).expect(200);
    await agents.staff!.delete(`/api/team/campaigns/${campaignId}`).expect(403);
    await agents.staff!.get("/api/team/posts").expect(403);
    await agents.staff!.get(`/api/team/posts/${postId}`).expect(403);
    await agents
      .staff!.post("/api/team/posts")
      .send({ post: { id: postId, name: "Forbidden update", products: [] } })
      .expect(403);
    await agents.staff!.delete(`/api/team/posts/${postId}`).expect(403);
    await agents
      .staff!.post("/api/ai/jobs")
      .send({
        operation: "background",
        params: { context: "social", prompt: "A blue background" },
      })
      .expect(403);
    expect(
      (
        await db.query<{ deleted_at: Date | null }>(
          "SELECT deleted_at FROM campaigns WHERE organization_id=$1 AND id=$2",
          [org, campaignId],
        )
      )[0]!.deleted_at,
    ).toBeNull();
  });

  test("catalog off blocks every catalog entry point, and restrictions can be reset without logging out", async () => {
    await agents
      .superadmin!.patch(`/api/team/users/${ids.staff}`)
      .send({ access: { ...restricted, canViewCatalog: false } })
      .expect(200);
    for (const endpoint of [
      "/api/products",
      "/api/products/facets",
      "/api/catalog/brands",
      "/api/catalog/refresh",
    ])
      await agents.staff!.get(endpoint).expect(403);
    await agents
      .staff!.post("/api/products/batch")
      .send({ codes: ["allowed"] })
      .expect(403);
    await agents.staff!.post("/api/catalog/refresh").expect(403);
    await agents
      .admin!.patch(`/api/team/users/${ids.staff}`)
      .send({ access: null })
      .expect(200);
    expect(
      (await agents.staff!.get("/api/products").expect(200)).body.total,
    ).toBe(4);
    await agents.staff!.get("/api/team/posts").expect(200);
  });

  test("category input is canonical and workspace validated; admins keep full access", async () => {
    const canonical = await agents
      .admin!.patch(`/api/team/users/${ids.pm}`)
      .send({
        access: { ...restricted, catalogCategoryPaths: ["  it >  computers "] },
      })
      .expect(200);
    expect(canonical.body.user.access.catalogCategoryPaths).toEqual([
      "IT > Computers",
    ]);
    await agents
      .admin!.patch(`/api/team/users/${ids.pm}`)
      .send({
        access: { ...restricted, catalogCategoryPaths: ["Unknown > Branch"] },
      })
      .expect(400);
    await agents
      .admin!.patch(`/api/team/users/${ids.pm}`)
      .send({ access: { ...restricted, canManageUsers: true } })
      .expect(400);
    await agents
      .superadmin!.patch(`/api/team/users/${ids.admin}`)
      .send({ access: { ...restricted, canViewCatalog: false } })
      .expect(200);
    expect(
      (await agents.admin!.get("/api/team/session").expect(200)).body.user
        .access,
    ).toEqual(defaultWorkspaceAccess());
  });

  test("invites store custom access and verified users can be re-enabled while SMTP is unavailable", async () => {
    const configured = jest
      .spyOn(mail, "requireConfigured")
      .mockImplementation(() => {});
    const invited = await agents
      .admin!.post("/api/team/users/invite")
      .send({
        name: "Restricted PM",
        email: `invited-${suffix}@example.test`,
        role: "pm",
        access: restricted,
      })
      .expect(201);
    expect(invited.body.user.access).toEqual(restricted);
    configured.mockRestore();
    await agents
      .admin!.patch(`/api/team/users/${ids.pm}`)
      .send({ status: "disabled" })
      .expect(200);
    const enabled = await agents
      .admin!.patch(`/api/team/users/${ids.pm}`)
      .send({ status: "active" })
      .expect(200);
    expect(enabled.body.user).toMatchObject({
      status: "active",
      emailVerified: true,
      access: restricted,
    });
  });
});
