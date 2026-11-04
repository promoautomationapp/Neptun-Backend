import "reflect-metadata";
import { createHash } from "node:crypto";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Database } from "../../src/database/database";
import type { Actor } from "../../src/modules/auth/domain/actor";
import { DocumentAssets } from "../../src/modules/assets/document-assets";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import type { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import type { JsonObject } from "../../src/shared/json";
import { stableJson } from "../../src/modules/ai/domain/request";

const originalId = "00000000-0000-4000-8000-000000000001";
const duplicateId = "00000000-0000-4000-8000-000000000002";
const outputId = "00000000-0000-4000-8000-000000000003";
const original = `/api/assets/${originalId}`;
const sourceHash = createHash("sha256").update("same-photo-hash").digest("hex");
const actor: Actor = {
  organizationId: "organization",
  userId: "user",
  email: "staff@example.test",
  role: "editor",
  reviewRole: "staff",
  accountRole: "staff",
  mustChangePassword: false,
};
const params: JsonObject = {
  image: original,
  name: "Product",
  instructions: "Keep its cable.",
  backgroundContext: { kind: "solid", color: "#1b4075" },
};

function repository({
  exactStatus,
  exactActive = false,
  nonceActive = false,
  paidAvailable = true,
  nonceUncertain = false,
}: {
  exactStatus?: "failed" | "uncertain";
  exactActive?: boolean;
  nonceActive?: boolean;
  paidAvailable?: boolean;
  nonceUncertain?: boolean;
} = {}) {
  const paid = {
    id: "previous-paid-result",
    operation: "cutout",
    status: "completed",
    source_sha256: sourceHash,
    params_json: params,
    output_asset_id: outputId,
    output_json: { preparationRevision: 3 },
  };
  const active = {
    id: "previous-paid-job",
    result_id: paid.id,
    status: "running",
  };
  const query = jest.fn(async (_sql: string, values: unknown[]) =>
    (values[1] as string[]).map((id) => ({ id, sha256: "same-photo-hash" })),
  );
  const transactionQuery = jest.fn(async (sql: string, values: unknown[]) => {
    let rows: object[] = [];
    if (sql.startsWith("SELECT * FROM ai_results") && exactStatus)
      rows = [{ ...paid, status: exactStatus }];
    else if (sql.startsWith("SELECT * FROM ai_jobs") && exactActive)
      rows = [active];
    else if (sql.startsWith("SELECT j.*") || sql.startsWith("SELECT r.*")) {
      const candidate = { ...(values[5] as JsonObject) };
      const saved = { ...paid.params_json };
      delete candidate.image;
      delete saved.image;
      const matches =
        values[0] === actor.organizationId &&
        values[1] === paid.source_sha256 &&
        stableJson(candidate) === stableJson(saved);
      if (matches)
        rows = sql.startsWith("SELECT j.*")
          ? nonceActive
            ? [active]
            : []
          : sql.includes("r.status='uncertain'")
            ? nonceUncertain
              ? [{ ...paid, status: "uncertain" }]
              : []
            : paidAvailable
              ? [paid]
              : [];
    }
    return { rows, rowCount: rows.length };
  });
  const db = {
    query,
    transaction: async (work: (client: unknown) => Promise<unknown>) =>
      work({ query: transactionQuery }),
  } as unknown as Database;
  const assets = new DocumentAssets(db, {} as StoragePort);
  return {
    repo: new AiRepository(db, assets, {} as LifestyleRepository),
    transactionQuery,
  };
}

test.each([
  original,
  `https://brochure.example${original}`,
  `/api/assets/${duplicateId}`,
])(
  "reuses a paid nonce result for the same source bytes (%s), even after a base failure",
  async (image) => {
    const { repo, transactionQuery } = repository({ exactStatus: "failed" });
    await expect(
      repo.enqueue(actor, {
        operation: "cutout",
        params: { ...params, image },
        regenerate: false,
      }),
    ).resolves.toMatchObject({
      cached: true,
      status: "succeeded",
      resultId: "previous-paid-result",
      result: { image: `/api/assets/${outputId}` },
    });
    const reusable = transactionQuery.mock.calls.find(([sql]) =>
      sql.startsWith("SELECT r.*"),
    );
    expect(reusable?.[0]).toContain("r.model=$3");
    expect(reusable?.[0]).toContain("r.prompt_version=$5");
    expect(reusable?.[0]).toContain("a.deleted_at IS NULL");
    expect(
      transactionQuery.mock.calls.some(([sql]) => sql.startsWith("INSERT")),
    ).toBe(false);
  },
);

test.each([false, true])(
  "reattaches to existing %s-key in-flight work without buying a new job",
  async (nonceActive) => {
    const { repo, transactionQuery } = repository({
      nonceActive,
      exactActive: !nonceActive,
    });
    await expect(
      repo.enqueue(actor, { operation: "cutout", params, regenerate: false }),
    ).resolves.toMatchObject({
      cached: true,
      status: "running",
      jobId: "previous-paid-job",
    });
    expect(
      transactionQuery.mock.calls.some(
        ([sql]) => sql.startsWith("SELECT r.*") || sql.startsWith("INSERT"),
      ),
    ).toBe(false);
  },
);

test("an uncertain exact result remains guarded before looking up older output", async () => {
  const { repo, transactionQuery } = repository({ exactStatus: "uncertain" });
  await expect(
    repo.enqueue(actor, { operation: "cutout", params, regenerate: false }),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(
    transactionQuery.mock.calls.some(
      ([sql]) =>
        sql.startsWith("SELECT r.*") ||
        sql.startsWith("SELECT j.*") ||
        sql.startsWith("INSERT"),
    ),
  ).toBe(false);
});

test("a failed preparation without reusable paid output cannot silently purchase a retry", async () => {
  const { repo, transactionQuery } = repository({
    exactStatus: "failed",
    paidAvailable: false,
  });
  await expect(
    repo.enqueue(actor, { operation: "cutout", params, regenerate: false }),
  ).rejects.toMatchObject({
    response: {
      code: "AI_JOB_FAILED",
      error: expect.stringContaining("Change the cleanup instructions"),
    },
  });
  expect(
    transactionQuery.mock.calls.some(([sql]) => sql.startsWith("INSERT")),
  ).toBe(false);
});

test("an uncertain nonce result blocks a new paid request when no exact base result exists", async () => {
  const { repo, transactionQuery } = repository({
    nonceUncertain: true,
    paidAvailable: false,
  });
  await expect(
    repo.enqueue(actor, { operation: "cutout", params, regenerate: false }),
  ).rejects.toMatchObject({
    response: {
      code: "AI_RESULT_UNCERTAIN",
      resultId: "previous-paid-result",
      error: expect.stringContaining("Check this job"),
    },
  });
  expect(
    transactionQuery.mock.calls.some(([sql]) => sql.startsWith("INSERT")),
  ).toBe(false);
});

test.each([
  { instructions: "Remove its cable." } as JsonObject,
  { backgroundContext: { kind: "solid", color: "#ffffff" } } as JsonObject,
])(
  "changed provider inputs do not reuse an older cutout (%p)",
  async (changed) => {
    const { repo, transactionQuery } = repository();
    await expect(
      repo.enqueue(actor, {
        operation: "cutout",
        params: { ...params, ...changed },
        regenerate: false,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(
      transactionQuery.mock.calls.some(([sql]) => sql.startsWith("INSERT")),
    ).toBe(false);
  },
);

test("explicit regeneration bypasses reusable older results without calling a provider in this test", async () => {
  const { repo, transactionQuery } = repository();
  await expect(
    repo.enqueue(actor, { operation: "cutout", params, regenerate: true }),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(
    transactionQuery.mock.calls.some(
      ([sql]) => sql.startsWith("SELECT r.*") || sql.startsWith("SELECT j.*"),
    ),
  ).toBe(false);
});
