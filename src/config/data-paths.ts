import { homedir } from "node:os";
import { join } from "node:path";

/** Development objects and backups belong outside the application checkout. */
export const developmentDataDirectory = join(
  homedir(),
  ".local",
  "share",
  "neptun-broshura",
);
export const defaultStorageDirectory = join(
  developmentDataDirectory,
  "objects",
);
export const defaultBackupDirectory = join(developmentDataDirectory, "backups");
