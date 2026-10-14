import nodemailer from "nodemailer";
import { env } from "../src/config/environment";
import {
  safeEmailFailure,
  smtpTransportOptions,
} from "../src/modules/email/email-transport";

// This command authenticates only. It never creates an email or processes the outbox.
async function verify(): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    console.error("SMTP configuration is incomplete. No message was sent.");
    process.exitCode = 1;
    return;
  }
  if (env.SMTP_PORT === 465 && !env.SMTP_SECURE) {
    console.error("SMTP port 465 requires TLS. No message was sent.");
    process.exitCode = 1;
    return;
  }
  const transport = nodemailer.createTransport(smtpTransportOptions(env));
  try {
    await transport.verify();
    console.log("SMTP TLS and authentication verified. No message was sent.");
    console.log(
      "A different From address still requires provider verification and domain authentication.",
    );
  } catch (error) {
    console.error(safeEmailFailure(error).message);
    console.error("No message was sent.");
    process.exitCode = 1;
  } finally {
    transport.close();
  }
}

void verify();
