import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { argon2id, hash, verify } from "argon2";
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import {
  resolvedWorkspaceAccess,
  storedWorkspaceAccess,
} from "../auth/domain/workspace-access";
import type { WorkspaceAccess } from "../auth/domain/workspace-access";
import type { Actor } from "../auth/domain/actor";
import { EmailService } from "../email/email.service";
export type AccountRole = "staff" | "pm" | "admin" | "superadmin";
interface UserRow {
  id: string;
  email: string;
  name: string;
  account_role: AccountRole;
  status: "active" | "invited" | "disabled";
  invited_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
  email_verified_at: Date | null;
  workspace_access?: WorkspaceAccess | null;
}
interface TokenRow {
  id: string;
  organization_id: string;
  user_id: string;
  purpose: "invite" | "password-reset";
  email: string;
  name: string;
  status: UserRow["status"];
  expires_at: Date;
  code_hash: string | null;
  code_expires_at: Date | null;
  attempts: number;
  pending_password_hash: string | null;
}
export const digestIdentity = (value: string) =>
  createHmac("sha256", env.SESSION_SECRET).update(value).digest("hex");
const tokenError = () =>
  new BadRequestException(
    "This link or code is invalid or has expired. Request a new one.",
  );
const userView = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.account_role,
  status: row.status,
  isSupport: row.account_role === "superadmin",
  invitedAt: row.invited_at,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  emailVerified: Boolean(row.email_verified_at),
  access: resolvedWorkspaceAccess(row.account_role, row.workspace_access),
});
const administrative = (actor: Actor) =>
  actor.accountRole === "admin" || actor.accountRole === "superadmin";
