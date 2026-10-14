# Cloudflare R2 setup

Prepared only; no bucket or token has been created by this task.

Create a private R2 bucket for this application. Generate an R2 API token restricted to object read/write on that bucket. Put its account ID, access key ID, secret access key and bucket name in the backend's private `.env`. Set `STORAGE_DRIVER=r2` after copying existing objects. Frontend environment variables must never contain these credentials. `R2_PUBLIC_BASE_URL` is reserved for a deliberately public asset delivery scheme; this implementation uses authenticated API redirects to short-lived presigned R2 URLs.

The S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`. Presigned URLs use the R2 S3 endpoint rather than a custom public domain. The API issues a tenant-prefixed staging upload URL after checking the authenticated session, MIME type and maximum size; confirmation validates actual bytes, computes SHA-256 and registers the durable asset. A signed URL is a temporary capability: protect it like the data it allows access to.

Apply bucket CORS for the exact frontend origin, including localhost during development. Example, with the actual production origin filled in later:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "https://studio.example.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type", "x-amz-checksum-sha256"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Remove the example production origin and replace it before enabling production. CORS does not grant object ownership or tenant authorization. Keep the bucket private and leave public `r2.dev` access disabled. Browser previews/exports need GET CORS as well as PUT CORS.

While `STORAGE_DRIVER=local`, fill the R2 connection variables, then run `npm run storage:sync-r2 -- --dry-run`. Run `npm run storage:sync-r2` to copy and checksum-verify registered objects without deleting local files. After success, set `STORAGE_DRIVER=r2`, restart API/worker and verify sign-in, an existing brochure, image upload and an export. Keep the local copy until restore verification is complete.

References: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).
