import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "../src/database/database";
import { directConnection } from "../src/database/direct-connection";
import { env } from "../src/config/environment";
import { provisionInitialAdmins } from "../src/modules/users/initial-admins";

async function main() {
  const credentialFile = process.argv
    .find((argument) => argument.startsWith("--credentials-file="))
    ?.slice("--credentials-file=".length);
  if (
    !credentialFile ||
    !env.BOOTSTRAP_SUPPORT_EMAIL ||
    !env.BOOTSTRAP_ADMIN_EMAIL
  )
    throw new Error(
      "Set both approved BOOTSTRAP emails and provide --credentials-file=/absolute/private/path.",
    );
  const settings = JSON.parse(
    await readFile(resolve("seed/stores.json"), "utf8"),
  ) as unknown;
  const db = new Database(
    directConnection(env.DATABASE_URL, env.DIRECT_DATABASE_URL),
  );
  try {
    const result = await provisionInitialAdmins(
      db,
      {
        supportEmail: env.BOOTSTRAP_SUPPORT_EMAIL,
        adminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
        credentialFile,
      },
      settings,
    );
    console.log(JSON.stringify(result));
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Initial administrator setup failed.",
  );
  process.exitCode = 1;
});