const rolePermissions = (role: AccountRole) => ({
  role: role === "staff" ? "editor" : role === "pm" ? "reviewer" : "admin",
  reviewRole: role === "staff" ? "staff" : "pm",
});
@Injectable()
export class IdentityService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EmailService) private readonly mail: EmailService,
  ) {}
  assertAdmin(actor: Actor): void {
    if (!administrative(actor))
      throw new ForbiddenException(
        "Only workspace administrators can manage users.",
      );
  }
  async rateLimit(key: string, limit = 8, seconds = 900): Promise<void> {
    const rows = await this.db.query<{ attempts: number }>(
      "INSERT INTO identity_rate_limits(key_hash,attempts,expires_at) VALUES($1,1,now()+make_interval(secs=>$2)) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN identity_rate_limits.expires_at<=now() THEN 1 ELSE identity_rate_limits.attempts+1 END,expires_at=CASE WHEN identity_rate_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE identity_rate_limits.expires_at END RETURNING attempts",
      [digestIdentity(`rate:${key}`), seconds],
    );
    if ((rows[0]?.attempts ?? 0) > limit)
      throw new HttpException(
        "Too many attempts. Please try again later.",
        429,
      );
  }
  async list(actor: Actor) {
    this.assertAdmin(actor);
    const rows = await this.db.query<UserRow>(
      "SELECT u.id,u.email,u.name,u.created_at,u.last_login_at,u.email_verified_at,m.account_role,m.status,m.invited_at,m.workspace_access FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND ($2 OR m.account_role<>'superadmin') ORDER BY CASE m.account_role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 WHEN 'pm' THEN 2 ELSE 3 END,u.email",
      [actor.organizationId, actor.accountRole === "superadmin"],
    );
    return { users: rows.map(userView), emailConfigured: this.mail.configured };
  }
  private async audit(
    client: PoolClient,
    actor: Actor | undefined,
    userId: string,
    organizationId: string,
    action: string,
    detail: Record<string, unknown> = {},
  ) {
    await client.query(
      "INSERT INTO account_audit(organization_id,actor_id,user_id,action,detail) VALUES($1,$2,$3,$4,$5)",
      [organizationId, actor?.userId ?? null, userId, action, detail],
    );
  }
  private async createToken(
    client: PoolClient,
    userId: string,
    organizationId: string,
    purpose: TokenRow["purpose"],
  ) {
    const token = randomBytes(32).toString("base64url");
    await client.query(
      "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
      [userId, purpose],
    );
    await client.query(
      "INSERT INTO account_tokens(organization_id,user_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5))",
      [
        organizationId,
        userId,
        purpose,
        digestIdentity(`token:${token}`),
        purpose === "invite" ? 172800 : 1800,
      ],
    );
    return token;
  }
  private url(purpose: TokenRow["purpose"], token: string) {
    const url = new URL(
      purpose === "invite" ? "account/invitation" : "account/reset-password",
      `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/`,
    );
    url.searchParams.set("token", token);
    return url.toString();
  }
  async invite(
    actor: Actor,
    input: {
      email: string;
      name: string;
      role: Exclude<AccountRole, "superadmin">;
      access?: WorkspaceAccess | null;
    },
  ) {
    this.assertAdmin(actor);
    this.mail.requireConfigured();
    await this.rateLimit(`invite:${actor.userId}`, 30, 3600);
    return this.db.transaction(async (client) => {
      const access = await storedWorkspaceAccess(
        client,
        actor.organizationId,
        input.role,
        input.access,
      );
      const found = await client.query(
        "SELECT id FROM users WHERE lower(email)=lower($1)",
        [input.email],
      );
      if (found.rows.length)
        throw new ConflictException(
          "This email already has an account. Manage the existing user or resend their invitation.",
        );
      const passwordHash = await hash(randomBytes(48).toString("base64url"), {
        type: argon2id,
      });
      const user = (
        await client.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password,email_verified_at) VALUES($1,$2,$3,false,NULL) RETURNING id",
          [input.email, input.name, passwordHash],
        )
      ).rows[0];
      if (!user) throw new Error("Could not create invitation.");
      const permission = rolePermissions(input.role);
      await client.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role,status,invited_at,workspace_access) VALUES($1,$2,$3,$4,$5,'invited',now(),$6)",
        [
          actor.organizationId,
          user.id,
          permission.role,
          permission.reviewRole,
          input.role,
          access,
        ],
      );
      const token = await this.createToken(
        client,
        user.id,
        actor.organizationId,
        "invite",
      );
      await this.mail.enqueue(client, {
        to: input.email,
        name: input.name,
        kind: "invitation",
        role: input.role,
        url: this.url("invite", token),
      });
      await this.audit(
        client,
        actor,
        user.id,
        actor.organizationId,
        "user.invited",
        { role: input.role, access },
      );
      const rows = await client.query<UserRow>(
        "SELECT u.*,m.account_role,m.status,m.invited_at,m.workspace_access FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2",
        [user.id, actor.organizationId],
      );
      return { user: userView(rows.rows[0]!) };
    });
  }
  async update(
    actor: Actor,
    id: string,
    input: {
      name?: string;
      role?: Exclude<AccountRole, "superadmin">;
      status?: "active" | "disabled";
      access?: WorkspaceAccess | null;
    },
  ) {
    this.assertAdmin(actor);
    return this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `users:${actor.organizationId}`,
      ]);
      const found = await client.query<UserRow>(
        "SELECT u.*,m.account_role,m.status,m.invited_at,m.workspace_access FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND u.id=$2 FOR UPDATE OF m,u",
        [actor.organizationId, id],
      );
      const target = found.rows[0];
      if (
        !target ||
        (target.account_role === "superadmin" &&
          actor.accountRole !== "superadmin")
      )
        throw new NotFoundException("User was not found.");
      if (target.account_role === "superadmin")
        throw new ForbiddenException(
          "Support administrators are managed by the support team.",
        );
      if (
        input.status === "active" &&
        (target.status === "invited" || !target.email_verified_at)
      )
        throw new BadRequestException(
          "This user must accept and verify a new invitation before activation. Resend their invitation.",
        );
      const nextRole = input.role ?? target.account_role;
      const nextStatus = input.status ?? target.status;
      const access = await storedWorkspaceAccess(
        client,
        actor.organizationId,
        nextRole,
        input.access === undefined ? target.workspace_access : input.access,
      );
      if (
        actor.accountRole !== "superadmin" &&
        target.account_role === "admin" &&
        target.status === "active" &&
        (nextRole !== "admin" || nextStatus !== "active")
      ) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*) count FROM memberships WHERE organization_id=$1 AND account_role='admin' AND status='active'",
          [actor.organizationId],
        );
        if (Number(count.rows[0]?.count) <= 1)
          throw new ConflictException(
            "Keep at least one active Neptun administrator.",
          );
      }
      const permission = rolePermissions(nextRole);
      await client.query(
        "UPDATE users SET name=COALESCE($2,name) WHERE id=$1",
        [id, input.name ?? null],
      );
      await client.query(
        "UPDATE memberships SET account_role=$3,role=$4,review_role=$5,status=$6,workspace_access=$7 WHERE organization_id=$1 AND user_id=$2",
        [
          actor.organizationId,
          id,
          nextRole,
          permission.role,
          permission.reviewRole,
          nextStatus,
          access,
        ],
      );
      if (nextRole !== target.account_role || nextStatus !== target.status) {
        await client.query(
          "DELETE FROM sessions WHERE organization_id=$1 AND user_id=$2",
          [actor.organizationId, id],
        );
        await client.query(
          "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE organization_id=$1 AND user_id=$2 AND consumed_at IS NULL",
          [actor.organizationId, id],
        );
      }
      await this.audit(
        client,
        actor,
        id,
        actor.organizationId,
        "user.updated",
        input,
      );
      return {
        user: userView({
          ...target,
          name: input.name ?? target.name,
          account_role: nextRole,
          status: nextStatus,
          workspace_access: access,
        }),
      };
    });
  }
  async resend(actor: Actor, id: string) {
    this.assertAdmin(actor);
    this.mail.requireConfigured();
    await this.rateLimit(`resend:${id}`, 5, 3600);
    return this.db.transaction(async (client) => {
      const result = await client.query<UserRow>(
        "SELECT u.*,m.account_role,m.status,m.invited_at,m.workspace_access FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND u.id=$2 FOR UPDATE OF m",
        [actor.organizationId, id],
      );
      const user = result.rows[0];
      if (
        !user ||
        (user.account_role === "superadmin" &&
          actor.accountRole !== "superadmin")
      )
        throw new NotFoundException("User was not found.");
      if (
        user.status !== "invited" &&
        !(user.status === "disabled" && !user.email_verified_at)
      )
        throw new BadRequestException(
          "Only pending or cancelled unverified invitations can be resent.",
        );
      if (
        user.account_role === "superadmin" &&
        actor.accountRole !== "superadmin"
      )
        throw new ForbiddenException(
          "Support invitations are managed by the support team.",
        );
      const token = await this.createToken(
        client,
        id,
        actor.organizationId,
        "invite",
      );
      await this.mail.enqueue(client, {
        to: user.email,
        name: user.name,
        kind: "invitation",
        role: user.account_role,
        url: this.url("invite", token),
      });
      await client.query(
        "UPDATE memberships SET invited_at=now(),status='invited' WHERE organization_id=$1 AND user_id=$2",
        [actor.organizationId, id],
      );
      await this.audit(
        client,
        actor,
        id,
        actor.organizationId,
        "user.invitation_resent",
      );
      return {
        user: userView({ ...user, status: "invited", invited_at: new Date() }),
      };
    });
  }
  private async token(
    client: PoolClient,
    raw: string,
    purpose?: TokenRow["purpose"],
  ) {
    const result = await client.query<TokenRow>(
      "SELECT t.*,u.email,u.name,m.status FROM account_tokens t JOIN users u ON u.id=t.user_id JOIN memberships m ON m.user_id=t.user_id AND m.organization_id=t.organization_id WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now() FOR UPDATE OF t,m,u",
      [digestIdentity(`token:${raw}`)],
    );
    const token = result.rows[0];
    if (
      !token ||
      (purpose && token.purpose !== purpose) ||
      token.status === "disabled" ||
      (token.purpose === "invite" && token.status !== "invited") ||
      (token.purpose === "password-reset" && token.status !== "active")
    )
      throw tokenError();
    return token;
  }
  async inspectToken(raw: string, ip: string) {
    await this.rateLimit(`inspect:${ip}`, 60, 900);
    return this.db.transaction(async (client) => {
      const token = await this.token(client, raw);
      return {
        purpose: token.purpose,
        email: token.email,
        name: token.name,
        expiresAt: token.expires_at,
        codeSent: Boolean(
          token.code_hash &&
          token.code_expires_at &&
          token.code_expires_at.getTime() > Date.now(),
        ),
      };
    });
  }
  private async issueCode(
    client: PoolClient,
    token: TokenRow,
    passwordHash?: string,
  ) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await client.query(
      "UPDATE account_tokens SET code_hash=$2,code_expires_at=now()+interval '10 minutes',attempts=0,pending_password_hash=COALESCE($3,pending_password_hash) WHERE id=$1",
      [
        token.id,
        digestIdentity(`code:${token.id}:${code}`),
        passwordHash ?? null,
      ],
    );
    await this.mail.enqueue(client, {
      to: token.email,
      name: token.name,
      kind: "verification",
      code,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    return { codeSent: true, delivery: "queued" };
  }
  async acceptInvitation(raw: string, password: string, ip: string) {
    this.mail.requireConfigured();
    await this.rateLimit(`accept:${ip}`, 20, 900);
    await this.rateLimit(`code:${raw}`, 5, 600);
    const passwordHash = await hash(password, { type: argon2id });
    return this.db.transaction(async (client) =>
      this.issueCode(
        client,
        await this.token(client, raw, "invite"),
        passwordHash,
      ),
    );
  }
  async requestInvitationCode(raw: string, ip: string) {
    this.mail.requireConfigured();
    await this.rateLimit(`invite-code-ip:${ip}`, 20, 900);
    await this.rateLimit(`code:${raw}`, 5, 600);
    return this.db.transaction(async (client) => {
      const token = await this.token(client, raw, "invite");
      if (!token.pending_password_hash)
        throw new BadRequestException(
          "Create your password before requesting a verification code.",
        );
      return this.issueCode(client, token);
    });
  }
  private async codeValid(client: PoolClient, token: TokenRow, code: string) {
    if (
      !token.code_hash ||
      !token.code_expires_at ||
      token.code_expires_at.getTime() <= Date.now() ||
      token.attempts >= 5
    )
      return false;
    const expected = Buffer.from(token.code_hash, "hex");
    const supplied = Buffer.from(
      digestIdentity(`code:${token.id}:${code}`),
      "hex",
    );
    if (
      expected.length === supplied.length &&
      timingSafeEqual(expected, supplied)
    )
      return true;
    await client.query(
      "UPDATE account_tokens SET attempts=attempts+1 WHERE id=$1",
      [token.id],
    );
    return false;
  }
  async verifyInvitation(raw: string, code: string, ip: string) {
    await this.rateLimit(`verify:${ip}`, 30, 900);
    const ok = await this.db.transaction(async (client) => {
      const token = await this.token(client, raw, "invite");
      if (
        !token.pending_password_hash ||
        !(await this.codeValid(client, token, code))
      )
        return false;
      await client.query(
        "UPDATE users SET password_hash=$2,email_verified_at=now(),must_change_password=false WHERE id=$1",
        [token.user_id, token.pending_password_hash],
      );
      await client.query("DELETE FROM sessions WHERE user_id=$1", [
        token.user_id,
      ]);
      await client.query(
        "UPDATE memberships SET status='active' WHERE organization_id=$1 AND user_id=$2",
        [token.organization_id, token.user_id],
      );
      await client.query(
        "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE user_id=$1 AND consumed_at IS NULL",
        [token.user_id],
      );
      await this.audit(
        client,
        undefined,
        token.user_id,
        token.organization_id,
        "user.activated",
      );
      return true;
    });
    if (!ok) throw tokenError();
    return { activated: true, signInRequired: true };
  }
  async forgot(email: string, ip: string) {
    await this.rateLimit(`forgot-ip:${ip}`, 20, 900);
    await this.rateLimit(`forgot-email:${email}`, 5, 3600);
    if (this.mail.configured)
      await this.db.transaction(async (client) => {
        const result = await client.query<{
          id: string;
          name: string;
          email: string;
          organization_id: string;
        }>(
          "SELECT u.id,u.name,u.email,m.organization_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=$1 AND m.status='active' AND u.email_verified_at IS NOT NULL ORDER BY m.organization_id LIMIT 1 FOR UPDATE OF u,m",
          [email],
        );
        const user = result.rows[0];
        if (!user) return;
        const token = await this.createToken(
          client,
          user.id,
          user.organization_id,
          "password-reset",
        );
        await this.mail.enqueue(client, {
          to: user.email,
          name: user.name,
          kind: "password-reset",
          url: this.url("password-reset", token),
        });
        await this.audit(
          client,
          undefined,
          user.id,
          user.organization_id,
          "password.reset_requested",
        );
      });
    return {
      message:
        "If an active account exists for this email, a secure password reset link will be sent.",
    };
  }
  async requestResetCode(raw: string, ip: string) {
    this.mail.requireConfigured();
    await this.rateLimit(`reset-code-ip:${ip}`, 20, 900);
    await this.rateLimit(`code:${raw}`, 5, 600);
    return this.db.transaction(async (client) =>
      this.issueCode(client, await this.token(client, raw, "password-reset")),
    );
  }
  async reset(raw: string, code: string, password: string, ip: string) {
    await this.rateLimit(`reset:${ip}`, 30, 900);
    const passwordHash = await hash(password, { type: argon2id });
    const ok = await this.db.transaction(async (client) => {
      const token = await this.token(client, raw, "password-reset");
      if (!(await this.codeValid(client, token, code))) return false;
      await client.query(
        "UPDATE users SET password_hash=$2,must_change_password=false WHERE id=$1",
        [token.user_id, passwordHash],
      );
      await client.query("DELETE FROM sessions WHERE user_id=$1", [
        token.user_id,
      ]);
      await client.query(
        "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE user_id=$1 AND consumed_at IS NULL",
        [token.user_id],
      );
      await this.mail.enqueue(client, {
        to: token.email,
        name: token.name,
        kind: "password-changed",
      });
      await this.audit(
        client,
        undefined,
        token.user_id,
        token.organization_id,
        "password.reset",
      );
      return true;
    });
    if (!ok) throw tokenError();
    return { changed: true, signInRequired: true, notificationEmail: "queued" };
  }
  async changePassword(
    actor: Actor,
    currentPassword: string,
    password: string,
  ) {
    await this.rateLimit(`password-change:${actor.userId}`, 8, 900);
    const result = await this.db.query<{ password_hash: string; name: string }>(
      "SELECT password_hash,name FROM users WHERE id=$1",
      [actor.userId],
    );
    const user = result[0];
    if (!user || !(await verify(user.password_hash, currentPassword)))
      throw new UnauthorizedException("Your current password is incorrect.");
    if (currentPassword === password)
      throw new BadRequestException(
        "Choose a password different from your current password.",
      );
    const passwordHash = await hash(password, { type: argon2id });
    await this.db.transaction(async (client) => {
      const changed = await client.query(
        "UPDATE users SET password_hash=$2,must_change_password=false WHERE id=$1 AND password_hash=$3 RETURNING id",
        [actor.userId, passwordHash, user.password_hash],
      );
      if (!changed.rows.length)
        throw new ConflictException(
          "Your password changed in another session. Sign in again.",
        );
      await client.query("DELETE FROM sessions WHERE user_id=$1", [
        actor.userId,
      ]);
      await client.query(
        "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE user_id=$1 AND consumed_at IS NULL",
        [actor.userId],
      );
      await this.mail.enqueue(client, {
        to: actor.email,
        name: user.name,
        kind: "password-changed",
      });
      await this.audit(
        client,
        actor,
        actor.userId,
        actor.organizationId,
        "password.changed",
      );
    });
    return { changed: true, signInRequired: true, notificationEmail: "queued" };
  }
}
