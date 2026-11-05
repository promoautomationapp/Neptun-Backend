import "reflect-metadata";
import type { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { Database } from "../../src/database/database";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";
import { AiController } from "../../src/modules/ai/ai.module";
import { GetReusableCutoutsQuery } from "../../src/modules/ai/application/handlers";
import {
  cutoutReuseInputSchema,
  findReusableCutouts,
} from "../../src/modules/ai/cutout-reuse";

test("the batch endpoint validates a bounded read-only query instead of enqueueing work", async () => {
  const commands = { execute: jest.fn() };
  const queries = {
    execute: jest.fn(async (_query: unknown) => ({ items: [] })),
  };
  const controller = new AiController(
    commands as unknown as CommandBus,
    queries as unknown as QueryBus,
  );
  const actor = { organizationId: "tenant" };
  const request = { actor } as AuthenticatedRequest;
  await expect(
    controller.reuseCutouts(request, {
      items: [{ key: "product", image: "https://catalog.example/photo.png" }],
    }),
  ).resolves.toEqual({ items: [] });
  expect(queries.execute).toHaveBeenCalledWith(
    expect.any(GetReusableCutoutsQuery),
  );
  expect(queries.execute.mock.calls[0]?.[0]).toMatchObject({
    actor,
    items: [{ key: "product", image: "https://catalog.example/photo.png" }],
  });
  expect(commands.execute).not.toHaveBeenCalled();
  expect(
    cutoutReuseInputSchema.safeParse({
      items: Array.from({ length: 201 }, () => ({
        key: "p",
        image: "https://catalog.example/photo.png",
      })),
    }).success,
  ).toBe(false);
});

test("embedded/unregistered local sources are misses without ingestion, storage, jobs or SQL", async () => {
  const query = jest.fn();
  const db = { query } as Pick<Database, "query">;
  expect(
    await findReusableCutouts(db, "tenant", [
      { key: "inline", image: "data:image/png;base64,aGVsbG8=" },
      { key: "blob", image: "blob:https://studio.example/test" },
      { key: "malformed", image: "/api/assets/not-an-id" },
    ]),
  ).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

test("the application receipt guard refuses unvalidated or baked results even if a query returned them", async () => {
  const query = jest.fn(async (_sql: string) => [
    {
      id: "result",
      matched_key: "product",
      operation: "cutout",
      status: "completed",
      output_asset_id: "photo",
      output_json: {
        cutoutValidated: true,
        cutoutValidationVersion: 1,
        annotationCleanup: true,
        annotationHandling: "baked-in",
      },
    },
  ]);
  expect(
    await findReusableCutouts(
      { query } as unknown as Pick<Database, "query">,
      "tenant",
      [{ key: "product", image: "https://catalog.example/photo.png" }],
    ),
  ).toEqual([]);
  expect(query).toHaveBeenCalledTimes(1);
  const sql = query.mock.calls[0]?.[0] as string;
  expect(sql.trimStart().startsWith("WITH incoming AS")).toBe(true);
  expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
});
