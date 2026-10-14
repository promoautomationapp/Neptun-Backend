import { env } from "../../config/environment";
export interface AccountEmail {
  to: string;
  kind: "invitation" | "verification" | "password-reset" | "password-changed";
  name: string;
  url?: string;
  code?: string;
  role?: string;
  expiresAt?: string;
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (letter) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        letter
      ] ?? letter,
  );

function webUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function accountEmail(message: AccountEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = env.MAIL_BRAND_NAME;
  const titles = {
    invitation: "Your invitation to the Neptun workspace",
    verification: "Verify your email address",
    "password-reset": "Reset your workspace password",
    "password-changed": "Your password was changed",
  };
  const title = titles[message.kind];
  const greeting = message.name ? `Hello ${message.name},` : "Hello,";
  const roleNames: Record<string, string> = {
    staff: "a staff member",
    pm: "a project manager",
    admin: "an administrator",
    superadmin: "a support administrator",
  };
  const role = message.role
    ? (roleNames[message.role] ?? message.role)
    : "a team member";
  const descriptions = {
    invitation: `You have been invited to join the workspace as ${role}. Create your password, then verify your email to activate your account. This invitation expires in 48 hours.`,
    verification:
      "Enter this verification code in the workspace. It expires in 10 minutes. Keep this code private; our team will never ask you for it.",
    "password-reset":
      "We received a request to reset your password. Open the secure link below and verify the code sent to this email address. This link expires in 30 minutes. If you did not request this, you can ignore this email.",
    "password-changed":
      "Your workspace password was changed successfully. All previous sessions have been signed out. If you did not make this change, use Forgot password on the sign-in screen immediately and contact your administrator.",
  };
  const description = descriptions[message.kind];
  const previews = {
    invitation: "Your secure invitation to join the Neptun workspace.",
    verification:
      "Your email verification code is ready. It expires in 10 minutes.",
    "password-reset": "A secure link to reset your workspace password.",
    "password-changed":
      "Confirmation that your workspace password was changed.",
  };
  const action =
    message.kind === "invitation"
      ? "Accept invitation"
      : message.kind === "password-changed"
        ? "Open workspace"
        : "Reset password";
  const actionUrl =
    message.kind === "invitation" || message.kind === "password-reset"
      ? webUrl(message.url)
      : message.kind === "password-changed"
        ? webUrl(env.PUBLIC_APP_URL)
        : undefined;
  const logoUrl = webUrl(env.MAIL_LOGO_URL);
  const logo = logoUrl?.startsWith("https:")
    ? `<img src="${escapeHtml(logoUrl)}" width="160" border="0" alt="${escapeHtml(brand)}" style="display:block;max-width:160px;height:auto;color:#ffffff;font-size:18px"/>`
    : `<span style="font-weight:700;font-size:22px;line-height:30px;letter-spacing:0.5px;color:#ffffff">${escapeHtml(brand)}</span>`;
  const button = actionUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 20px"><tr><td bgcolor="#ef4023" style="border-radius:8px;text-align:center"><a href="${escapeHtml(actionUrl)}" target="_blank" style="display:inline-block;border:1px solid #ef4023;border-radius:8px;padding:15px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;mso-padding-alt:0"><!--[if mso]><i style="mso-font-width:120%;mso-text-raise:22pt" hidden>&emsp;</i><![endif]--><span style="mso-text-raise:11pt">${action}</span><!--[if mso]><i style="mso-font-width:120%" hidden>&emsp;&#8203;</i><![endif]--></a></td></tr></table><p style="margin:0 0 24px;font-size:12px;line-height:19px;color:#64748b">If the button does not work, copy this address into your browser:<br/><a href="${escapeHtml(actionUrl)}" target="_blank" style="color:#1d5b91;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(actionUrl)}</a></p>`
    : "";
  const code = message.code
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0"><tr><td bgcolor="#edf5fc" style="padding:22px 12px;border:1px solid #d5e5f4;border-radius:10px;text-align:center"><p style="margin:0 0 10px;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;color:#425c76">VERIFICATION CODE</p><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;color:#163a61">${escapeHtml(message.code)}</p><p style="margin:10px 0 0;font-size:12px;line-height:18px;color:#425c76">Valid for 10 minutes · Do not share this code</p></td></tr></table>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="x-apple-disable-message-reformatting"/><title>${escapeHtml(title)}</title><style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}img{border:0;outline:none;text-decoration:none}a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}@media screen and (max-width:480px){.email-outer{padding:24px 12px!important}.email-header{padding:24px!important}.email-content{padding:28px 24px!important}.email-title{font-size:24px!important;line-height:31px!important}}</style></head>
<body style="margin:0;padding:0;width:100%;background:#f2f5fa;font-family:Arial,Helvetica,sans-serif;color:#18324f">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:#f2f5fa;line-height:1px;font-size:1px;mso-hide:all">${escapeHtml(previews[message.kind])}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f2f5fa"><tr><td class="email-outer" align="center" style="padding:40px 16px">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;border:1px solid #dce5ef;border-radius:14px;overflow:hidden;text-align:left"><tr><td class="email-header" bgcolor="#12365d" style="padding:28px 36px;border-bottom:5px solid #ef4023">${logo}</td></tr>
<tr><td class="email-content" style="padding:36px"><p style="margin:0 0 12px;color:#c6321b;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.5px">ACCOUNT SECURITY</p><h1 class="email-title" style="margin:0 0 24px;font-size:26px;line-height:34px;font-weight:700;color:#18324f">${escapeHtml(title)}</h1><p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#18324f">${escapeHtml(greeting)}</p><p style="margin:0;font-size:15px;line-height:25px;color:#425c76">${escapeHtml(description)}</p>${code}${button}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;border-top:1px solid #e2e8f0"><tr><td style="padding-top:20px"><p style="margin:0;font-size:12px;line-height:19px;color:#64748b">This is an automated account message from ${escapeHtml(brand)}. Do not forward invitation links or verification codes.</p></td></tr></table></td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
<p style="margin:24px 0 0;text-align:center;font-size:12px;line-height:19px;color:#64748b">${escapeHtml(brand)}<br/>Secure access for your team</p></td></tr></table></body></html>`;
  return {
    subject: `${title} · ${brand}`,
    html,
    text: [
      greeting,
      title,
      description,
      message.code ? `Verification code: ${message.code}` : "",
      actionUrl ? `${action}: ${actionUrl}` : "",
      brand,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
