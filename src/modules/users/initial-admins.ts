import { randomBytes } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { argon2id, hash } from "argon2";
import { z } from "zod";
import type { Database } from "../../database/database";
import { resolveSettings } from "../settings/domain/settings.schema";

const address = z.string().trim().toLowerCase().pipe(z.email().max(320));
const inputSchema = z.object({
  supportEmail: address,
  adminEmail: address,
  organizationSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("neptun"),
  organizationName: z.string().trim().min(1).max(120).default("Neptun"),
  credentialFile: z
    .string()
    .refine(isAbsolute, "Use an absolute private file path."),
});

/** Operator-only first setup. No public endpoint or outgoing email is involved. */
export async function provisionInitialAdmins(
  db: Database,
  input: z.input<typeof inputSchema>,
  initialSettings: unknown = null,
) {
  const values = inputSchema.parse(input);
  if (values.supportEmail === values.adminEmail)
    throw new Error("The two administrator accounts need different addresses.");
  const accounts = [
    {
      email: values.supportEmail,
      name: "Promo Automation superadmin",
      role: "superadmin",
    },
    { email: values.adminEmail, name: "Neptun administrator", role: "admin" },
  ] as const;
  const settings = resolveSettings(initialSettings);
  await mkdir(dirname(values.credentialFile), { recursive: true, mode: 0o700 });
  // Refuse to replace an existing credential file or follow a symlink.
  const file = await open(values.credentialFile, "wx", 0o600);
  let written = false;
  try {
    await db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('neptun.initial-admins'))",
      );
      const found = await client.query(
        "SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE o.slug=$2 AND m.account_role IN ('admin','superadmin') UNION ALL SELECT 1 FROM users WHERE lower(email)=ANY($1::text[])",
        [accounts.map((account) => account.email), values.organizationSlug],
      );
      if (found.rows.length)
        throw new Error(
          "Initial administrators or their addresses already exist. Existing accounts and passwords are preserved.",
        );
      const organization = await client.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id",
        [values.organizationName, values.organizationSlug],
      );
      const organizationId = organization.rows[0]!.id;
      await client.query(
        "INSERT INTO settings(organization_id,value) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [organizationId, settings],
      );
      const credentials: string[] = [
        "Neptun Broshura — default administrator credentials",
        "These two operator-approved default accounts use regular password login.",
        "The Neptun address is a login identifier; recovery email requires a working mailbox.",
      ];
      for (const account of accounts) {
        const password = randomBytes(24).toString("base64url");
        const passwordHash = await hash(password, {
          type: argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
        });
        const result = await client.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password,email_verified_at) VALUES($1,$2,$3,false,now()) RETURNING id",
          [account.email, account.name, passwordHash],
        );
        const userId = result.rows[0]!.id;
        await client.query(
          "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role,status) VALUES($1,$2,'admin','pm',$3,'active')",
          [organizationId, userId, account.role],
        );
        await client.query(
          "INSERT INTO account_audit(organization_id,user_id,action,detail) VALUES($1,$2,'user.bootstrap-password',$3)",
          [
            organizationId,
            userId,
            {
              role: account.role,
              verification: "operator",
              mustChangePassword: false,
            },
          ],
        );
        credentials.push(
          "",
          account.name,
          `Email: ${account.email}`,
          `Password: ${password}`,
        );
      }
      await file.writeFile(credentials.join("\n") + "\n", "utf8");
      await file.sync();
    });
    written = true;
    return {
      accounts: accounts.map(({ email, role }) => ({ email, role })),
      credentialFile: values.credentialFile,
    };
  } finally {
    await file.close();
    if (!written) await unlink(values.credentialFile);
  }
}
