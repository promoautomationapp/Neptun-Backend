import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor } from "./actor";

export const workspaceAccessSchema = z
  .object({
    mode: z.enum(["default", "custom"]),
    canDisableBrochures: z.boolean().default(true),
    canViewSocialPosts: z.boolean().default(true),
    canViewCatalog: z.boolean().default(true),
    catalogCategoryPaths: z
      .array(z.string().trim().min(1).max(1000))
      .max(100)
      .nullable()
      .default(null),
  })
  .strict();
export type WorkspaceAccess = z.infer<typeof workspaceAccessSchema>;
export const defaultWorkspaceAccess = (): WorkspaceAccess => ({
  mode: "default",
  canDisableBrochures: true,
  canViewSocialPosts: true,
  canViewCatalog: true,
  catalogCategoryPaths: null,
});
export function resolvedWorkspaceAccess(
  role: Actor["accountRole"],
  stored: unknown,
): WorkspaceAccess {
  if (
    role === "admin" ||
    role === "superadmin" ||
    !stored ||
    (stored as { mode?: unknown }).mode !== "custom"
  )
    return defaultWorkspaceAccess();
  const parsed = workspaceAccessSchema.safeParse(stored);
  // An invalid explicit restriction cannot silently grant access. API writes are validated below.
  return parsed.success
    ? parsed.data
    : {
        mode: "custom",
        canDisableBrochures: false,
        canViewSocialPosts: false,
        canViewCatalog: false,
        catalogCategoryPaths: [],
      };
}
export function actorWorkspaceAccess(actor: Actor): WorkspaceAccess {
  return resolvedWorkspaceAccess(actor.accountRole, actor.access);
}
export function requireWorkspaceAccess(
  actor: Actor,
  permission: "canDisableBrochures" | "canViewSocialPosts" | "canViewCatalog",
): WorkspaceAccess {
  const access = actorWorkspaceAccess(actor);
  if (!access[permission])
    throw new ForbiddenException({
      code: "WORKSPACE_ACCESS_DENIED",
      error:
        "Your administrator has not enabled this workspace feature for your account.",
    });
  return access;
}
export function requireSocialContextAccess(
  actor: Actor,
  context: unknown,
): void {
  const social =
    context === "social" ||
    (context &&
      typeof context === "object" &&
      !Array.isArray(context) &&
      String(
        (context as { campaignType?: unknown }).campaignType ?? "",
      ).toLowerCase() === "social media post");
  if (social) requireWorkspaceAccess(actor, "canViewSocialPosts");
}
export const canonicalCategoryPath = (path: string) =>
  path
    .normalize("NFC")
    .split(">")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" > ");
export function categoryPathAllowed(
  path: string,
  allowed: string[] | null,
  includeAncestors = false,
): boolean {
  if (allowed === null) return true;
  return allowed.some(
    (root) =>
      path === root ||
      path.startsWith(`${root} > `) ||
      (includeAncestors && root.startsWith(`${path} > `)),
  );
}
/** Column names are internal constants; all user-selected paths remain bound parameters. */
export function categoryScopeSql(
  column: string,
  paths: string[] | null,
  bind: (value: unknown) => string,
): string | null {
  if (paths === null) return null;
  if (!paths.length) return "false";
  return `(${paths.map((path) => `(${column}=${bind(path)} OR ${column} LIKE ${bind(path.replace(/[\\%_]/g, "\\$&") + " > %")})`).join(" OR ")})`;
}
export async function storedWorkspaceAccess(
  client: PoolClient,
  organizationId: string,
  role: Actor["accountRole"],
  input: WorkspaceAccess | null | undefined,
): Promise<WorkspaceAccess | null> {
  if (
    role === "admin" ||
    role === "superadmin" ||
    !input ||
    input.mode === "default"
  )
    return null;
  const access = workspaceAccessSchema.parse(input);
  if (
    access.catalogCategoryPaths === null ||
    !access.catalogCategoryPaths.length
  )
    return access;
  const paths = (
    await client.query<{ path: string }>(
      "SELECT path FROM catalog_source_categories WHERE organization_id=$1 UNION SELECT category_path path FROM products WHERE organization_id=$1 AND deleted_at IS NULL",
      [organizationId],
    )
  ).rows;
  const known = new Map<string, string>();
  for (const { path } of paths) {
    const segments = canonicalCategoryPath(path).split(" > ").filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      const canonical = segments.slice(0, i).join(" > ");
      known.set(canonical.toLowerCase(), canonical);
    }
  }
  const selected = access.catalogCategoryPaths.map((path) =>
    known.get(canonicalCategoryPath(path).toLowerCase()),
  );
  if (selected.some((path) => !path))
    throw new BadRequestException(
      "Choose catalog categories from this workspace's category list.",
    );
  return {
    ...access,
    catalogCategoryPaths: [...new Set(selected as string[])],
  };
}
