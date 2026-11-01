import {
  mkdir,
  readFile,
  open,
  writeFile,
  access,
  unlink,
  rename,
} from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { StoragePort } from "./storage.port";
import {
  readBoundedStream,
  StorageReadLimitError,
  validateReadLimit,
} from "./storage-read-limit";

export class LocalStorage implements StoragePort {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!key || isAbsolute(key) || key.includes("\\") || key.includes("\0"))
      throw new Error("Invalid storage key.");
    const path = resolve(this.root, key);
    const part = relative(this.root, path);
    if (!part || part.startsWith("..") || isAbsolute(part))
      throw new Error("Invalid storage key.");
    return path;
  }
  async put(key: string, bytes: Buffer, _mimeType: string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  }
  async read(key: string, maxBytes?: number): Promise<Buffer> {
    validateReadLimit(maxBytes);
    const path = this.path(key);
    if (maxBytes === undefined) return readFile(path);
    const file = await open(path, "r");
    try {
      if ((await file.stat()).size > maxBytes)
        throw new StorageReadLimitError();
      // Read the same opened file that was checked, with a streaming second check.
      return await readBoundedStream(
        file.createReadStream({ autoClose: false }),
        maxBytes,
      );
    } finally {
      await file.close();
    }
  }
  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
  async remove(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  async signedRead(_key: string): Promise<null> {
    return null;
  }
  async signedUpload(_key: string, _mimeType: string): Promise<null> {
    return null;
  }
}
