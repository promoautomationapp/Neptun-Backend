import {
  mkdir,
  readFile,
  writeFile,
  access,
  unlink,
  rename,
} from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { StoragePort } from "./storage.port";

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
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  }
  read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
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
