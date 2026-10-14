import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StoragePort } from "./storage.port";
import { env } from "../../config/environment";
import { readWithStorageRetry } from "./storage-retry";

export class R2Storage implements StoragePort {
  private readonly client = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: mimeType,
        CacheControl: "private, max-age=31536000, immutable",
      }),
    );
  }
  async read(key: string): Promise<Buffer> {
    return readWithStorageRetry(async () => {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
      );
      if (!result.Body) throw new Error("Storage object is empty.");
      return Buffer.from(await result.Body.transformToByteArray());
    });
  }
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "NotFound") return false;
      throw error;
    }
  }
  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    );
  }
  signedRead(key: string, expiresSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
      { expiresIn: expiresSeconds },
    );
  }
  signedUpload(
    key: string,
    mimeType: string,
    expiresSeconds = 300,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        ContentType: mimeType,
      }),
      { expiresIn: expiresSeconds },
    );
  }
}
