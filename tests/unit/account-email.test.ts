import { accountEmail, escapeHtml } from "../../src/modules/email/templates";
import {
  decryptEmail,
  encryptEmail,
} from "../../src/modules/email/email.service";
describe("account email rendering", () => {
  test("HTML escapes user names and keeps the readable text alternative", () => {
    const email = accountEmail({
      to: "user@example.test",
      name: '<script>alert("x")</script>',
      kind: "invitation",
      url: "https://workspace.test/account/invitation?token=opaque",
      role: "staff",
    });
    expect(email.html).not.toContain("<script>alert");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain('role="presentation"');
    expect(email.text).toContain("expires in 48 hours");
    expect(escapeHtml("A&B")).toBe("A&amp;B");
  });
  test("invitation has readable role, mobile layout and clickable fallback link", () => {
    const url = "https://workspace.test/account/invitation?token=dummy&lang=en";
    const email = accountEmail({
      to: "user@example.test",
      name: "Arta",
      kind: "invitation",
      url,
      role: "pm",
    });
    expect(email.html).toContain("as a project manager");
    expect(email.html).toContain("max-width:480px");
    expect(email.html).toContain('width="600"');
    expect(
      email.html.match(
        /href="https:\/\/workspace\.test\/account\/invitation\?token=dummy&amp;lang=en"/g,
      ),
    ).toHaveLength(2);
    expect(email.text).toContain(`Accept invitation: ${url}`);
  });
  test("verification code is visible but not exposed in the inbox preview", () => {
    const email = accountEmail({
      to: "user@example.test",
      name: "Arta",
      kind: "verification",
      code: "123456",
      url: "https://workspace.test/not-a-verification-action",
    });
    expect(email.html).toContain("123456");
    expect(email.html).toContain("Valid for 10 minutes");
    expect(
      email.html.match(/<div[^>]*mso-hide:all[^>]*>(.*?)<\/div>/)?.[1],
    ).not.toContain("123456");
    expect(email.html).not.toContain("Reset password</span>");
    expect(email.html).not.toContain("not-a-verification-action");
    expect(email.text).toContain("Verification code: 123456");
  });
  test.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://user:password@workspace.test/accept",
    "not an absolute URL",
  ])("does not render unsafe action URLs: %s", (url) => {
    const email = accountEmail({
      to: "user@example.test",
      name: "Arta",
      kind: "password-reset",
      url,
    });
    expect(email.html).not.toContain('href="');
    expect(email.text).not.toContain(url);
    expect(email.text).toContain("expires in 30 minutes");
  });
  test("password change notice offers a clear recovery path and no code", () => {
    const email = accountEmail({
      to: "user@example.test",
      name: "Arta",
      kind: "password-changed",
    });
    expect(email.html).toContain("Open workspace");
    expect(email.text).toContain("Forgot password on the sign-in screen");
    expect(email.text).toContain("All previous sessions have been signed out");
    expect(email.html).not.toContain("VERIFICATION CODE</p>");
  });
  test("outbox payloads encrypt secrets and authenticate ciphertext", () => {
    const input = {
      to: "user@example.test",
      name: "User",
      kind: "verification" as const,
      code: "748391",
    };
    const encrypted = encryptEmail(input);
    expect(encrypted).not.toContain("748391");
    expect(decryptEmail(encrypted)).toEqual(input);
    expect(encryptEmail(input)).not.toEqual(encrypted);
    const chunks = encrypted.split(".");
    chunks[2] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptEmail(chunks.join("."))).toThrow();
  });
});
