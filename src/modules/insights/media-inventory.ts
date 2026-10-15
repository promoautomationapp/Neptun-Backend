import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/environment";
import { withStorageDeadline } from "../storage/storage-deadline";

export interface BucketInventory {
  objects: number;
  bytes: number;
  checkedAt: string;
}
interface Entry {
  result: BucketInventory | null;
  expires: number;
  pending: boolean;
  error: boolean;
}

/** One scan per organization, independent of requests and never on the response path. */
export class MediaInventoryCache {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly scan: (
      org: string,
    ) => Promise<BucketInventory> = scanR2Inventory,
  ) {}
  status(org: string) {
    let entry = this.entries.get(org);
    if (!entry) {
      entry = { result: null, expires: 0, pending: false, error: false };
      this.entries.set(org, entry);
    }
    if (!entry.pending && entry.expires <= Date.now()) {
      entry.pending = true;
      entry.error = false;
      const current = entry;
      // The explicit deadline also handles transports that ignore cancellation.
      void withStorageDeadline(() => this.scan(org), 45_000)
        .then((result) => {
          current.result = result;
          current.expires = Date.now() + 300_000;
        })
        .catch(() => {
          current.error = true;
          current.expires = Date.now() + 30_000;
        })
        .finally(() => {
          current.pending = false;
        });
    }
    return {
      bucket: entry.result,
      bucketPending: entry.pending,
      bucketStale: Boolean(entry.result && (entry.pending || entry.error)),
      bucketError: entry.error,
    };
  }
}

async function scanR2Inventory(org: string): Promise<BucketInventory> {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    requestHandler: {
      connectionTimeout: 3000,
      requestTimeout: 7000,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 1,
  });
  try {
    return await withStorageDeadline(async (signal) => {
      let token: string | undefined;
      let objects = 0,
        bytes = 0;
      const tokens = new Set<string>();
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: env.R2_BUCKET,
            Prefix: `org/${org}/`,
            ContinuationToken: token,
          }),
          { abortSignal: signal },
        );
        for (const item of page.Contents ?? []) {
          objects++;
          bytes += item.Size ?? 0;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!token || tokens.has(token)))
          throw new Error("Incomplete R2 inventory.");
        if (token) tokens.add(token);
      } while (token);
      return { objects, bytes, checkedAt: new Date().toISOString() };
    }, 40_000);
  } finally {
    client.destroy();
  }
}
