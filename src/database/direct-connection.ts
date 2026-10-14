/** Workers and migration/backup tools use session-level PostgreSQL features.
 * The API can use a transaction pooler independently. */
export function directConnection(
  databaseUrl: string,
  directUrl?: string,
): string {
  const selected = directUrl || databaseUrl;
  const connection = new URL(selected);
  if (
    connection.hostname.endsWith(".neon.tech") &&
    connection.hostname.includes("-pooler.")
  )
    throw new Error(
      "Set DIRECT_DATABASE_URL to the unpooled Neon connection for the worker, migrations and backups.",
    );
  if (connection.pathname !== new URL(databaseUrl).pathname)
    throw new Error(
      "DATABASE_URL and DIRECT_DATABASE_URL must refer to the same database.",
    );
  return selected;
}
