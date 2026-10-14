import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hash, argon2id } from "argon2";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { resolveSettings } from "../src/modules/settings/domain/settings.schema";

async function main(): Promise<void> {
  if (env.SEED_DEFAULT_PASSWORD.length < 12)
    throw new Error(
      "Development seed requires SEED_DEFAULT_PASSWORD with at least 12 characters. Production accounts use invitations.",
    );
  const db = new Database();
  try {
    const settings = resolveSettings(
      JSON.parse(
        await readFile(resolve("seed/stores.json"), "utf8"),
      ) as unknown,
    );
    const passwordHash = await hash(env.SEED_DEFAULT_PASSWORD, {
      type: argon2id,
    });
    await db.transaction(async (client) => {
      const org = await client.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Neptun','neptun') ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id",
      );
      const organizationId = org.rows[0]?.id;
      if (!organizationId) throw new Error("Organization seed failed.");
      for (const [email, role, reviewRole] of [
        ["pm@neptun-ks.com", "reviewer", "pm"],
        ["staff@neptun-ks.com", "editor", "staff"],
        ["staff2@neptun-ks.com", "editor", "staff"],
      ]) {
        const user = await client.query<{ id: string }>(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
          [email, passwordHash],
        );
        await client.query(
          "INSERT INTO memberships(organization_id,user_id,role,review_role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [organizationId, user.rows[0]?.id, role, reviewRole],
        );
      }
      await client.query(
        "INSERT INTO settings(organization_id,value) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [organizationId, settings],
      );
      console.log(
        "Neptun and three users seeded. Existing passwords and saved data preserved.",
      );
    });
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Operation failed");
  process.exitCode = 1;
});
