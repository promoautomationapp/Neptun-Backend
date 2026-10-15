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
import { withStorageDeadline } from "./storage-deadline";

export class R2Storage implements StoragePort {
  private readonly client = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    requestHandler: {
      connectionTimeout: 5000,
      socketTimeout: 15_000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 2,
  });
  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    await withStorageDeadline((signal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
          CacheControl: "private, max-age=31536000, immutable",
        }),
        { abortSignal: signal },
      ),
    );
  }
  async read(key: string): Promise<Buffer> {
    return readWithStorageRetry(() =>
      withStorageDeadline(async (signal) => {
        const result = await this.client.send(
          new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
          { abortSignal: signal },
        );
        if (!result.Body) throw new Error("Storage object is empty.");
        const body = result.Body;
        const abort = () => {
          if ("destroy" in body && typeof body.destroy === "function")
            body.destroy();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) {
            abort();
            throw signal.reason;
          }
          return Buffer.from(await body.transformToByteArray());
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }),
    );
  }
  async exists(key: string): Promise<boolean> {
    try {
      await withStorageDeadline((signal) =>
        this.client.send(
          new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
          { abortSignal: signal },
        ),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "NotFound") return false;
      throw error;
    }
  }
  async remove(key: string): Promise<void> {
    await withStorageDeadline((signal) =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
        { abortSignal: signal },
      ),
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
