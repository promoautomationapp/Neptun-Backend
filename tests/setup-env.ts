import { config } from "dotenv";
config({ quiet: true });
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must name an isolated database ending in _test.",
  );
process.env.DATABASE_URL = url;
process.env.DIRECT_DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.LOCAL_STORAGE_DIR = "./.test-storage";
process.env.STORAGE_DRIVER = "local";
process.env.R2_ACCOUNT_ID = "";
process.env.R2_ACCESS_KEY_ID = "";
process.env.R2_SECRET_ACCESS_KEY = "";
process.env.R2_BUCKET = "";
process.env.OPENAI_API_KEY = "";

process.env.MAIL_DRIVER = "disabled";
process.env.RESEND_API_KEY = "";
