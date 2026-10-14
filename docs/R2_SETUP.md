# Cloudflare R2 setup

The current account uses the private `neptun-studio-assets` bucket. Credentials belong only in the ignored backend `.env` or the hosting provider's secret settings. Never put them in frontend environment variables or this document.

On 14 October 2026, all 10,551 registered source assets (554,556,697 bytes, approximately 529 MiB) were copied or reused and verified against their saved SHA-256 checksums. Local originals were retained. The backend and worker now use R2. The copy includes 51 prepared cutouts, 8 prepared brand cache entries, 101 catalog brand images, the remaining original photos/artwork and fonts. Existing aliases and saved document references were preserved; no AI was dispatched. The real R2 upload/confirmation/save/reopen flow passed, including duplicate-file reuse and tenant isolation. A browser export using copied R2 photos, logos and fonts produced a 1080 × 1350 PNG. See [verification report](import-reports/r2-media-migration.json).

Four current source products and ten retained legacy `Error` records already lacked primary photographs. Their records were preserved; missing vendor photographs were not replaced with generated images. All available registered files passed the migration check.

The daily catalog worker is running locally and its 03:00 Europe/Belgrade schedule is registered. Continuous hosting is still required for dependable unattended production runs. The worker creates separate preview/thumbnail variants; it does not replace the full resolution originals. The public sign-in/recovery Neptun wordmark is also included as a small frontend branding asset so it remains visible during API restarts.

Create a private R2 bucket for this application. Generate an R2 API token restricted to object read/write on that bucket. Put its account ID, access key ID, secret access key and bucket name in the backend's private `.env`. Set `STORAGE_DRIVER=r2` after copying existing objects. Frontend environment variables must never contain these credentials. `R2_PUBLIC_BASE_URL` is reserved for a deliberately public asset delivery scheme; this implementation serves original R2 bytes through the authenticated API. Stable `/api/assets/<id>` URLs keep existing documents, credentialed image inspection and canvas exports compatible with both storage adapters. Uploaded files go directly to R2 using short-lived presigned URLs, then confirmation checks the actual bytes and registers an immutable owned asset.

The S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`. Presigned URLs use the R2 S3 endpoint rather than a custom public domain. The API issues a tenant-prefixed staging upload URL after checking the authenticated session, MIME type and maximum size; confirmation validates actual bytes, computes SHA-256 and registers the durable asset. A signed URL is a temporary capability: protect it like the data it allows access to.

Apply bucket CORS for the exact frontend origin, including localhost during development. The currently verified local origin is `http://localhost:5173`. Add the actual production origin when hosting is configured:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type", "x-amz-checksum-crc32", "x-amz-checksum-sha256", "x-amz-sdk-checksum-algorithm"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace the development origin with the actual production origin before enabling production, or retain both only when development access is needed. CORS does not grant object ownership or tenant authorization. Keep the bucket private and leave public `r2.dev` access disabled. Direct uploads need PUT CORS; the API delivers browser previews and exports after its normal authentication checks.

While `STORAGE_DRIVER=local`, fill the R2 connection variables, then run `npm run storage:sync-r2 -- --dry-run`. Run `npm run storage:sync-r2 -- --concurrency=16` to copy and checksum-verify registered objects without deleting local files. Existing remote objects are verified and reused, not overwritten. Transient connection failures are retried; any checksum mismatch stops the migration. Concurrency may be set from 1 to 16. Rerunning safely resumes an interrupted copy. After success, set `STORAGE_DRIVER=r2`, restart API/worker and verify sign-in, an existing brochure, image upload and an export. Keep the local copy until restore verification is complete.

References: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).
