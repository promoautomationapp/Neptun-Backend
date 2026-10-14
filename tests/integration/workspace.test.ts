import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import express from "express";
import request from "supertest";
import type { Agent } from "supertest";
import argon2 from "argon2";
import sharp from "sharp";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { ErrorFilter } from "../../src/shared/error.filter";
import { UPLOAD_IMAGE_TYPES } from "../../src/modules/assets/image-input";
interface Saved {
  id: string;
  name: string;
  version: number;
  status: string;
  products: { code: string; image?: string }[];
  reviewComments: { id: string; fixed: boolean }[];
}
describe("persistent workspace API", () => {
  let app: INestApplication;
  let db: Database;
  let staff: Agent;
  let pm: Agent;
  let other: Agent;
  const password = "Test password 42619!";
  const suffix = randomUUID();
  const emails = [
    `staff-${suffix}@example.test`,
    `pm-${suffix}@example.test`,
    `other-${suffix}@example.test`,
  ];
  let org: string;
  let secondOrg: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.use(
      "/api/assets/uploads",
      express.raw({ type: [...UPLOAD_IMAGE_TYPES], limit: "12mb" }),
    );
    app.use(express.json({ limit: "10mb" }));
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    await app.listen(0, "127.0.0.1");
    org =
      (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          ["Test", suffix],
        )
      )[0]?.id ?? "";
    secondOrg =
      (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          ["Second", `${suffix}-second`],
        )
      )[0]?.id ?? "";
    for (const [index, email] of emails.entries()) {
      const user = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,password_hash,must_change_password) VALUES($1,$2,false) RETURNING id",
          [email, await argon2.hash(password)],
        )
      )[0];
      if (!user) throw new Error("User fixture failed.");
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role) VALUES($1,$2,$3,$4)",
        [
          index === 2 ? secondOrg : org,
          user.id,
          index === 1 ? "admin" : "editor",
          index === 1 ? "pm" : "staff",
        ],
      );
    }
    staff = request.agent(app.getHttpServer());
    pm = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    for (const [index, agent] of [staff, pm, other].entries())
      await agent
        .post("/api/team/login")
        .send({ email: emails[index], password })
        .expect(201);
  });
  afterAll(async () => {
    await app.close();
  });
  test("sessions require a valid cookie and reject untrusted mutation origins", async () => {
    await request(app.getHttpServer()).get("/api/team/campaigns").expect(401);
    await staff
      .put("/api/team/settings")
      .set("Origin", "https://untrusted.example")
      .send({ settings: {} })
      .expect(403);
    const session = await staff.get("/api/team/session").expect(200);
    expect(session.body.user.organizationId).toBe(org);
  });
  test("settings persist for another user in the organization", async () => {
    await staff
      .put("/api/team/settings")
      .send({
        expectedVersion: 0,
        settings: {
          contact: { phone: "046 828 000" },
          stores: [{ city: "Prishtinë" }],
        },
      })
      .expect(200);
    expect(
      (await pm.get("/api/team/settings")).body.settings.stores[0].city,
    ).toBe("Prishtinë");
    expect((await other.get("/api/team/settings")).body.settings).toBeNull();
  });
  test("settings save atomically and stale or versionless requests cannot overwrite teammates", async () => {
    const first = await staff.get("/api/team/settings").expect(200);
    const responses = await Promise.all([
      staff.put("/api/team/settings").send({
        settings: { ...first.body.settings, savingMode: "percentage" },
        expectedVersion: first.body.version,
      }),
      pm.put("/api/team/settings").send({
        settings: { ...first.body.settings, offerStyle: "card" },
        expectedVersion: first.body.version,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const current = await pm.get("/api/team/settings").expect(200);
    expect(current.body.version).toBe(first.body.version + 1);
    await staff
      .put("/api/team/settings")
      .send({ settings: first.body.settings })
      .expect(400);
    await staff
      .put("/api/team/settings")
      .send({
        settings: {
          ...current.body.settings,
          brochure: {
            ...current.body.settings.brochure,
            format: "missing-format",
          },
        },
        expectedVersion: current.body.version,
      })
      .expect(400);
    expect((await staff.get("/api/team/settings")).body.version).toBe(
      current.body.version,
    );
  });
  test("saves survive sessions; old versions return 409 without overwriting", async () => {
    const id = randomUUID();
    const first = await staff
      .post("/api/team/campaigns")
      .send({
        campaign: {
          id,
          name: "Golden layout",
          products: [{ code: "84067299", regular: 499, sale: 399 }],
          brochureFormat: "portrait",
          pages: { 0: { layout: "classic8" } },
          coverHeadline: "Oferta",
        },
      })
      .expect(201);
    const created = first.body.campaign as Saved;
    expect(created.version).toBe(1);
    const change = await pm
      .post("/api/team/campaigns")
      .send({ campaign: { ...created, name: "Updated" } })
      .expect(201);
    expect(change.body.campaign.version).toBe(2);
    await staff
      .post("/api/team/campaigns")
      .send({ campaign: { ...created, name: "Stale" } })
      .expect(409);
    const loaded = await staff.get(`/api/team/campaigns/${id}`).expect(200);
    expect(loaded.body.campaign.name).toBe("Updated");
    await other.get(`/api/team/campaigns/${id}`).expect(404);
    await other
      .post("/api/team/campaigns")
      .send({ campaign: { id, name: "Tenant two", products: [] } })
      .expect(201);
    expect(
      (await staff.get(`/api/team/campaigns/${id}`)).body.campaign.name,
    ).toBe("Updated");
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM document_versions WHERE organization_id=$1 AND document_id=$2",
          [org, id],
        )
      )[0]?.count,
    ).toBe("2");
  });
  test("review transitions preserve the reference behavior", async () => {
    const id = randomUUID();
    await staff
      .post("/api/team/campaigns")
      .send({ campaign: { id, name: "Review fixture", products: [] } })
      .expect(201);
    await pm
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "submit" })
      .expect(409);
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "submit" })
      .expect(201);
    const noted = await pm
      .post(`/api/team/campaigns/${id}/review`)
      .send({
        action: "comment",
        text: "Check this price",
        pageIndex: 0,
        position: { x: 25, y: 30 },
        mention: emails[0],
      })
      .expect(201);
    const campaign = noted.body.campaign as Saved;
    expect(campaign.status).toBe("changes_requested");
    const commentId = campaign.reviewComments[0]?.id;
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "submit" })
      .expect(409);
    await pm
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "fix", commentId })
      .expect(409);
    await staff
      .post(`/api/team/campaigns/${id}/review`)
      .send({ action: "reply", commentId, text: "Updated the price." })
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
    expect(
      (
        await staff
          .post(`/api/team/campaigns/${id}/review`)
          .send({ action: "reopen" })
          .expect(201)
      ).body.campaign.status,
    ).toBe("in_progress");
  });
  test("campaign sale imports persist decimal amounts and retain every snapshot field", async () => {
    const id = randomUUID();
    await staff
      .post("/api/team/campaigns")
      .send({
        campaign: {
          id,
          name: "Imported sale",
          products: [
            {
              code: "abc",
              name: "Offer",
              sale: "399,90 €",
              regular: "1.299,90",
              brochureDetails: ["Keep this exact detail"],
              brochureVariants: [
                { code: "other", color: { name: "Blue", hex: "#0011ff" } },
              ],
            },
          ],
        },
      })
      .expect(201);
    const row = (
      await db.query<{
        sale: string;
        regular: string;
        snapshot: { brochureDetails: string[] };
      }>(
        "SELECT sale,regular,snapshot FROM campaign_products WHERE organization_id=$1 AND campaign_id=$2",
        [org, id],
      )
    )[0];
    expect(row?.sale).toBe("399.90");
    expect(row?.regular).toBe("1299.90");
    expect(row?.snapshot.brochureDetails).toEqual(["Keep this exact detail"]);
  });
  test("uploads are checksummed, deduplicated and tenant scoped", async () => {
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
    ).body as { id: string; uploadUrl: string };
    await staff
      .put(intent.uploadUrl)
      .set("Content-Type", "image/png")
      .send(bytes)
      .expect(200);
    const asset = (
      await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(201)
    ).body as { assetId: string; url: string; sha256: string };
    expect(asset.sha256).toHaveLength(64);
    expect(
      (await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(201))
        .body.assetId,
    ).toBe(asset.assetId);
    const beforeSettings = await staff.get("/api/team/settings").expect(200);
    const settingsSave = await staff
      .put("/api/team/settings")
      .send({
        settings: {
          ...beforeSettings.body.settings,
          logoLibrary: [
            { id: randomUUID(), name: "Team logo", url: asset.url },
          ],
          brochure: {
            ...beforeSettings.body.settings.brochure,
            coverLogoStyle: "custom",
            coverLogoSource: asset.url,
          },
        },
        expectedVersion: beforeSettings.body.version,
      })
      .expect(200);
    expect(settingsSave.body.settings.brochure.coverLogoSource).toBe(asset.url);
    expect(
      (await pm.get("/api/team/settings")).body.settings.logoLibrary[0].url,
    ).toBe(asset.url);
    await other
      .put("/api/team/settings")
      .send({
        settings: { brandAssets: { neptun: asset.url } },
        expectedVersion: 0,
      })
      .expect(400);
    expect((await other.get("/api/team/settings")).body.version).toBe(0);
    const imageResponse = await pm.get(asset.url).expect(200);
    expect(imageResponse.headers["cache-control"]).toContain("private");
    expect(imageResponse.headers.vary).toContain("Cookie");
    await other.get(asset.url).expect(404);
    await other
      .post("/api/team/posts")
      .send({
        post: {
          id: randomUUID(),
          name: "Leaked",
          products: [{ code: "1", image: asset.url }],
        },
      })
      .expect(400);
    const id = randomUUID();
    await staff
      .post("/api/team/posts")
      .send({
        post: {
          id,
          name: "Embedded",
          products: [
            {
              code: "1",
              image: `data:image/png;base64,${bytes.toString("base64")}`,
            },
          ],
        },
      })
      .expect(201);
    expect(
      (await pm.get(`/api/team/posts/${id}`)).body.post.products[0].image,
    ).toBe(asset.url);
  });
  test.each(["image/svg+xml", "image/avif"])(
    "%s uploads and embedded document images store the same transparent PNG",
    async (mimeType) => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>alert("not stored")</script><rect x="4" y="4" width="8" height="8" fill="#ef4023"/></svg>',
      );
      const bytes =
        mimeType === "image/avif"
          ? await sharp(svg).avif({ lossless: true }).toBuffer()
          : svg;
      const intent = (
        await staff
          .post("/api/assets/uploads")
          .send({ size: bytes.length, mimeType })
          .expect(201)
      ).body as { id: string; uploadUrl: string };
      await staff
        .put(intent.uploadUrl)
        .set("Content-Type", mimeType)
        .send(bytes)
        .expect(200);
      const asset = (
        await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(201)
      ).body as { assetId: string; url: string; sha256: string };
      const stored = (
        await db.query<{
          mime_type: string;
          storage_key: string;
          width: number;
          height: number;
        }>(
          "SELECT mime_type,storage_key,width,height FROM assets WHERE organization_id=$1 AND id=$2",
          [org, asset.assetId],
        )
      )[0];
      expect(stored).toMatchObject({
        mime_type: "image/png",
        width: 24,
        height: 16,
      });
      expect(stored?.storage_key).toMatch(/\.png$/);
      const image = await pm.get(asset.url).expect(200);
      expect(image.headers["content-type"]).toContain("image/png");
      const { data, info } = await sharp(image.body as Buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect(data[3]).toBe(0);
      expect(data[(8 * info.width + 8) * info.channels + 3]).toBe(255);
      await other.get(asset.url).expect(404);

      const embedded =
        mimeType === "image/svg+xml"
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.toString())}`
          : `data:image/avif;base64,${bytes.toString("base64")}`;
      const id = randomUUID();
      await staff
        .post("/api/team/posts")
        .send({
          post: {
            id,
            name: "Transparent uploaded artwork",
            coverLogoSource: embedded,
            products: [
              {
                code: "1",
                bundleProducts: [
                  { code: "2", screenArtwork: { image: embedded } },
                ],
              },
            ],
          },
        })
        .expect(201);
      const saved = (await pm.get(`/api/team/posts/${id}`).expect(200)).body
        .post;
      expect(saved.coverLogoSource).toBe(asset.url);
      expect(saved.products[0].bundleProducts[0].screenArtwork.image).toBe(
        asset.url,
      );
    },
  );
  test("soft deleted documents remain in version history", async () => {
    const id = randomUUID();
    await staff
      .post("/api/team/posts")
      .send({ post: { id, name: "Retained", products: [] } })
      .expect(201);
    await staff.delete(`/api/team/posts/${id}?version=1`).expect(200);
    await pm.get(`/api/team/posts/${id}`).expect(404);
    expect(
      (
        await db.query<{ deleted_at: Date }>(
          "SELECT deleted_at FROM social_posts WHERE organization_id=$1 AND id=$2",
          [org, id],
        )
      )[0]?.deleted_at,
    ).toBeInstanceOf(Date);
  });
  test("simultaneous upload confirmations return one asset and one variant job", async () => {
    const bytes = await sharp({
      create: { width: 21, height: 11, channels: 4, background: "#532456" },
    })
      .png()
      .toBuffer();
    const intent = (
      await staff
        .post("/api/assets/uploads")
        .send({ size: bytes.length, mimeType: "image/png" })
        .expect(201)
    ).body as { id: string; uploadUrl: string };
    await staff
      .put(intent.uploadUrl)
      .set("Content-Type", "image/png")
      .send(bytes)
      .expect(200);
    const responses = await Promise.all(
      Array.from({ length: 24 }, () =>
        staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(201),
      ),
    );
    const ids = new Set(responses.map((x) => String(x.body.assetId)));
    expect(ids.size).toBe(1);
    for (const response of responses)
      expect(response.body.sha256).toHaveLength(64);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM job_outbox WHERE organization_id=$1 AND queue='asset-variants' AND payload->>'assetId'=$2",
          [org, [...ids][0]],
        )
      )[0]?.count,
    ).toBe("1");
    await staff
      .put(intent.uploadUrl)
      .set("Content-Type", "image/png")
      .send(bytes)
      .expect(400);
  });
  test("upload ownership, expiry, size and actual image MIME are enforced", async () => {
    await staff
      .post("/api/assets/uploads")
      .send({ size: 13 * 1024 * 1024, mimeType: "image/png" })
      .expect(400);
    await staff
      .post("/api/assets/uploads")
      .send({ size: 20, mimeType: "text/html" })
      .expect(400);
    const bytes = await sharp({
      create: { width: 22, height: 12, channels: 4, background: "#652456" },
    })
      .png()
      .toBuffer();
    const intent = (
      await staff
        .post("/api/assets/uploads")
        .send({ size: bytes.length, mimeType: "image/jpeg" })
        .expect(201)
    ).body as { id: string; uploadUrl: string };
    await other
      .put(intent.uploadUrl)
      .set("Content-Type", "image/jpeg")
      .send(bytes)
      .expect(400);
    await other.post(`/api/assets/uploads/${intent.id}/confirm`).expect(404);
    await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(400);
    await staff
      .put(intent.uploadUrl)
      .set("Content-Type", "image/jpeg")
      .send(bytes)
      .expect(200);
    await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(400);
    await db.query(
      "UPDATE upload_intents SET expires_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2",
      [org, intent.id],
    );
    await staff
      .put(intent.uploadUrl)
      .set("Content-Type", "image/jpeg")
      .send(bytes)
      .expect(400);
    await staff.post(`/api/assets/uploads/${intent.id}/confirm`).expect(400);
  });
  test("first-login password change is required and invalidates all old sessions", async () => {
    const userId = (
      await db.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
        emails[0],
      ])
    )[0]?.id;
    await db.query("UPDATE users SET must_change_password=true WHERE id=$1", [
      userId,
    ]);
    await staff.get("/api/team/campaigns").expect(403);
    expect(
      (await staff.get("/api/team/session").expect(200)).body.user
        .mustChangePassword,
    ).toBe(true);
    await staff
      .post("/api/team/change-password")
      .send({
        currentPassword: password,
        password: "Changed test password 48126!",
      })
      .expect(201);
    await pm.get("/api/team/campaigns").expect(200);
    await staff.get("/api/team/campaigns").expect(401);
    await staff
      .post("/api/team/login")
      .send({ email: emails[0], password })
      .expect(401);
    expect(
      (
        await staff
          .post("/api/team/login")
          .send({ email: emails[0], password: "Changed test password 48126!" })
          .expect(201)
      ).body.user.mustChangePassword,
    ).toBe(false);
  });
});
