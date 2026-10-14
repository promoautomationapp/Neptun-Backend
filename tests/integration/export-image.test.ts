import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Agent } from "supertest";
import argon2 from "argon2";
import sharp from "sharp";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { ErrorFilter } from "../../src/shared/error.filter";
import { env } from "../../src/config/environment";
import { EXPORT_IMAGE_DOWNLOADER } from "../../src/modules/assets/export-image";
import type { ExportImageDownloader } from "../../src/modules/assets/export-image";

describe("authenticated brochure image export proxy", () => {
  let app: INestApplication;
  let db: Database;
  let staff: Agent;
  let other: Agent;
  let forced: Agent;
  let organizationId: string;
  let secondOrganizationId: string;
  let png: Buffer;
  const password = "Export test password 62839!";
  const suffix = randomUUID();
  const download = jest.fn<
    ReturnType<ExportImageDownloader>,
    Parameters<ExportImageDownloader>
  >();
  const source = "https://www.neptun-ks.com/photos/export-test.png";
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXPORT_IMAGE_DOWNLOADER)
      .useValue(download)
      .compile();
    app = module.createNestApplication();
    app.enableCors({
      origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
      credentials: true,
    });
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    await app.listen(0, "127.0.0.1");
    organizationId =
      (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          ["Export test", `${suffix}-export`],
        )
      )[0]?.id ?? "";
    secondOrganizationId =
      (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          ["Export other", `${suffix}-other`],
        )
      )[0]?.id ?? "";
    [staff, other, forced] = [
      request.agent(app.getHttpServer()),
      request.agent(app.getHttpServer()),
      request.agent(app.getHttpServer()),
    ];
    for (const [index, agent] of [staff, other, forced].entries()) {
      const email = `${suffix}-${index}@export.example.test`;
      const user = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,password_hash,must_change_password) VALUES($1,$2,$3) RETURNING id",
          [email, await argon2.hash(password), index === 2],
        )
      )[0];
      if (!user) throw new Error("User fixture failed.");
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role) VALUES($1,$2,'editor','staff')",
        [index === 1 ? secondOrganizationId : organizationId, user.id],
      );
      await agent.post("/api/team/login").send({ email, password }).expect(201);
    }
    png = await sharp({
      create: { width: 200, height: 150, channels: 4, background: "#234567" },
    })
      .png()
      .toBuffer();
  });
  beforeEach(() =>
    download
      .mockReset()
      .mockImplementation(async (url) => ({
        bytes: png,
        mimeType: "image/png",
        url,
      })),
  );
  afterAll(async () => app.close());
  test("requires a session and respects the forced password gate", async () => {
    await request(app.getHttpServer())
      .get("/api/export-image")
      .query({ url: source })
      .expect(401);
    await forced.get("/api/export-image").query({ url: source }).expect(403);
    expect(download).not.toHaveBeenCalled();
  });
  test("simultaneous exports ingest one owned image and return original binary with private CORS headers", async () => {
    const origin = env.CORS_ORIGIN.split(",")[0]?.trim() ?? "";
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        staff
          .get("/api/export-image")
          .query({ url: source })
          .set("Origin", origin)
          .expect(200),
      ),
    );
    expect(download).toHaveBeenCalledTimes(1);
    for (const response of results) {
      expect(response.body).toEqual(png);
      expect(response.headers["content-type"]).toMatch(/^image\/png/);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.vary).toContain("Cookie");
      expect(response.headers.vary).toContain("Origin");
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cross-origin-resource-policy"]).toBe(
        "cross-origin",
      );
      expect(response.headers.location).toBeUndefined();
    }
    const aliases = await db.query<{ asset_id: string }>(
      "SELECT asset_id FROM asset_aliases WHERE organization_id=$1 AND source_path=$2",
      [organizationId, source],
    );
    expect(aliases).toHaveLength(1);
    await staff.get("/api/export-image").query({ url: source }).expect(200);
    expect(download).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query("SELECT id FROM ai_jobs WHERE organization_id=$1", [
          organizationId,
        ])
      ).length,
    ).toBe(0);
  });
  test("another organization receives its own asset while identical content aliases deduplicate within an owner", async () => {
    await other.get("/api/export-image").query({ url: source }).expect(200);
    await staff
      .get("/api/export-image")
      .query({ url: "https://neptun-ks.com/photos/same-export-content.png" })
      .expect(200);
    expect(download).toHaveBeenCalledTimes(2);
    const rows = await db.query<{ organization_id: string; asset_id: string }>(
      "SELECT organization_id,asset_id FROM asset_aliases WHERE source_path IN ($1,$2) AND organization_id=ANY($3::uuid[])",
      [
        source,
        "https://neptun-ks.com/photos/same-export-content.png",
        [organizationId, secondOrganizationId],
      ],
    );
    const firstIds = new Set(
      rows
        .filter((row) => row.organization_id === organizationId)
        .map((row) => row.asset_id),
    );
    expect(firstIds.size).toBe(1);
    expect(
      firstIds.has(
        rows.find((row) => row.organization_id === secondOrganizationId)
          ?.asset_id ?? "",
      ),
    ).toBe(false);
  });
  test("unapproved hosts, private sources, credentials and malformed requests stop before downloading", async () => {
    for (const url of [
      "http://www.neptun-ks.com/a.png",
      "https://images.neptun-ks.com/a.png",
      "https://neptun-ks.com.evil.example/a.png",
      "https://169.254.169.254/a.png",
      "https://name:secret@www.neptun-ks.com/a.png",
      "https://www.neptun-ks.com:8443/a.png",
      "/api/assets/private",
    ]) {
      await staff.get("/api/export-image").query({ url }).expect(400);
    }
    await staff.get("/api/export-image").expect(400);
    expect(download).not.toHaveBeenCalled();
  });
  test("untrusted origins do not receive credentialed CORS permission", async () => {
    const result = await staff
      .get("/api/export-image")
      .query({ url: source })
      .set("Origin", "https://untrusted.example")
      .expect(200);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });
  test("unsupported MIME, invalid bytes, oversized downloads and off-host redirects cannot create a cached asset", async () => {
    const failures = [
      { bytes: png, mimeType: "image/svg+xml", url: source },
      {
        bytes: Buffer.from("not an image"),
        mimeType: "image/png",
        url: source,
      },
      { bytes: Buffer.alloc(12_000_001), mimeType: "image/png", url: source },
      {
        bytes: png,
        mimeType: "image/png",
        url: "https://other-public.example/photo.png",
      },
    ];
    for (const [index, failure] of failures.entries()) {
      const url = `https://www.neptun-ks.com/photos/invalid-${index}.png`;
      download.mockResolvedValueOnce(failure);
      await staff.get("/api/export-image").query({ url }).expect(502);
      expect(
        await db.query(
          "SELECT asset_id FROM asset_aliases WHERE organization_id=$1 AND source_path=$2",
          [organizationId, url],
        ),
      ).toHaveLength(0);
    }
  });
});
