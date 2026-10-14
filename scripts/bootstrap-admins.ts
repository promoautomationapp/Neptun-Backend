import { randomBytes } from "node:crypto";
import { argon2id, hash } from "argon2";
import { Database } from "../src/database/database";
import { env } from "../src/config/environment";
import { digestIdentity } from "../src/modules/users/identity.service";
import { EmailService } from "../src/modules/email/email.service";
async function main(): Promise<void> {
  if (!env.BOOTSTRAP_SUPPORT_EMAIL || !env.BOOTSTRAP_ADMIN_EMAIL)
    throw new Error(
      "Set BOOTSTRAP_SUPPORT_EMAIL and BOOTSTRAP_ADMIN_EMAIL to the two approved addresses.",
    );
  if (
    env.BOOTSTRAP_SUPPORT_EMAIL.toLowerCase() ===
    env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase()
  )
    throw new Error(
      "Support and Neptun administrators need different email addresses.",
    );
  const db = new Database();
  const mail = new EmailService(db);
  try {
    mail.requireConfigured();
    await db.transaction(async (client) => {
      const org = (
        await client.query<{ id: string }>(
          "SELECT id FROM organizations WHERE slug='neptun'",
        )
      ).rows[0];
      if (!org)
        throw new Error(
          "Create the Neptun organization before bootstrapping administrators.",
        );
      for (const [email, role, name] of [
        [env.BOOTSTRAP_SUPPORT_EMAIL, "superadmin", "Support administrator"],
        [env.BOOTSTRAP_ADMIN_EMAIL, "admin", "Neptun administrator"],
      ]) {
        if (!email || !role || !name) continue;
        const password = await hash(randomBytes(48).toString("base64url"), {
          type: argon2id,
        });
        const user = (
          await client.query<{ id: string }>(
            "INSERT INTO users(email,name,password_hash,must_change_password,email_verified_at) VALUES($1,$2,$3,false,NULL) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
            [email.toLowerCase(), name, password],
          )
        ).rows[0];
        if (!user) throw new Error("Could not bootstrap administrator.");
        const existing = (
          await client.query<{ status: string }>(
            "SELECT status FROM memberships WHERE organization_id=$1 AND user_id=$2",
            [org.id, user.id],
          )
        ).rows[0];
        if (existing) {
          if (existing.status === "disabled")
            throw new Error(
              "A bootstrap administrator is disabled. Resolve their status explicitly before continuing.",
            );
          await client.query(
            "UPDATE memberships SET role='admin',review_role='pm',account_role=$3 WHERE organization_id=$1 AND user_id=$2",
            [org.id, user.id, role],
          );
          if (existing.status === "active") continue;
          const valid = await client.query(
            "SELECT id FROM account_tokens WHERE user_id=$1 AND purpose='invite' AND consumed_at IS NULL AND expires_at>now()",
            [user.id],
          );
          if (valid.rows.length) continue;
        } else
          await client.query(
            "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role,status,invited_at) VALUES($1,$2,'admin','pm',$3,'invited',now())",
            [org.id, user.id, role],
          );
        const token = randomBytes(32).toString("base64url");
        await client.query(
          "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE user_id=$1 AND purpose='invite' AND consumed_at IS NULL",
          [user.id],
        );
        await client.query(
          "INSERT INTO account_tokens(organization_id,user_id,purpose,token_hash,expires_at) VALUES($1,$2,'invite',$3,now()+interval '48 hours')",
          [org.id, user.id, digestIdentity(`token:${token}`)],
        );
        const url = new URL(
          "account/invitation",
          `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/`,
        );
        url.searchParams.set("token", token);
        await mail.enqueue(client, {
          to: email.toLowerCase(),
          name,
          role,
          kind: "invitation",
          url: url.toString(),
        });
        await client.query(
          "INSERT INTO account_audit(organization_id,user_id,action,detail) VALUES($1,$2,'user.bootstrap',$3)",
          [org.id, user.id, { role }],
        );
      }
    });
    console.log(
      "Approved administrator accounts prepared. Invitations queued; existing passwords preserved.",
    );
  } finally {
    await db.onModuleDestroy();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Administrator bootstrap failed.",
  );
  process.exitCode = 1;
});
