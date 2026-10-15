import { Injectable, Inject, UnauthorizedException } from "@nestjs/common";
import { Database } from "../../database/database";
import type { Actor } from "./domain/actor";
import { createHmac } from "node:crypto";
import { env } from "../../config/environment";

interface UserRow {
  user_id: string;
  organization_id: string;
  email: string;
  name: string;
  account_role: NonNullable<Actor["accountRole"]>;
  role: Actor["role"];
  review_role: Actor["reviewRole"];
  must_change_password: boolean;
}
@Injectable()
export class AuthRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  private tokenHash(token: string): string {
    return createHmac("sha256", env.SESSION_SECRET).update(token).digest("hex");
  }
  async credentials(email: string) {
    const rows = await this.db.query<UserRow & { password_hash: string }>(
      "SELECT u.id user_id,m.organization_id,u.email,u.name,u.password_hash,u.must_change_password,m.role,m.review_role,CASE WHEN m.account_role='staff' AND m.review_role='pm' THEN 'pm' ELSE m.account_role END account_role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=$1 AND m.status='active' AND u.email_verified_at IS NOT NULL ORDER BY m.organization_id LIMIT 1",
      [email],
    );
    const row = rows[0];
    return row
      ? { actor: this.actor(row), passwordHash: row.password_hash }
      : null;
  }
  async session(token: string): Promise<Actor | null> {
    if (!token || token.length > 256) return null;
    const rows = await this.db.query<UserRow>(
      "SELECT u.id user_id,s.organization_id,u.email,u.name,u.must_change_password,m.role,m.review_role,CASE WHEN m.account_role='staff' AND m.review_role='pm' THEN 'pm' ELSE m.account_role END account_role FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=s.user_id AND m.organization_id=s.organization_id WHERE s.token_hash=$1 AND s.expires_at>now() AND m.status='active' AND u.email_verified_at IS NOT NULL",
      [this.tokenHash(token)],
    );
    return rows[0] ? this.actor(rows[0]) : null;
  }
  async createSession(
    actor: Actor,
    token: string,
    expectedPasswordHash: string,
  ): Promise<Actor> {
    return this.db.transaction(async (client) => {
      // Serialize against password changes, deactivation and role edits. Never issue a
      // session from credentials that became stale while Argon2 verification ran.
      const result = await client.query<UserRow>(
        "SELECT u.id user_id,m.organization_id,u.email,u.name,u.must_change_password,m.role,m.review_role,CASE WHEN m.account_role='staff' AND m.review_role='pm' THEN 'pm' ELSE m.account_role END account_role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2 AND u.password_hash=$3 AND m.status='active' AND u.email_verified_at IS NOT NULL FOR UPDATE OF u,m",
        [actor.userId, actor.organizationId, expectedPasswordHash],
      );
      const row = result.rows[0];
      if (!row)
        throw new UnauthorizedException(
          "Your account changed during sign in. Please sign in again.",
        );
      await client.query("UPDATE users SET last_login_at=now() WHERE id=$1", [
        actor.userId,
      ]);
      await client.query(
        "INSERT INTO sessions(token_hash,organization_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '14 days')",
        [this.tokenHash(token), actor.organizationId, actor.userId],
      );
      return this.actor(row);
    });
  }
  async removeSession(token: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [
      this.tokenHash(token),
    ]);
  }
  async members(organizationId: string, includeSupport = false) {
    return this.db.query<{ email: string; role: string }>(
      "SELECT u.email,CASE WHEN m.account_role='staff' AND m.review_role='pm' THEN 'pm' ELSE m.account_role END role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.status='active' AND ($2 OR m.account_role<>'superadmin') ORDER BY u.email",
      [organizationId, includeSupport],
    );
  }
  private actor(row: UserRow): Actor {
    return {
      userId: row.user_id,
      organizationId: row.organization_id,
      email: row.email,
      name: row.name,
      accountRole: row.account_role,
      role: row.account_role === "pm" ? "reviewer" : row.role,
      reviewRole: row.review_role,
      mustChangePassword: row.must_change_password,
    };
  }
}
