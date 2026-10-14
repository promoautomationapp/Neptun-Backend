import "reflect-metadata";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import request from "supertest";
import sharp from "sharp";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import type { Actor } from "../../src/modules/auth/domain/actor";
import { ingestAsset, assetUrl } from "../../src/modules/assets/asset-ingest";
import { DocumentsRepository } from "../../src/modules/documents/documents.repository";
import { campaignSchema } from "../../src/modules/documents/domain/document";
import type { Campaign } from "../../src/modules/documents/domain/document";
import { STORAGE } from "../../src/modules/storage/storage.port";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import type { JsonObject } from "../../src/shared/json";
import { brochureFixture } from "../fixtures/brochure";

describe("complete brochure persistence", () => {
  let app: INestApplication;
  let db: Database;
  let storage: StoragePort;
  let documents: DocumentsRepository;
  let actor: Actor;
  let imageId: string;
  let imageData: string;
  const suffix = randomUUID();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    db = app.get(Database);
    storage = app.get(STORAGE);
    documents = app.get(DocumentsRepository);
    const organization = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
        ["Brochure regression", `brochure-${suffix}`],
      )
    )[0];
    const user = (
      await db.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,must_change_password) VALUES($1,'unused-test-hash',false) RETURNING id",
        [`brochure-${suffix}@example.test`],
      )
    )[0];
    if (!organization || !user)
      throw new Error("Brochure test fixture failed.");
    actor = {
      organizationId: organization.id,
      userId: user.id,
      email: `brochure-${suffix}@example.test`,
      role: "editor",
      reviewRole: "staff",
      mustChangePassword: false,
    };
    const bytes = await sharp({
      create: { width: 32, height: 24, channels: 4, background: "#458ad1" },
    })
      .png()
      .toBuffer();
    imageId = (
      await ingestAsset(db, storage, actor.organizationId, bytes, "image/png", {
        enqueueVariants: false,
      })
    ).id;
    imageData = `data:image/png;base64,${bytes.toString("base64")}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  test("a full campaign round-trips through JSONB, projections and immutable versions with recursive asset deduplication", async () => {
    const id = randomUUID();
    const saved = (await documents.save(
      actor,
      "campaign",
      campaignSchema.parse(brochureFixture(id, imageData)),
    )) as Campaign;
    const expected = campaignSchema.parse(
      brochureFixture(id, assetUrl(imageId)),
    );
    expect(saved).toMatchObject(expected);
    expect(await documents.get(actor.organizationId, "campaign", id)).toEqual(
      saved,
    );
    const projection = (
      await db.query<{ layout: JsonObject; version: number }>(
        "SELECT layout,version FROM brochures WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      )
    )[0];
    expect(projection?.layout).toEqual(saved);
    expect(projection?.version).toBe(1);
    const products = await db.query<{
      snapshot: JsonObject;
      sale: string;
      regular: string;
    }>(
      "SELECT snapshot,sale,regular FROM campaign_products WHERE organization_id=$1 AND campaign_id=$2 ORDER BY position",
      [actor.organizationId, id],
    );
    expect(products.map((row) => row.snapshot)).toEqual(saved.products);
    expect(Number(products[0]?.sale)).toBe(599);
    expect(Number(products[0]?.regular)).toBe(899);
    const pages = await db.query<{ page_key: string; layout: JsonObject }>(
      "SELECT page_key,layout FROM brochure_pages WHERE organization_id=$1 AND brochure_id=$2",
      [actor.organizationId, id],
    );
    expect(
      Object.fromEntries(pages.map((row) => [row.page_key, row.layout])),
    ).toEqual(saved.pages);
    const versions = await db.query<{ snapshot: JsonObject }>(
      "SELECT snapshot FROM document_versions WHERE organization_id=$1 AND document_id=$2",
      [actor.organizationId, id],
    );
    expect(versions.map((row) => row.snapshot)).toEqual([saved]);
    const assets = await db.query<{ count: string }>(
      "SELECT count(*) count FROM assets WHERE organization_id=$1",
      [actor.organizationId],
    );
    expect(assets[0]?.count).toBe("1");
  });

  test("Excel-only offers retain missing catalog identity, nullable regular price, search provenance and manual edits", async () => {
    const id = randomUUID();
    const input = campaignSchema.parse({
      id,
      name: "Excel-only brochure",
      products: [
        {
          code: "NEW-OVEN",
          name: "Beko BBIE123",
          brand: "BEKO",
          source: "import",
          catalogMissing: true,
          missingCatalogCodes: ["NEW-OVEN"],
          regular: null,
          sale: 299,
          image: imageData,
          brochureDetails: ["72 L", "Grill"],
          specs: { Power: "2400 W" },
          excelSource: {
            row: 8,
            cells: {
              Code: "NEW-OVEN",
              Name: "Beko BBIE123",
              Price: "299",
              Power: "2400 W",
            },
          },
          imageSearch: {
            status: "found",
            requestId: "search-1",
            requestKey: "identity",
            sourceUrl: "https://manufacturer.example/products/BBIE123",
            imageUrl: "https://manufacturer.example/images/BBIE123.png",
            matchedName: "Beko BBIE123",
          },
        },
      ],
    });
    const saved = (await documents.save(actor, "campaign", input)) as Campaign;
    expect(saved.products[0]).toMatchObject({
      ...input.products[0],
      image: assetUrl(imageId),
    });
    const projected = (
      await db.query<{
        regular: string | null;
        sale: string;
        snapshot: JsonObject;
      }>(
        "SELECT regular,sale,snapshot FROM campaign_products WHERE organization_id=$1 AND campaign_id=$2",
        [actor.organizationId, id],
      )
    )[0];
    expect(projected?.regular).toBeNull();
    expect(Number(projected?.sale)).toBe(299);
    expect(projected?.snapshot).toEqual(saved.products[0]);
    const edited = structuredClone(saved);
    const product = edited.products[0];
    if (!product) throw new Error("Missing Excel offer fixture.");
    product.name = "Edited oven name";
    product.brochureDetails = ["Updated detail"];
    product.sale = 279;
    product.image = assetUrl(imageId);
    delete product.imageSearch;
    const current = (await documents.save(
      actor,
      "campaign",
      edited,
    )) as Campaign;
    expect(await documents.get(actor.organizationId, "campaign", id)).toEqual(
      current,
    );
    expect(current.products[0]).toMatchObject({
      name: "Edited oven name",
      brochureDetails: ["Updated detail"],
      sale: 279,
      regular: null,
      catalogMissing: true,
      image: assetUrl(imageId),
      excelSource: input.products[0]?.excelSource,
    });
    expect(current.products[0]?.imageSearch).toBeUndefined();
    const versions = await db.query<{ snapshot: JsonObject }>(
      "SELECT snapshot FROM document_versions WHERE organization_id=$1 AND document_id=$2 ORDER BY version",
      [actor.organizationId, id],
    );
    expect(versions.map((row) => row.snapshot)).toEqual([saved, current]);
  });

  test("four edits, four undo saves and four redo saves preserve artwork while advancing the current optimistic version", async () => {
    const id = randomUUID();
    let current = (await documents.save(
      actor,
      "campaign",
      campaignSchema.parse(brochureFixture(id, assetUrl(imageId))),
    )) as Campaign;
    const states = [structuredClone(current)];
    for (let index = 0; index < 4; index++) {
      const edited = structuredClone(current);
      edited.brochureFormat =
        ["a4", "square1080", "landscape1920x1080", "story1080x1920"][index] ??
        "neptun1080x1350";
      edited.storeFooterHiddenElements = index % 2 ? [] : ["service"];
      edited.pageArtworks = {
        ...(edited.pageArtworks as JsonObject),
        [`edit-${index}`]: [
          {
            image: assetUrl(imageId),
            x: 10 + index,
            y: 12,
            width: 14 + index,
            height: 8,
          },
        ],
      };
      current = (await documents.save(actor, "campaign", edited)) as Campaign;
      states.push(structuredClone(current));
    }
    for (const index of [3, 2, 1, 0, 1, 2, 3, 4]) {
      const state = states[index];
      if (!state) throw new Error("Missing undo fixture.");
      const priorVersion = current.version ?? 0;
      current = (await documents.save(actor, "campaign", {
        ...structuredClone(state),
        version: priorVersion,
      })) as Campaign;
      expect(current.version).toBe(priorVersion + 1);
      for (const field of [
        "products",
        "pages",
        "pageArtworks",
        "brochureFormat",
        "storeFooterHiddenElements",
        "storeFooterElementPlacements",
      ])
        expect(current[field]).toEqual(state[field]);
    }
    expect(current.version).toBe(13);
    const stale = states[0];
    if (!stale) throw new Error("Missing stale fixture.");
    await expect(
      documents.save(actor, "campaign", stale),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await documents.get(actor.organizationId, "campaign", id)).toEqual(
      current,
    );
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM document_versions WHERE organization_id=$1 AND document_id=$2",
          [actor.organizationId, id],
        )
      )[0]?.count,
    ).toBe("13");
  });

  test("foreign UUIDs and deleted legacy aliases in nested bundle wallpapers are rejected before document persistence", async () => {
    const id = randomUUID();
    const input = (image: string) =>
      campaignSchema.parse({
        id,
        name: "Unavailable nested artwork",
        products: [
          {
            code: "bundle",
            bundleProducts: [{ code: "tv", screenArtwork: { image } }],
          },
        ],
      });
    await expect(
      documents.save(actor, "campaign", input(assetUrl(randomUUID()))),
    ).rejects.toBeInstanceOf(BadRequestException);
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#fd3400" },
    })
      .png()
      .toBuffer();
    const deleted = await ingestAsset(
      db,
      storage,
      actor.organizationId,
      bytes,
      "image/png",
      { enqueueVariants: false },
    );
    await db.query(
      "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3)",
      [actor.organizationId, "/assets/deleted-brochure.png", deleted.id],
    );
    await db.query(
      "UPDATE assets SET deleted_at=now() WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, deleted.id],
    );
    await expect(
      documents.save(actor, "campaign", input("/assets/deleted-brochure.png")),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM campaigns WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      )[0]?.count,
    ).toBe("0");
  });

  test("all eight public brochure font routes return the exact native reference bytes without a session", async () => {
    const organization = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Native font fixture','neptun') ON CONFLICT(slug) DO UPDATE SET name=organizations.name RETURNING id",
      )
    )[0];
    if (!organization) throw new Error("Font organization fixture failed.");
    const sourceRoot =
      process.env.BROCHURE_REFERENCE_DIR ??
      resolve(process.cwd(), "../neptun-campaign-studio");
    for (const file of [
      "SkolaSans-Light.otf",
      "SkolaSans-Regular.otf",
      "SkolaSans-Medium.otf",
      "SkolaSans-Bold.otf",
      "SkolaSans-Black.otf",
      "TSTAR-Regular.ttf",
      "TSTAR-Bold.ttf",
      "TSTAR-Headline.ttf",
    ]) {
      const bytes = await readFile(
        resolve(sourceRoot, "public/fonts/brochure", file),
      );
      const mime = file.endsWith(".otf") ? "font/otf" : "font/ttf";
      const asset = await ingestAsset(
        db,
        storage,
        organization.id,
        bytes,
        mime,
        { kind: "design", enqueueVariants: false },
      );
      await db.query(
        "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO UPDATE SET asset_id=EXCLUDED.asset_id",
        [organization.id, `/fonts/brochure/${file}`, asset.id],
      );
      const response = await request(app.getHttpServer())
        .get(`/api/assets/app/fonts/brochure/${file}`)
        .buffer(true)
        .parse((incoming, done) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(response.headers["content-type"]).toContain(mime);
      expect(
        createHash("sha256")
          .update(response.body as Buffer)
          .digest("hex"),
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    await request(app.getHttpServer())
      .get("/api/assets/app/fonts/brochure/NotAReferenceFont.ttf")
      .expect(404);
  });
});
