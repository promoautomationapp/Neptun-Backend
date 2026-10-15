import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import sharp from "sharp";
import { Database } from "../../src/database/database";
import { LocalStorage } from "../../src/modules/storage/local.storage";
import { DocumentAssets } from "../../src/modules/assets/document-assets";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
import { processAiJob } from "../../src/worker/ai/processor";
import {
  ProviderUncertainError,
  ProviderHttpError,
} from "../../src/worker/ai/provider";
import type { AiProvider } from "../../src/worker/ai/provider";
import type { Actor } from "../../src/modules/auth/domain/actor";
import { env } from "../../src/config/environment";
import { ingestAsset, assetUrl } from "../../src/modules/assets/asset-ingest";
describe("durable AI reuse and quotas", () => {
  const db = new Database();
  const storage = new LocalStorage(env.LOCAL_STORAGE_DIR);
  const quota = new LifestyleRepository(db);
  const repo = new AiRepository(db, new DocumentAssets(db, storage), quota);
  let actor: Actor;
  let png: Buffer;
  beforeAll(async () => {
    const id = randomUUID();
    const org =
      (
        await db.query<{ id: string }>(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          ["AI test", id],
        )
      )[0]?.id ?? "";
    const user =
      (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
          [`${id}@example.test`, "unused"],
        )
      )[0]?.id ?? "";
    actor = {
      organizationId: org,
      userId: user,
      email: `${id}@example.test`,
      role: "editor",
      reviewRole: "staff",
      mustChangePassword: false,
    };
    env.OPENAI_API_KEY = "mock-key-for-tests";
    png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: "#abcdef" },
    })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    env.OPENAI_API_KEY = "";
    await db.onModuleDestroy();
  });
  test("simultaneous identical requests attach to one job and survive another user session", async () => {
    const tickets = await Promise.all(
      Array.from({ length: 24 }, () =>
        repo.enqueue(actor, {
          operation: "proofread",
          params: { items: [{ id: "f1", text: "Tevelizor" }] },
          regenerate: false,
        }),
      ),
    );
    const ids = new Set(tickets.map((x) => x.jobId));
    expect(ids.size).toBe(1);
    const ticket = tickets[0];
    if (!ticket?.jobId) throw new Error("No job.");
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        json: {
          changes: [{ id: "f1", suggested: "Televizor", reason: "Spelling" }],
        },
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    const saved = await repo.enqueue(
      { ...actor, email: "another-user@example.test" },
      {
        operation: "proofread",
        params: { items: [{ id: "f1", text: "Tevelizor" }] },
        regenerate: false,
      },
    );
    expect(saved.cached).toBe(true);
    expect(saved.status).toBe("succeeded");
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      (
        await repo.usage(
          actor.organizationId,
          (await quota.quota(actor.organizationId)).month,
        )
      ).operations[0]?.requests,
    ).toBe("1");
  });
  test("an interrupted billable request is not automatically retried", async () => {
    const ticket = await repo.enqueue(actor, {
      operation: "background",
      params: { prompt: "Test uncertain" },
      regenerate: false,
    });
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockRejectedValue(new ProviderUncertainError());
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      (await repo.job(actor.organizationId, ticket.jobId ?? "")).status,
    ).toBe("uncertain");
    await expect(
      repo.enqueue(actor, {
        operation: "background",
        params: { prompt: "Test uncertain" },
        regenerate: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  test("missing-catalog image searches share durable jobs and preserve verified photo provenance", async () => {
    const params = {
      code: "missing-840099",
      name: "TV FUEGO 65ELU720GTV",
      brand: "FUEGO",
      details: ["4K UHD"],
    };
    const tickets = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.enqueue(actor, {
          operation: "product_image_search",
          params,
          regenerate: false,
        }),
      ),
    );
    expect(new Set(tickets.map((ticket) => ticket.jobId)).size).toBe(1);
    const ticket = tickets[0];
    if (!ticket?.jobId) throw new Error("No search job.");
    const provenance = {
      found: true,
      sourceUrl: "https://manufacturer.example/tv",
      imageUrl: "https://manufacturer.example/tv.png",
      matchedName: params.name,
      matchedModel: "65ELU720GTV",
    };
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        bytes: png,
        mimeType: "image/png",
        json: provenance,
        inputTokens: 20,
        outputTokens: 10,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    const finished = await repo.job(actor.organizationId, ticket.jobId);
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toEqual({
      ...provenance,
      image: expect.stringMatching(/^\/api\/assets\/[a-f0-9-]{36}$/),
    });
    env.OPENAI_API_KEY = "";
    try {
      const cached = await repo.enqueue(actor, {
        operation: "product_image_search",
        params: { ...params, sale: 299, requestId: "new session" },
        regenerate: false,
      });
      expect(cached.cached).toBe(true);
      expect(cached.result).toEqual(finished.result);
    } finally {
      env.OPENAI_API_KEY = "mock-key-for-tests";
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("a long provider cooldown releases the photo slot and exhausted attempts do not remain running", async () => {
    const ticket = await repo.enqueue(actor, {
      operation: "background",
      params: { prompt: `Long cooldown ${randomUUID()}` },
      regenerate: false,
    });
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockRejectedValue(new ProviderHttpError(429, 3_600_000));
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(await repo.job(actor.organizationId, ticket.jobId!)).toMatchObject({
      status: "failed",
      stage: "finished",
      attempts: 1,
      createdAt: expect.any(Date),
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
    });
    const exhausted = await repo.enqueue(actor, {
      operation: "background",
      params: { prompt: `Exhausted ${randomUUID()}` },
      regenerate: false,
    });
    await db.query("UPDATE ai_jobs SET attempts=$2 WHERE id=$1", [
      exhausted.jobId,
      env.AI_MAX_ATTEMPTS,
    ]);
    run.mockClear();
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: exhausted.jobId },
      { run },
    );
    expect(run).not.toHaveBeenCalled();
    expect(
      await repo.job(actor.organizationId, exhausted.jobId!),
    ).toMatchObject({
      status: "failed",
      stage: "finished",
      error: expect.stringContaining("attempt limit"),
    });
  });
  test("an unsuccessful search is reusable and explicit retry creates one new version", async () => {
    const params = {
      code: "missing-840100",
      name: "Unknown FUEGO 65NOTFOUND",
      details: ["4K UHD"],
    };
    const first = await repo.enqueue(actor, {
      operation: "product_image_search",
      params,
      regenerate: false,
    });
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        json: { found: false, reason: "No exact photo found." },
        inputTokens: 20,
        outputTokens: 10,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: first.jobId },
      { run },
    );
    const cached = await repo.enqueue(actor, {
      operation: "product_image_search",
      params: { ...params, retry: false },
      regenerate: false,
    });
    expect(cached.status).toBe("succeeded");
    expect(cached.result).toEqual({
      found: false,
      reason: "No exact photo found.",
    });
    const retried = await repo.enqueue(actor, {
      operation: "product_image_search",
      params,
      regenerate: true,
    });
    expect(retried.jobId).not.toBe(first.jobId);
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("thirty attempts and twenty accepted images are enforced under concurrent requests", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 35 }, (_, index) =>
        repo.enqueue(actor, {
          operation: "lifestyle",
          params: { prompt: `Lifestyle ${index}` },
          regenerate: false,
        }),
      ),
    );
    const tickets = results.flatMap((x) =>
      x.status === "fulfilled" ? [x.value] : [],
    );
    expect(tickets).toHaveLength(30);
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(5);
    const provider: AiProvider = {
      run: async () => ({
        bytes: png,
        mimeType: "image/png",
        json: {},
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      }),
    };
    for (const ticket of tickets)
      await processAiJob(
        db,
        storage,
        { organizationId: actor.organizationId, jobId: ticket.jobId },
        provider,
      );
    const acceptances = await Promise.allSettled(
      tickets.map((x) => quota.accept(actor.organizationId, x.resultId)),
    );
    expect(acceptances.filter((x) => x.status === "fulfilled")).toHaveLength(
      20,
    );
    expect((await quota.quota(actor.organizationId)).used).toBe(20);
    const index = acceptances.findIndex((x) => x.status === "fulfilled");
    const ticket = tickets[index];
    if (!ticket) throw new Error("No acceptance.");
    expect(
      (await quota.accept(actor.organizationId, ticket.resultId)).reused,
    ).toBe(true);
    const original = await db.query<{ params_json: { prompt: string } }>(
      "SELECT params_json FROM ai_results WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, ticket.resultId],
    );
    env.OPENAI_API_KEY = "";
    expect(
      (
        await repo.enqueue(actor, {
          operation: "lifestyle",
          params: original[0]?.params_json ?? {},
          regenerate: false,
        })
      ).cached,
    ).toBe(true);
    env.OPENAI_API_KEY = "mock-key-for-tests";
  });
  test("another tenant cannot see jobs or accept results", async () => {
    await expect(repo.job(randomUUID(), randomUUID())).rejects.toThrow(
      "Job not found.",
    );
  });
  test("image reuse is independent of object key order and duplicate asset references", async () => {
    const source = await ingestAsset(
      db,
      storage,
      actor.organizationId,
      png,
      "image/png",
    );
    const background = await ingestAsset(
      db,
      storage,
      actor.organizationId,
      await sharp({
        create: { width: 13, height: 10, channels: 4, background: "#12abef" },
      })
        .png()
        .toBuffer(),
      "image/png",
    );
    const first = await repo.enqueue(actor, {
      operation: "cutout",
      regenerate: false,
      params: {
        image: assetUrl(source.id),
        backgroundContext: { kind: "image", image: assetUrl(background.id) },
      },
    });
    const reordered = await repo.enqueue(actor, {
      operation: "cutout",
      regenerate: false,
      params: {
        backgroundContext: { image: assetUrl(background.id), kind: "image" },
        image: assetUrl(source.id),
      },
    });
    expect(reordered.jobId).toBe(first.jobId);
    expect(reordered.cached).toBe(true);
  });
  test("completed individual fields survive batch reordering, added fields and an unavailable provider", async () => {
    const context = { campaignName: "Field reuse", campaignType: "brochure" };
    const request = {
      operation: "proofread" as const,
      regenerate: false,
      params: {
        context,
        items: [
          {
            id: "f0",
            text: "Tevelizor per shtepi",
            brand: "Samsung",
            label: "Product name",
          },
          {
            id: "f1",
            text: "Already correct",
            brand: "",
            label: "Product description",
          },
        ],
      },
    };
    const ticket = await repo.enqueue(actor, request);
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        json: {
          changes: [
            { id: "f0", suggested: "Televizor per shtepi", reason: "Spelling" },
          ],
        },
        inputTokens: 20,
        outputTokens: 5,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    env.OPENAI_API_KEY = "";
    const reused = await repo.enqueue(actor, {
      ...request,
      params: {
        context,
        items: [
          {
            id: "f42",
            text: "Already correct",
            brand: "",
            label: "Product description",
          },
          {
            id: "f9",
            text: "Tevelizor per shtepi",
            brand: "Samsung",
            label: "Product name",
          },
        ],
      },
    });
    expect(reused.cached).toBe(true);
    expect(reused.status).toBe("succeeded");
    expect(reused.jobId).toBeUndefined();
    expect(reused.result?.changes).toEqual([
      {
        id: "f9",
        original: "Tevelizor per shtepi",
        suggested: "Televizor per shtepi",
        reason: "Spelling",
      },
    ]);
    env.OPENAI_API_KEY = "mock-key-for-tests";
    const mixed = await repo.enqueue(actor, {
      ...request,
      params: {
        context,
        items: [
          ...request.params.items,
          {
            id: "f2",
            text: "New unchecked copy",
            label: "Product description",
          },
        ],
      },
    });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: mixed.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1].items).toEqual([
      {
        id: "f2",
        text: "New unchecked copy",
        label: "Product description",
        brand: "",
      },
    ]);
    expect(
      (await repo.job(actor.organizationId, mixed.jobId ?? "")).result?.changes,
    ).toEqual([
      {
        id: "f0",
        original: "Tevelizor per shtepi",
        suggested: "Televizor per shtepi",
        reason: "Spelling",
      },
    ]);
  });
  test("overlapping concurrent batches check a shared field once, including no-correction checks", async () => {
    const context = { campaignName: "Overlapping batches" };
    const first = await repo.enqueue(actor, {
      operation: "proofread",
      regenerate: false,
      params: {
        context,
        items: [{ id: "f0", text: "Shared correct sentence" }],
      },
    });
    const second = await repo.enqueue(actor, {
      operation: "proofread",
      regenerate: false,
      params: {
        context,
        items: [
          { id: "f4", text: "Shared correct sentence" },
          { id: "f5", text: "Other correct sentence" },
        ],
      },
    });
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockImplementation(async () => ({
        json: { changes: [] },
        inputTokens: 10,
        outputTokens: 2,
        costUsd: null,
      }));
    await Promise.all(
      [first, second].map((ticket) =>
        processAiJob(
          db,
          storage,
          { organizationId: actor.organizationId, jobId: ticket.jobId },
          { run },
        ),
      ),
    );
    const sent = run.mock.calls.flatMap((call) =>
      Array.isArray(call[1].items) ? call[1].items : [],
    );
    expect(
      sent.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          item.text === "Shared correct sentence",
      ),
    ).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(
      (await repo.job(actor.organizationId, first.jobId ?? "")).status,
    ).toBe("succeeded");
    expect(
      (await repo.job(actor.organizationId, second.jobId ?? "")).status,
    ).toBe("succeeded");
  });
  test("changed proofreading context and explicit regeneration produce separate checks", async () => {
    const original = {
      operation: "proofread" as const,
      regenerate: false,
      params: {
        context: { campaignName: "Context before" },
        items: [{ id: "f0", text: "Context dependent copy" }],
      },
    };
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        json: { changes: [] },
        inputTokens: 10,
        outputTokens: 1,
        costUsd: null,
      });
    for (const request of [
      original,
      {
        ...original,
        params: {
          ...original.params,
          context: { campaignName: "Context after" },
        },
      },
      { ...original, regenerate: true },
    ]) {
      const ticket = await repo.enqueue(actor, request);
      await processAiJob(
        db,
        storage,
        { organizationId: actor.organizationId, jobId: ticket.jobId },
        { run },
      );
    }
    expect(run).toHaveBeenCalledTimes(3);
    expect((await repo.enqueue(actor, original)).cached).toBe(true);
  });
  test("an interrupted individual field is not silently charged again in a different batch", async () => {
    const request = {
      operation: "proofread" as const,
      regenerate: false,
      params: { items: [{ id: "f0", text: "Interrupted shared copy" }] },
    };
    const ticket = await repo.enqueue(actor, request);
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockRejectedValue(new ProviderUncertainError());
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: ticket.jobId },
      { run },
    );
    const another = await repo.enqueue(actor, {
      ...request,
      params: {
        items: [
          { id: "f1", text: "Interrupted shared copy" },
          { id: "f2", text: "Another field" },
        ],
      },
    });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: another.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      (await repo.job(actor.organizationId, another.jobId ?? "")).status,
    ).toBe("uncertain");
  });
  test("completed image reuse survives a new repository and session, while changed inputs and regeneration create versions", async () => {
    const source = await ingestAsset(
      db,
      storage,
      actor.organizationId,
      png,
      "image/png",
    );
    const input = {
      operation: "cutout" as const,
      regenerate: false,
      params: {
        image: assetUrl(source.id),
        name: "Image reuse test",
        orientation: "square",
      },
    };
    const first = await repo.enqueue(actor, input);
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        bytes: png,
        mimeType: "image/png",
        json: { preparationRevision: 3 },
        inputTokens: 10,
        outputTokens: 10,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: first.jobId },
      { run },
    );
    const nextSession = new AiRepository(
      db,
      new DocumentAssets(db, storage),
      quota,
    );
    env.OPENAI_API_KEY = "";
    const reused = await nextSession.enqueue(
      { ...actor, email: "new-session@example.test" },
      input,
    );
    expect(reused.status).toBe("succeeded");
    expect(reused.resultId).toBe(first.resultId);
    expect(reused.result?.image).toMatch(/^\/api\/assets\//);
    expect(run).toHaveBeenCalledTimes(1);
    env.OPENAI_API_KEY = "mock-key-for-tests";
    const changed = await repo.enqueue(actor, {
      ...input,
      params: { ...input.params, orientation: "portrait" },
    });
    const regenerated = await repo.enqueue(actor, {
      ...input,
      regenerate: true,
    });
    for (const ticket of [changed, regenerated])
      await processAiJob(
        db,
        storage,
        { organizationId: actor.organizationId, jobId: ticket.jobId },
        { run },
      );
    expect(run).toHaveBeenCalledTimes(3);
    expect(regenerated.resultId).not.toBe(first.resultId);
    expect((await repo.enqueue(actor, input)).resultId).toBe(first.resultId);
  });
  test("one explicit regeneration command survives simultaneous posts, repository restarts and a lost completion response", async () => {
    const commandId = randomUUID();
    const input = {
      operation: "background" as const,
      regenerate: true,
      commandId,
      params: { prompt: `Regenerate once ${randomUUID()}`, commandId },
    };
    const tickets = await Promise.all(
      Array.from({ length: 12 }, () => repo.enqueue(actor, input)),
    );
    expect(new Set(tickets.map((ticket) => ticket.jobId)).size).toBe(1);
    const first = tickets[0];
    if (!first?.jobId) throw new Error("No regeneration job.");
    expect(tickets.filter((ticket) => !ticket.cached)).toHaveLength(1);
    const nextSession = new AiRepository(
      db,
      new DocumentAssets(db, storage),
      quota,
    );
    const reattached = await nextSession.enqueue(actor, input);
    expect(reattached.jobId).toBe(first.jobId);
    expect(reattached.cached).toBe(true);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text count FROM job_outbox WHERE organization_id=$1 AND job_key=$2",
          [actor.organizationId, `ai:${first.jobId}`],
        )
      )[0]?.count,
    ).toBe("1");
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        bytes: png,
        mimeType: "image/png",
        json: {},
        inputTokens: 10,
        outputTokens: 10,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: first.jobId },
      { run },
    );
    env.OPENAI_API_KEY = "";
    const completed = await nextSession.enqueue(actor, input);
    expect(completed.status).toBe("succeeded");
    expect(completed.resultId).toBe(first.resultId);
    expect(completed.cached).toBe(true);
    expect(completed.result?.image).toMatch(/^\/api\/assets\//);
    expect(run).toHaveBeenCalledTimes(1);
    env.OPENAI_API_KEY = "mock-key-for-tests";
    const newCommand = await nextSession.enqueue(actor, {
      ...input,
      commandId: randomUUID(),
    });
    expect(newCommand.resultId).not.toBe(first.resultId);
    expect(newCommand.cached).toBe(false);
    const stored = (
      await db.query<{ params_json: Record<string, unknown> }>(
        "SELECT params_json FROM ai_results WHERE id=$1",
        [first.resultId],
      )
    )[0];
    expect(stored?.params_json).not.toHaveProperty("commandId");
  });
  test("an uncertain regeneration command never repeats provider work and another actor cannot consume its command identity", async () => {
    const input = {
      operation: "background" as const,
      regenerate: true,
      commandId: randomUUID(),
      params: { prompt: `Uncertain regeneration ${randomUUID()}` },
    };
    const first = await repo.enqueue(actor, input);
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockRejectedValue(new ProviderUncertainError());
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: first.jobId },
      { run },
    );
    const nextSession = new AiRepository(
      db,
      new DocumentAssets(db, storage),
      quota,
    );
    await expect(nextSession.enqueue(actor, input)).rejects.toMatchObject({
      response: { code: "AI_RESULT_UNCERTAIN", resultId: first.resultId },
    });
    expect(run).toHaveBeenCalledTimes(1);
    const otherUser = (
      await db.query<{ id: string }>(
        "INSERT INTO users(email,password_hash) VALUES($1,'unused') RETURNING id",
        [`${randomUUID()}@example.test`],
      )
    )[0]?.id;
    if (!otherUser) throw new Error("Second actor missing.");
    const other = await nextSession.enqueue(
      { ...actor, userId: otherUser },
      input,
    );
    expect(other.resultId).not.toBe(first.resultId);
    expect(other.cached).toBe(false);
  });
  test("command identities do not alter normal prepared-result reuse", async () => {
    const input = {
      operation: "background" as const,
      regenerate: false,
      commandId: randomUUID(),
      params: { prompt: `Normal command metadata ${randomUUID()}` },
    };
    const first = await repo.enqueue(actor, input);
    const again = await repo.enqueue(actor, {
      ...input,
      commandId: randomUUID(),
    });
    expect(again.cached).toBe(true);
    expect(again.jobId).toBe(first.jobId);
    expect(again.resultId).toBe(first.resultId);
  });
  test("proofreading results are isolated between organizations", async () => {
    const slug = randomUUID();
    const org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Other AI tenant',$1) RETURNING id",
        [slug],
      )
    )[0]?.id;
    if (!org) throw new Error("Tenant missing");
    const input = {
      operation: "proofread" as const,
      regenerate: false,
      params: { items: [{ id: "f0", text: "Organization scoped sentence" }] },
    };
    const original = await repo.enqueue(actor, input);
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        json: { changes: [] },
        inputTokens: 10,
        outputTokens: 1,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: original.jobId },
      { run },
    );
    const other = await repo.enqueue({ ...actor, organizationId: org }, input);
    expect(other.cached).toBe(false);
    expect(other.resultId).not.toBe(original.resultId);
    await processAiJob(
      db,
      storage,
      { organizationId: org, jobId: other.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(2);
    await expect(repo.job(org, original.jobId ?? "")).rejects.toThrow(
      "Job not found.",
    );
  });
  test("unrelated editor positions, prices and product images do not invalidate generated backgrounds", async () => {
    const original = await repo.enqueue(actor, {
      operation: "background",
      regenerate: false,
      params: {
        prompt: "Same scene",
        products: [
          {
            name: "Samsung TV",
            category: "TV",
            sale: 299,
            x: 10,
            image: "/unrelated-photo",
          },
        ],
      },
    });
    const again = await repo.enqueue(actor, {
      operation: "background",
      regenerate: false,
      params: {
        prompt: "Same scene",
        context: "social",
        orientation: "square",
        products: [
          {
            name: "Samsung TV",
            category: "TV",
            sale: 499,
            x: 80,
            image: "/another-photo",
          },
        ],
      },
    });
    expect(again.jobId).toBe(original.jobId);
    expect(again.cached).toBe(true);
  });
  test("moving the same text to a new product position reuses its checked result", async () => {
    const input = {
      operation: "proofread" as const,
      regenerate: false,
      params: {
        items: [
          {
            id: "f0",
            text: "Same unchanged product copy",
            label: "Product 1 name",
            brand: "Samsung",
          },
        ],
      },
    };
    const original = await repo.enqueue(actor, input);
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockResolvedValue({
        json: { changes: [] },
        inputTokens: 10,
        outputTokens: 1,
        costUsd: null,
      });
    await processAiJob(
      db,
      storage,
      { organizationId: actor.organizationId, jobId: original.jobId },
      { run },
    );
    const reused = await repo.enqueue(actor, {
      ...input,
      params: {
        items: [
          {
            id: "f18",
            text: "Same unchanged product copy",
            label: "Product 4 name",
            brand: "Samsung",
          },
        ],
      },
    });
    expect(reused.cached).toBe(true);
    expect(reused.status).toBe("succeeded");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
