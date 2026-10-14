import "dotenv/config";
import { z } from "zod";
import { defaultStorageDirectory, defaultBackupDirectory } from "./data-paths";
import {
  hasMailControlCharacters,
  parseSender,
} from "../modules/email/mail-address";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default("neptun_team_session"),
  UPLOAD_SECRET: z.string().min(32),
  PUBLIC_APP_URL: z.url().default("http://localhost:5173"),
  MAIL_DRIVER: z.enum(["disabled", "resend", "smtp"]).default("disabled"),
  RESEND_API_KEY: z.string().default(""),
  MAIL_FROM: z
    .string()
    .refine(
      (value) => value === "" || Boolean(parseSender(value)),
      "MAIL_FROM must contain one valid mailbox without header characters.",
    )
    .default(""),
  MAIL_BRAND_NAME: z
    .string()
    .max(120)
    .regex(/^[^<>]*$/)
    .refine(
      (value) => !hasMailControlCharacters(value),
      "MAIL_BRAND_NAME cannot contain control characters.",
    )
    .default("Neptun Campaign Studio"),
  MAIL_LOGO_URL: z.string().default(""),
  SMTP_HOST: z
    .string()
    .max(253)
    .regex(/^[a-zA-Z0-9.-]*$/)
    .default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanString.default(false),
  SMTP_USER: z
    .string()
    .max(320)
    .refine(
      (value) => !hasMailControlCharacters(value),
      "SMTP_USER cannot contain control characters.",
    )
    .refine(
      (value) => value === value.trim(),
      "SMTP_USER cannot contain surrounding whitespace.",
    )
    .default(""),
  SMTP_PASS: z.string().default(""),
  BOOTSTRAP_SUPPORT_EMAIL: z.union([z.email(), z.literal("")]).default(""),
  BOOTSTRAP_ADMIN_EMAIL: z.union([z.email(), z.literal("")]).default(""),
  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().min(1).default(defaultStorageDirectory),
  BACKUP_DIR: z.string().min(1).default(defaultBackupDirectory),
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default(""),
  R2_PUBLIC_BASE_URL: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_TEXT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_SEARCH_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2.5-sunburst"),
  SEED_DEFAULT_PASSWORD: z.string().default(""),
  LIFESTYLE_MONTHLY_LIMIT: z.coerce.number().int().nonnegative().default(20),
  LIFESTYLE_MONTHLY_ATTEMPTS: z.coerce.number().int().nonnegative().default(30),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
  AI_IMAGE_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  AI_TEXT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  QUEUE_POLL_SECONDS: z.coerce.number().min(1).default(10),
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
});

export const env = schema.parse(process.env);
if (env.MAIL_DRIVER === "smtp" && env.SMTP_PORT === 465 && !env.SMTP_SECURE) {
  throw new Error("SMTP port 465 requires SMTP_SECURE=true.");
}
if (env.NODE_ENV === "production" && env.STORAGE_DRIVER === "local") {
  throw new Error(
    "Production requires STORAGE_DRIVER=r2. Local disk is development storage.",
  );
}
if (
  env.STORAGE_DRIVER === "r2" &&
  ![
    env.R2_ACCOUNT_ID,
    env.R2_ACCESS_KEY_ID,
    env.R2_SECRET_ACCESS_KEY,
    env.R2_BUCKET,
  ].every(Boolean)
) {
  throw new Error(
    "R2 storage requires account, access key, secret and bucket configuration.",
  );
}
