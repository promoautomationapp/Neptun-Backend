import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { Database } from "../../src/database/database";
import {
  InsightsController,
  InsightsRepository,
  usageFilters,
} from "../../src/modules/insights/insights.module";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";
describe("superadmin project insights", () => {
  const db = new Database(),
    repo = new InsightsRepository(db),
    controller = new InsightsController(repo);
  let org: string, other: string;
  beforeAll(async () => {
    org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Insights test',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
    other = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Other insights test',$1) RETURNING id",
        [randomUUID()],
      )
    )[0]!.id;
    for (const [organization, time] of [
      [org, "2026-03-31T21:59:59Z"],
      [org, "2026-03-31T22:00:00Z"],
      [org, "2026-04-30T22:00:00Z"],
      [other, "2026-04-15T10:00:00Z"],
    ])
      await db.query(
        "INSERT INTO ai_usage(organization_id,operation,model,input_tokens,output_tokens,month,created_at,usage_json) VALUES($1,'proofread','gpt-4o-mini',1000,100,'2026-04',$2,'{}')",
        [organization, time],
      );
    await db.query(
      "INSERT INTO ai_results(organization_id,operation,model,cache_key,prompt_version,status,created_at,params_json) VALUES($1,'background','gpt-image-2.5-sunburst',$2,'imported','completed','2026-04-20T10:00:00Z','{\"context\":\"tv\"}')",
      [org, randomUUID()],
    );
  });
  afterAll(() => db.onModuleDestroy());
  test("restricts all three endpoints to support superadmins, including regular admins", () => {
    for (const accountRole of ["staff", "pm", "admin"] as const) {
      const req = {
        actor: { organizationId: org, role: "admin", accountRole },
      } as AuthenticatedRequest;
      expect(() => controller.ai(req, {})).toThrow(ForbiddenException);
      expect(() => controller.media(req)).toThrow(ForbiddenException);
      expect(() => controller.database(req)).toThrow(ForbiddenException);
    }
  });
  test("inclusive dates respect local midnight and DST, and isolate the project", async () => {
    const data = await repo.ai(
      org,
      usageFilters.parse({ from: "2026-04-01", to: "2026-04-30" }),
    );
    expect(data.total).toBe(2);
    expect(data.summary.inputTokens).toBe(1000);
    expect(data.summary.unknownCosts).toBe(1);
    expect(data.timeline.map((x) => x.date)).toEqual([
      "2026-04-01",
      "2026-04-20",
    ]);
    expect(
      data.operations.find((x) => x.operation === "tv_artwork")?.requests,
    ).toBe(1);
    const day = await repo.ai(
      org,
      usageFilters.parse({
        from: "2026-04-01",
        to: "2026-04-01",
        operation: "proofread",
      }),
    );
    expect(day.total).toBe(1);
    const all = await repo.ai(
      org,
      usageFilters.parse({ group: "month", limit: 1, page: 2 }),
    );
    expect(all.total).toBe(4);
    expect(all.records).toHaveLength(1);
    expect(all.summary.minimumUsd).toBeCloseTo(0.00063, 8);
    expect(
      usageFilters.safeParse({ from: "2026-04-20", to: "2026-04-01" }).success,
    ).toBe(false);
    expect(usageFilters.safeParse({ from: "2026-02-30" }).success).toBe(false);
  });
  test("reports database/media statistics without exposing connection credentials", async () => {
    const stats = await repo.database(org);
    expect(stats.counts.aiResults).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
    const media = await repo.media(org);
    expect(media.registered.objects).toBe(0);
    expect(media.bucket).toBeNull();
    expect(JSON.stringify({ stats, media })).not.toMatch(
      /password|access.key|secret/i,
    );
  });
});
