import { Client } from "pg";
import { env } from "../src/config/environment";

async function main(): Promise<void> {
  const url = new URL(env.DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name))
    throw new Error("Use a simple lowercase target database name.");
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [name],
    );
    if (!found.rowCount) await client.query(`CREATE DATABASE "${name}"`);
    console.log(
      found.rowCount
        ? `Database ${name} already exists.`
        : `Created database ${name}.`,
    );
  } finally {
    await client.end();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Operation failed");
  process.exitCode = 1;
});
