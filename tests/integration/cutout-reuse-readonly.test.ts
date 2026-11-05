import "reflect-metadata";
import type { QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/database/database";
import {
  findReusableCutouts,
  type CutoutReuseItem,
} from "../../src/modules/ai/cutout-reuse";

const receipt = {
  cutoutValidated: true,
  cutoutValidationVersion: 1,
  annotationCleanup: true,
  annotationHandling: "editable-overlays",
};
const url = (id: string) => `/api/assets/${id}`;
describe("read-only completed cutout reuse in isolated PostgreSQL", () => {
  const db = new Database();
  afterAll(() => db.onModuleDestroy());
  async function organization() {
    return (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Cutout reuse regression',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
  }
  async function asset(
    org: string,
    {
      hash = randomUUID().replaceAll("-", "").repeat(2),
      deleted = false,
      metadata = {},
    } = {},
  ) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO assets(id,organization_id,storage_key,sha256,size,mime_type,kind,metadata,deleted_at) VALUES($1,$2,$3,$4,1,'image/png','cutout',$5,$6)",
      [
        id,
        org,
        `test-only/${id}.png`,
        hash,
        metadata,
        deleted ? new Date() : null,
      ],
    );
    return id;
  }
  async function result(
    org: string,
    source: string,
    {
      output,
      json = receipt,
      instructions = "",
      status = "completed",
    }: {
      output?: string;
      json?: object;
      instructions?: string;
      status?: string;
    } = {},
  ) {
    output ??= await asset(org);
    const id = randomUUID();
    await db.query(
      "INSERT INTO ai_results(id,organization_id,operation,cache_key,model,quality,params_json,prompt_version,source_sha256,status,output_asset_id,output_json,completed_at) VALUES($1,$2,'cutout',$3,'older-image-model','high',$4,'older-prompt-but-clean-validated',$5,$6,$7,$8,now())",
      [
        id,
        org,
        randomUUID(),
        {
          image: source,
          instructions,
          name: "Previous name",
          orientation: "portrait",
          backgroundContext: { kind: "solid", color: "#ffffff" },
        },
        "aggregate-includes-old-background",
        status,
        output,
        json,
      ],
    );
    return { id, output };
  }
  async function lookup(org: string, items: CutoutReuseItem[]) {
    // A database-level read-only transaction makes accidental writes fail too.
    return db.transaction(async (client) => {
      await client.query("SET TRANSACTION READ ONLY");
      return findReusableCutouts(
        {
          query: async <T extends QueryResultRow>(
            sql: string,
            values: readonly unknown[] = [],
          ) => (await client.query<T>(sql, [...values])).rows,
        },
        org,
        items,
      );
    });
  }

  test("batch reuses IDs, absolute IDs, aliases and equal source bytes despite changed layout/title/model", async () => {
    const org = await organization();
    const source = await asset(org, { hash: "a".repeat(64) });
    const duplicate = await asset(org, { hash: "a".repeat(64) });
    const alias = `/catalog-images/${randomUUID()}.png`;
    await db.query(
      "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3)",
      [org, alias, source],
    );
    const good = await result(org, url(source));
    const hits = await lookup(
      org,
      [
        url(source),
        `https://studio.example${url(source)}`,
        `/api/assets/legacy${alias}`,
        url(duplicate),
      ].map((image, index) => ({
        key: String(index),
        image,
        name: "New Excel name",
        orientation: "landscape",
        backgroundContext: {
          kind: "gradient",
          gradient: { from: "#000000", to: "#ff0000", angle: 90 },
        },
      })),
    );
    expect(hits.map((hit) => hit.key).sort()).toEqual(["0", "1", "2", "3"]);
    expect(
      hits.every(
        (hit) =>
          hit.resultId === good.id && hit.result.image === url(good.output),
      ),
    ).toBe(true);
  });

  test("keeps tenant/source boundaries including identical bytes in another organization", async () => {
    const org = await organization(),
      other = await organization();
    const source = await asset(org, { hash: "b".repeat(64) });
    const wrong = await asset(org, { hash: "c".repeat(64) });
    const foreign = await asset(other, { hash: "b".repeat(64) });
    await result(other, url(foreign));
    await result(org, url(wrong));
    expect(
      await lookup(org, [
        { key: "same-bytes-foreign-result", image: url(source) },
        { key: "foreign-source", image: url(foreign) },
      ]),
    ).toEqual([]);
  });

  test.each([
    ["missing receipt", {}, {}, false, "completed"],
    [
      "old validator",
      { ...receipt, cutoutValidationVersion: 0 },
      {},
      false,
      "completed",
    ],
    [
      "missing cleanup",
      { ...receipt, annotationCleanup: false },
      {},
      false,
      "completed",
    ],
    [
      "baked annotations",
      { ...receipt, annotationHandling: "baked-in" },
      {},
      false,
      "completed",
    ],
    [
      "rejected result",
      { ...receipt, cutoutRejected: true },
      {},
      false,
      "completed",
    ],
    ["rejected asset", receipt, { cutoutRejected: true }, false, "completed"],
    ["deleted asset", receipt, {}, true, "completed"],
    ["running result", receipt, {}, false, "pending"],
  ])("never reuses %s", async (_name, json, metadata, deleted, status) => {
    const org = await organization();
    const source = await asset(org);
    const output = await asset(org, {
      metadata: metadata as object,
      deleted: deleted as boolean,
    });
    await result(org, url(source), {
      output,
      json: json as object,
      status: status as string,
    });
    expect(await lookup(org, [{ key: "bad", image: url(source) }])).toEqual([]);
  });

  test("blank instructions reuse the latest correction; explicit instructions require their exact cleanup", async () => {
    const org = await organization(),
      source = await asset(org);
    const first = await result(org, url(source), {
      instructions: "Keep the cable.",
    });
    const last = await result(org, url(source), {
      instructions: "Keep every stand.",
    });
    const hits = await lookup(org, [
      { key: "latest", image: url(source) },
      {
        key: "specific",
        image: url(source),
        instructions: " Keep the cable. ",
      },
      {
        key: "different",
        image: url(source),
        instructions: "Remove the cable.",
      },
    ]);
    expect(hits.find((hit) => hit.key === "latest")?.resultId).toBe(last.id);
    expect(hits.find((hit) => hit.key === "specific")?.resultId).toBe(first.id);
    expect(hits.some((hit) => hit.key === "different")).toBe(false);
  });

  test.each(["https://catalog.example", "https://www.neptun-ks.com/images"])(
    "an exact external URL from %s can reuse existing finished work without downloading it",
    async (base) => {
      const org = await organization();
      const source = `${base}/${randomUUID()}.png`;
      const good = await result(org, source);
      expect(await lookup(org, [{ key: "external", image: source }])).toEqual([
        expect.objectContaining({ key: "external", resultId: good.id }),
      ]);
      expect(
        await lookup(org, [
          { key: "different-url", image: source + "?changed=1" },
        ]),
      ).toEqual([]);
    },
  );
});
