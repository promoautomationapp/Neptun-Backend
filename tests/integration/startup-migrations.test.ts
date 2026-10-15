import "reflect-metadata";
import { spawnSync } from "node:child_process";
import { Database } from "../../src/database/database";

test("startup migration checks can run repeatedly without changing applied migrations", async () => {
  const db = new Database();
  try {
    const before = await db.query(
      "SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name",
    );
    expect(before.length).toBeGreaterThan(0);
    for (let pass = 0; pass < 2; pass++) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/migrate.ts"],
        {
          env: process.env,
          timeout: 15_000,
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(
      await db.query(
        "SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name",
      ),
    ).toEqual(before);
  } finally {
    await db.onModuleDestroy();
  }
});
