import type { Request } from "express";
export interface Actor {
  userId: string;
  organizationId: string;
  email: string;
  name?: string;
  accountRole?: "staff" | "pm" | "admin" | "superadmin";
  role: "admin" | "editor" | "reviewer";
  reviewRole: "staff" | "pm";
  mustChangePassword: boolean;
}
export interface AuthenticatedRequest extends Request {
  actor: Actor;
}
export function publicUser(actor: Actor) {
  return {
    id: actor.userId,
    email: actor.email,
    name: actor.name ?? "",
    role: actor.accountRole ?? actor.reviewRole,
    reviewRole: actor.reviewRole,
    isSupport: actor.accountRole === "superadmin",
    organizationId: actor.organizationId,
    permissions: actor.role,
    mustChangePassword: actor.mustChangePassword,
  };
}
