import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { env } from "../../src/config/environment";
import { Database } from "../../src/database/database";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import { DocumentAssets } from "../../src/modules/assets/document-assets";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import type { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
import type { Actor } from "../../src/modules/auth/domain/actor";
import type { JsonObject } from "../../src/shared/json";
import {
  guardCutoutCooldown,
  searchReuseHistory,
  reusableScreenGeometry,
} from "../../src/modules/ai/ai-reuse-policy";

const input = {
  code: "TEST-8400999",
  name: "Example Model X200 Black",
  model: "X200",
  brand: "Example",
  details: ["128GB"],
  variants: ["black"],
};
const receipt = {
  cutoutValidated: true,
  cutoutValidationVersion: 1,
  annotationCleanup: true,
  annotationHandling: "editable-overlays",
};
const validationError =
  "The photo background could not be removed completely. Your original photo is unchanged. Try again or describe what needs fixing.";
const url = (id: string) => `/api/assets/${id}`;
describe("durable fourteen-day AI negative reuse without provider calls", () => {
  const db = new Database();
  const storage = { put: jest.fn(), read: jest.fn(), exists: jest.fn() };
  const repo = new AiRepository(
    db,
    new DocumentAssets(db, storage as unknown as StoragePort),
    {} as LifestyleRepository,
  );
  afterAll(() => db.onModuleDestroy());
  async function organization() {
    return (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Negative AI cache regression',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
  }
  function actor(org: string): Actor {
    return {
      organizationId: org,
      userId: randomUUID(),
      email: "local-test@example.test",
      role: "editor",
      reviewRole: "staff",
      accountRole: "staff",
      mustChangePassword: false,
    };
  }
  async function asset(
    org: string,
    hash = randomUUID().replaceAll("-", "").repeat(2),
  ) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO assets(id,organization_id,storage_key,sha256,size,mime_type) VALUES($1,$2,$3,$4,1,'image/png')",
      [id, org, `test-only/${id}.png`, hash],
    );
    return id;
  }
  async function result(
    org: string,
    operation: string,
    params: JsonObject,
    json: JsonObject,
    {
      days = 7,
      status = "completed",
      output,
    }: { days?: number; status?: string; output?: string } = {},
  ) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO ai_results(id,organization_id,operation,cache_key,model,prompt_version,params_json,status,output_json,output_asset_id,completed_at) VALUES($1,$2,$3,$4,'test-old-model','test-old-prompt',$5,$6,$7,$8,now()-make_interval(secs=>$9))",
      [
        id,
        org,
        operation,
        randomUUID(),
        params,
        status,
        json,
        output ?? null,
        Math.round(days * 86400),
      ],
    );
    return id;
  }
  async function failedCutout(
    org: string,
    image: string,
    {
      days = 7,
      billed = true,
      message = validationError,
      instructions = "",
    } = {},
  ) {
    const id = await result(
      org,
      "cutout",
      { image, instructions },
      {},
      { days, status: "failed" },
    );
    const job = randomUUID();
    await db.query(
      "INSERT INTO ai_jobs(id,organization_id,result_id,cache_key,payload,status,last_error,finished_at) VALUES($1,$2,$3,$4,'{}','failed',$5,now()-make_interval(secs=>$6))",
      [job, org, id, randomUUID(), message, Math.round(days * 86400)],
    );
    if (billed)
      await db.query(
        "INSERT INTO ai_usage(organization_id,job_id,operation,model,cost_usd,month) VALUES($1,$2,'cutout','test-model',0.05,'2026-11')",
        [org, job],
      );
    return id;
  }
  test("a normalized missing image is reused next week even when retry/regenerate changes", async () => {
    const org = await organization();
    const id = await result(org, "product_image_search", input, {
      found: false,
      reason: "No exact photo available.",
      searchOutcome: "not_found",
    });
    const ticket = await repo.enqueue(actor(org), {
      operation: "product_image_search",
      params: {
        ...input,
        code: "test8400999",
        name: "Example MODEL X200 Black",
        category: "another category",
        retry: true,
      },
      regenerate: true,
      commandId: randomUUID(),
    });
    expect(ticket).toMatchObject({
      cached: true,
      status: "succeeded",
      resultId: id,
      result: {
        found: false,
        negativeCached: true,
        searchOutcome: "not_found",
        cooldownUntil: expect.any(String),
      },
    });
    expect(
      (await db.query("SELECT id FROM ai_jobs WHERE organization_id=$1", [org]))
        .length,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT id FROM ai_usage WHERE organization_id=$1", [
          org,
        ])
      ).length,
    ).toBe(0);
    expect(storage.put).not.toHaveBeenCalled();
  });
  test("fourteen-day expiry, changed exact model, changed source and another tenant do not inherit a no-match", async () => {
    const org = await organization(),
      other = await organization();
    await result(
      org,
      "product_image_search",
      { ...input, sourceUrl: "https://catalog.example/original" },
      { found: false, searchOutcome: "not_found" },
    );
    expect(
      (
        await searchReuseHistory(db, org, {
          ...input,
          model: "X201",
          sourceUrl: "https://catalog.example/original",
        })
      ).negative,
    ).toBeUndefined();
    expect(
      (
        await searchReuseHistory(db, org, {
          ...input,
          sourceUrl: "https://catalog.example/new",
        })
      ).negative,
    ).toBeUndefined();
    expect(
      (
        await searchReuseHistory(db, other, {
          ...input,
          sourceUrl: "https://catalog.example/original",
        })
      ).negative,
    ).toBeUndefined();
    const expired = { ...input, code: "expired-product" };
    await result(
      org,
      "product_image_search",
      expired,
      { found: false, searchOutcome: "not_found" },
      { days: 15 },
    );
    expect(
      (await searchReuseHistory(db, org, expired)).negative,
    ).toBeUndefined();
  });
  test("an available exact successful photo wins over a newer no-match; deleted photos do not", async () => {
    const org = await organization(),
      output = await asset(org);
    const success = await result(
      org,
      "product_image_search",
      input,
      { found: true },
      { days: 30, output },
    );
    await result(
      org,
      "product_image_search",
      input,
      { found: false, searchOutcome: "not_found" },
      { days: 2 },
    );
    expect((await searchReuseHistory(db, org, input)).success?.id).toBe(
      success,
    );
    await db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [output]);
    expect((await searchReuseHistory(db, org, input)).negative).toBeDefined();
  });
  test("transient download failures are never fourteen-day missing results", async () => {
    const org = await organization();
    await result(
      org,
      "product_image_search",
      input,
      {
        found: false,
        reason:
          "The exact photo could not be safely downloaded. Upload your own image.",
      },
      { days: 0 },
    );
    await expect(searchReuseHistory(db, org, input)).rejects.toMatchObject({
      response: {
        code: "AI_SEARCH_UNAVAILABLE",
        retryable: true,
        retryAfterSeconds: expect.any(Number),
      },
    });
    await db.query(
      "UPDATE ai_results SET completed_at=now()-interval '2 minutes' WHERE organization_id=$1",
      [org],
    );
    const history = await searchReuseHistory(db, org, input);
    expect(history.negative).toBeUndefined();
    expect(history.transient).toBeDefined();
  });
  test("a billed invalid cutout blocks ordinary requests by source bytes despite changed page/title", async () => {
    const org = await organization(),
      source = await asset(org, "a".repeat(64)),
      duplicate = await asset(org, "a".repeat(64));
    const failed = await failedCutout(org, url(source));
    await expect(
      repo.enqueue(actor(org), {
        operation: "cutout",
        params: {
          image: url(duplicate),
          name: "New Excel title",
          orientation: "portrait",
          backgroundContext: { kind: "solid", color: "#ff0000" },
        },
        regenerate: false,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "AI_CUTOUT_COOLDOWN",
        resultId: failed,
        retryAfterSeconds: expect.any(Number),
        cooldownUntil: expect.any(String),
      },
    });
    expect(
      (await db.query("SELECT id FROM ai_jobs WHERE organization_id=$1", [org]))
        .length,
    ).toBe(1);
    // Deliberate retry bypasses this cooldown, reaching the test's disabled provider configuration.
    await expect(
      repo.enqueue(actor(org), {
        operation: "cutout",
        params: { image: url(source) },
        regenerate: true,
        commandId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
  test("cutout failure cooldown excludes another source/tenant, expiry, and unbilled infrastructure errors", async () => {
    const org = await organization(),
      other = await organization(),
      source = await asset(org),
      wrong = await asset(org);
    await failedCutout(org, url(source));
    await expect(
      guardCutoutCooldown(db, org, { image: url(wrong) }),
    ).resolves.toBeUndefined();
    await expect(
      guardCutoutCooldown(db, other, { image: url(source) }),
    ).resolves.toBeUndefined();
    await expect(
      guardCutoutCooldown(db, org, {
        image: url(source),
        instructions: "Keep the complete cable.",
      }),
    ).resolves.toBeUndefined();
    const expired = await asset(org),
      unavailable = await asset(org),
      unbilled = await asset(org);
    await failedCutout(org, url(expired), { days: 15 });
    await failedCutout(org, url(unavailable), {
      message: "Source temporarily unavailable.",
    });
    await failedCutout(org, url(unbilled), { billed: false });
    for (const image of [expired, unavailable, unbilled])
      await expect(
        guardCutoutCooldown(db, org, { image: url(image) }),
      ).resolves.toBeUndefined();
  });
  test("reset invalidation never masquerades as a billed background-validation failure", async () => {
    const org = await organization(),
      source = await asset(org);
    const id = await failedCutout(org, url(source));
    await db.query("UPDATE ai_results SET output_json=$2 WHERE id=$1", [
      id,
      { cutoutInvalidated: true, failureCode: "CUTOUT_INVALID" },
    ]);
    await expect(
      guardCutoutCooldown(db, org, { image: url(source) }),
    ).resolves.toBeUndefined();
  });
  test("simultaneous ordinary cutouts share one job across changed page, title and orientation", async () => {
    const org = await organization(),
      source = await asset(org),
      userId = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",
      [userId, `${userId}@example.test`],
    );
    const person = { ...actor(org), userId };
    const key = env.OPENAI_API_KEY;
    env.OPENAI_API_KEY = "test-placeholder-no-provider-will-run";
    try {
      const tickets = await Promise.all([
        repo.enqueue(person, {
          operation: "cutout",
          params: {
            image: url(source),
            name: "First title",
            orientation: "landscape",
            backgroundContext: { kind: "solid", color: "#ffffff" },
          },
          regenerate: false,
        }),
        repo.enqueue(person, {
          operation: "cutout",
          params: {
            image: url(source),
            name: "Other Excel title",
            orientation: "portrait",
            backgroundContext: { kind: "solid", color: "#000000" },
          },
          regenerate: false,
        }),
      ]);
      expect(new Set(tickets.map((ticket) => ticket.jobId)).size).toBe(1);
      expect(tickets.map((ticket) => ticket.cached).sort()).toEqual([
        false,
        true,
      ]);
      expect(
        (
          await db.query("SELECT id FROM ai_jobs WHERE organization_id=$1", [
            org,
          ])
        ).length,
      ).toBe(1);
      expect(
        (
          await db.query("SELECT id FROM ai_usage WHERE organization_id=$1", [
            org,
          ])
        ).length,
      ).toBe(0);
    } finally {
      env.OPENAI_API_KEY = key;
    }
  });
  test("a clean validated cutout wins over a failed attempt without another job", async () => {
    const org = await organization(),
      source = await asset(org),
      output = await asset(org);
    await failedCutout(org, url(source));
    const good = await result(
      org,
      "cutout",
      { image: url(source), instructions: "Keep every leg." },
      receipt,
      { output },
    );
    expect(
      await repo.enqueue(actor(org), {
        operation: "cutout",
        params: { image: url(source), name: "Different name" },
        regenerate: false,
      }),
    ).toMatchObject({
      cached: true,
      resultId: good,
      result: { image: url(output), cutoutValidated: true },
    });
    expect(
      (await db.query("SELECT id FROM ai_jobs WHERE organization_id=$1", [org]))
        .length,
    ).toBe(1);
  });
  test("successful screen geometry reuses equal source bytes even after a prior nonce/model change", async () => {
    const org = await organization(),
      source = await asset(org, "b".repeat(64)),
      duplicate = await asset(org, "b".repeat(64));
    const geometry = { found: true, x: 0.05, y: 0.05, width: 0.9, height: 0.8 };
    const id = await result(
      org,
      "detect_screen",
      { image: url(source) },
      geometry,
      { days: 30 },
    );
    expect(
      (await reusableScreenGeometry(db, org, { image: url(duplicate) }))?.id,
    ).toBe(id);
    expect(
      await repo.enqueue(actor(org), {
        operation: "detect_screen",
        params: { image: url(duplicate) },
        regenerate: true,
        commandId: randomUUID(),
      }),
    ).toMatchObject({ cached: true, resultId: id, result: geometry });
    expect(
      (await db.query("SELECT id FROM ai_jobs WHERE organization_id=$1", [org]))
        .length,
    ).toBe(0);
  });
});
