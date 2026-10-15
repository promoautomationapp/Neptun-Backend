import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { CommandBus, QueryBus } from "@nestjs/cqrs";
import { AiController } from "../../src/modules/ai/ai.module";
import { aiRequestSchema } from "../../src/modules/ai/domain/request";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";

test.each([
  "cutout",
  "brand",
  "proofread",
  "background",
  "lifestyle",
  "placement",
  "screen",
  "productImage",
] as const)(
  "legacy %s requests forward a validated command identity",
  async (method) => {
    const commandId = randomUUID();
    const execute = jest.fn().mockResolvedValue({
      cached: true,
      status: "queued",
      jobId: randomUUID(),
    });
    const controller = new AiController(
      { execute } as unknown as CommandBus,
      {} as QueryBus,
    );
    const request = { actor: {} } as AuthenticatedRequest;
    const response = { status: jest.fn() } as unknown as Response;
    await controller[method](request, { retry: true, commandId }, response);
    expect(execute.mock.calls[0]?.[0].request).toMatchObject({
      commandId,
      regenerate: true,
    });
    await expect(
      controller[method](request, { retry: true, commandId: "bad" }, response),
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  },
);

test("the modern AI endpoint accepts optional UUID command identities only", () => {
  const input = { operation: "background", params: {}, regenerate: true };
  expect(aiRequestSchema.parse(input)).not.toHaveProperty("commandId");
  const commandId = randomUUID();
  expect(aiRequestSchema.parse({ ...input, commandId }).commandId).toBe(
    commandId,
  );
  expect(() => aiRequestSchema.parse({ ...input, commandId: "bad" })).toThrow();
});
