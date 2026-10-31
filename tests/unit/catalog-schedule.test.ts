import "reflect-metadata";
import type { Database } from "../../src/database/database";
import {
  CatalogRepository,
  type CatalogStatus,
} from "../../src/modules/catalog/catalog.repository";
import {
  automaticCatalogRefreshDue,
  catalogAutomaticWindowOpen,
} from "../../src/modules/catalog/catalog-schedule";

describe("three-day automatic catalog schedule", () => {
  test.each([
    ["2026-01-30T02:00:00Z", "2026-02-01T02:00:00Z", false],
    ["2026-01-30T02:00:00Z", "2026-02-02T02:00:00Z", true],
    ["2026-12-30T02:00:00Z", "2027-01-02T02:00:00Z", true],
    ["2026-03-28T02:00:00Z", "2026-03-31T01:00:00Z", true],
    ["2026-10-24T01:00:00Z", "2026-10-27T02:00:00Z", true],
    ["2026-10-24T22:30:00Z", "2026-10-27T02:00:00Z", false],
  ])("counts Belgrade calendar days from %s to %s", (last, now, due) => {
    expect(automaticCatalogRefreshDue(last, null, new Date(now))).toBe(due);
  });
  test("a successful manual update postpones the next automatic crawl without forgetting failed automatic attempts", () => {
    const now = new Date("2026-10-31T02:00:00Z");
    expect(automaticCatalogRefreshDue(null, null, now)).toBe(true);
    expect(automaticCatalogRefreshDue("2026-10-30T02:00:00Z", null, now)).toBe(
      false,
    );
    expect(
      automaticCatalogRefreshDue(
        "2026-10-25T02:00:00Z",
        "2026-10-30T17:00:00Z",
        now,
      ),
    ).toBe(false);
    expect(
      automaticCatalogRefreshDue(
        "2026-10-25T02:00:00Z",
        "2026-10-28T17:00:00Z",
        now,
      ),
    ).toBe(true);
  });
  test("startup catch-up waits until 03:00 through both DST changes", () => {
    expect(catalogAutomaticWindowOpen(new Date("2026-03-29T00:59:00Z"))).toBe(
      false,
    );
    expect(catalogAutomaticWindowOpen(new Date("2026-03-29T01:00:00Z"))).toBe(
      true,
    );
    expect(catalogAutomaticWindowOpen(new Date("2026-10-25T01:59:00Z"))).toBe(
      false,
    );
    expect(catalogAutomaticWindowOpen(new Date("2026-10-25T02:00:00Z"))).toBe(
      true,
    );
  });
  test("the durable history gate applies to automatic requests while manual refresh bypasses it", async () => {
    const query = jest.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT max(created_at)")
        ? [
            {
              automatic_at: new Date("2026-10-30T02:00:00Z"),
              manual_at: null,
              current_time: new Date("2026-10-31T02:00:00Z"),
            },
          ]
        : sql.startsWith("INSERT INTO catalog_sync_runs")
          ? [{ id: "manual-run" }]
          : [],
    }));
    const db = {
      transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ query }),
    } as unknown as Database;
    const repository = new CatalogRepository(db);
    const status = jest
      .spyOn(repository, "status")
      .mockResolvedValue({ status: "failed" } as CatalogStatus);
    try {
      await repository.enqueue("organization", "daily");
      expect(
        query.mock.calls.some(([sql]) =>
          sql.startsWith("INSERT INTO catalog_sync_runs"),
        ),
      ).toBe(false);
      query.mockClear();
      await repository.enqueue("organization", "manual");
      expect(
        query.mock.calls.some(([sql]) =>
          sql.startsWith("SELECT max(created_at)"),
        ),
      ).toBe(false);
      expect(
        query.mock.calls.some(([sql]) =>
          sql.startsWith("INSERT INTO catalog_sync_runs"),
        ),
      ).toBe(true);
      expect(
        query.mock.calls.some(([sql]) =>
          sql.startsWith("INSERT INTO job_outbox"),
        ),
      ).toBe(true);
    } finally {
      status.mockRestore();
    }
  });
});
