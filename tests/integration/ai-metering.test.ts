import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/database/database";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
import { DocumentAssets } from "../../src/modules/assets/document-assets";
import { LocalStorage } from "../../src/modules/storage/local.storage";
import { processAiJob } from "../../src/worker/ai/processor";
import { env } from "../../src/config/environment";
import type { Actor } from "../../src/modules/auth/domain/actor";
import type { AiProvider } from "../../src/worker/ai/provider";
test("meters a billable response once even when later image validation fails", async () => {
  const db = new Database(),
    storage = new LocalStorage(env.LOCAL_STORAGE_DIR),
    priorKey = env.OPENAI_API_KEY;
  try {
    const org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Metering QA',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
    const user = (
      await db.query<{ id: string }>(
        "INSERT INTO users(email,password_hash) VALUES($1,'unused') RETURNING id",
        [`${randomUUID()}@example.test`],
      )
    )[0]!.id;
    const actor: Actor = {
      organizationId: org,
      userId: user,
      email: "test@example.test",
      role: "editor",
      reviewRole: "staff",
      mustChangePassword: false,
    };
    env.OPENAI_API_KEY = "mock-test-only";
    const repo = new AiRepository(
      db,
      new DocumentAssets(db, storage),
      new LifestyleRepository(db),
    );
    const ticket = await repo.enqueue(actor, {
      operation: "background",
      params: { prompt: "Metering fixture" },
      regenerate: false,
    });
    const run = jest
      .fn<ReturnType<AiProvider["run"]>, Parameters<AiProvider["run"]>>()
      .mockImplementation(async (_operation, _params, _model, recordUsage) => {
        await recordUsage?.({
          inputTokens: 100,
          outputTokens: 200,
          costUsd: 0.0065,
          usageJson: {
            input_tokens_details: { text_tokens: 100, image_tokens: 0 },
          },
        });
        throw new Error(
          "Generated pixels failed validation after provider success",
        );
      });
    await processAiJob(
      db,
      storage,
      { organizationId: org, jobId: ticket.jobId },
      { run },
    );
    await processAiJob(
      db,
      storage,
      { organizationId: org, jobId: ticket.jobId },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(1);
    const usage = await db.query<{ cost_usd: string; input_tokens: string }>(
      "SELECT cost_usd,input_tokens FROM ai_usage WHERE organization_id=$1",
      [org],
    );
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]!.cost_usd)).toBe(0.0065);
    expect(usage[0]!.input_tokens).toBe("100");
  } finally {
    env.OPENAI_API_KEY = priorKey;
    await db.onModuleDestroy();
  }
});
