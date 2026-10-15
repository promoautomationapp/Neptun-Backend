import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "argon2";
import { Database } from "../../src/database/database";
import { provisionInitialAdmins } from "../../src/modules/users/initial-admins";

describe("operator-provisioned initial administrators", () => {
  const db = new Database();
  let directory: string;
  const suffix = randomUUID();
  const emails = {
    supportEmail: `support-${suffix}@example.test`,
    adminEmail: `admin-${suffix}@example.test`,
  };
  const organization = {
    organizationSlug: `bootstrap-${suffix}`,
    organizationName: "Bootstrap QA",
  };
  let credentialFile: string;
  let initialBytes: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "neptun-admins-"));
    credentialFile = join(directory, "credentials.txt");
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });

  test("creates two regular admin logins with separate salted hashes and scoped roles", async () => {
    await provisionInitialAdmins(db, {
      ...emails,
      ...organization,
      credentialFile,
    });
    initialBytes = await readFile(credentialFile, "utf8");
    const passwords = [...initialBytes.matchAll(/Password: (.+)/g)].map(
      (match) => match[1]!,
    );
    expect(passwords).toHaveLength(2);
    expect(passwords[0]).not.toBe(passwords[1]);
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
    const users = await db.query<{
      email: string;
      password_hash: string;
      must_change_password: boolean;
      account_role: string;
      status: string;
      slug: string;
    }>(
      "SELECT u.email,u.password_hash,u.must_change_password,m.account_role,m.status,o.slug FROM users u JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id WHERE o.slug=$1 ORDER BY m.account_role DESC",
      [organization.organizationSlug],
    );
    expect(users).toHaveLength(2);
    for (const [index, user] of users.entries()) {
      expect(user.password_hash).toMatch(/^\$argon2id\$/);
      expect(user.must_change_password).toBe(false);
      expect(user.status).toBe("active");
      expect(await verify(user.password_hash, passwords[index]!)).toBe(true);
    }
    expect(users.map((user) => user.account_role)).toEqual([
      "superadmin",
      "admin",
    ]);
    const audit = await db.query<{ detail: unknown }>(
      "SELECT detail FROM account_audit WHERE organization_id=(SELECT id FROM organizations WHERE slug=$1)",
      [organization.organizationSlug],
    );
    for (const password of passwords)
      expect(JSON.stringify(audit)).not.toContain(password);
    expect(
      await db.query(
        "SELECT id FROM email_outbox WHERE recipient=ANY($1::text[])",
        [[emails.supportEmail, emails.adminEmail]],
      ),
    ).toHaveLength(0);
  });

  test("reruns preserve users, password hashes and the original private credential file", async () => {
    const before = await db.query(
      "SELECT email,password_hash FROM users WHERE email=ANY($1::text[]) ORDER BY email",
      [[emails.supportEmail, emails.adminEmail]],
    );
    await expect(
      provisionInitialAdmins(db, {
        ...emails,
        ...organization,
        credentialFile,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const anotherFile = join(directory, "retry.txt");
    await expect(
      provisionInitialAdmins(db, {
        ...emails,
        ...organization,
        credentialFile: anotherFile,
      }),
    ).rejects.toThrow("already exist");
    expect(
      await db.query(
        "SELECT email,password_hash FROM users WHERE email=ANY($1::text[]) ORDER BY email",
        [[emails.supportEmail, emails.adminEmail]],
      ),
    ).toEqual(before);
    expect(await readFile(credentialFile, "utf8")).toBe(initialBytes);
    await expect(stat(anotherFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("invalid or duplicate identifiers cannot create an account", async () => {
    const duplicate = `duplicate-${suffix}@example.test`;
    await expect(
      provisionInitialAdmins(db, {
        supportEmail: duplicate,
        adminEmail: duplicate.toUpperCase(),
        credentialFile: join(directory, "invalid.txt"),
      }),
    ).rejects.toThrow("different addresses");
    await expect(
      provisionInitialAdmins(db, {
        supportEmail: "invalid",
        adminEmail: duplicate,
        credentialFile: join(directory, "invalid.txt"),
      }),
    ).rejects.toThrow();
    expect(
      await db.query("SELECT id FROM users WHERE email=$1", [duplicate]),
    ).toHaveLength(0);
  });
});
