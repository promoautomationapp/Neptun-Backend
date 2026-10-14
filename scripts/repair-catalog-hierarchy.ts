import { Database } from "../src/database/database";
import { CatalogRepository } from "../src/modules/catalog/catalog.repository";
async function main() {
  const db = new Database();
  try {
    const repository = new CatalogRepository(db);
    for (const organization of await db.query<{ id: string; slug: string }>(
      "SELECT id,slug FROM organizations",
    )) {
      console.log(
        `${organization.slug}: repaired ${await repository.repairHierarchy(organization.id)} category paths`,
      );
    }
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Hierarchy repair failed.",
  );
  process.exitCode = 1;
});
