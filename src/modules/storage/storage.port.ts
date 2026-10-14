export const STORAGE = Symbol("STORAGE");
export interface StoragePort {
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  signedRead(key: string, expiresSeconds?: number): Promise<string | null>;
  signedUpload(
    key: string,
    mimeType: string,
    expiresSeconds?: number,
  ): Promise<string | null>;
}
