import type { PoolClient } from "pg";
import {
  rejectSavedCutout,
  enqueueRejectedCutoutCleanup,
} from "../../src/modules/ai/cutout-rejection";
import { UNREFERENCED_CUTOUT_SQL } from "../../src/modules/ai/cutout-references";
const org = "00000000-0000-4000-8000-000000000001";
const output = "00000000-0000-4000-8000-000000000002";
const source = "/api/assets/00000000-0000-4000-8000-000000000003";

test("absolute and relative references to the same source UUID cannot reject an original", async () => {
  const query = jest.fn();
  await rejectSavedCutout(
    { query } as unknown as PoolClient,
    org,
    `https://studio.example.test${source.toUpperCase().replace("/API/ASSETS/", "/api/assets/")}`,
    source,
  );
  expect(query).not.toHaveBeenCalled();
});

test("an output that is not a known tenant-generated cutout cannot revoke any receipt", async () => {
  const query = jest
    .fn<Promise<{ rows: unknown[]; rowCount: number }>, [string, unknown[]?]>()
    .mockResolvedValue({ rows: [], rowCount: 0 });
  await rejectSavedCutout(
    { query } as unknown as PoolClient,
    org,
    `/api/assets/${output}`,
    source,
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toContain("a.kind IN ('cutout','design')");
});

test("only an authorized generated output loses its validated receipt and enters safe cleanup", async () => {
  const query = jest.fn<
    Promise<{ rows: { id: string }[]; rowCount: number }>,
    [string, unknown[]?]
  >(async (sql: string) => ({
    rows: sql.startsWith("SELECT a.id") ? [{ id: output }] : [],
    rowCount: 1,
  }));
  await rejectSavedCutout(
    { query } as unknown as PoolClient,
    org,
    `/api/assets/${output}`,
    source,
  );
  expect(query.mock.calls).toHaveLength(4);
  expect(query.mock.calls[0]?.[1]).toEqual([org, output, source]);
  expect(query.mock.calls[1]?.[0]).toContain("-'cutoutValidated'");
  expect(query.mock.calls[1]?.[0]).toContain('"cutoutRejected":true');
  expect(query.mock.calls[3]?.[0]).toContain(UNREFERENCED_CUTOUT_SQL);
});

test("autosaves do not enqueue cleanup while any history or saved-asset reference retains the image", async () => {
  const query = jest
    .fn<Promise<{ rows: unknown[]; rowCount: number }>, [string, unknown[]?]>()
    .mockResolvedValue({ rows: [], rowCount: 0 });
  await enqueueRejectedCutoutCleanup({ query } as unknown as PoolClient, org);
  const sql = query.mock.calls[0]?.[0];
  expect(sql).toContain("document_versions h");
  expect(sql).toContain("settings s");
  expect(sql).not.toContain("c.deleted_at IS NULL");
  expect(sql).not.toContain("p.deleted_at IS NULL");
});
