# Memory and availability review — 9 November 2026

Render recorded a runtime OOM on the existing 512 MB combined API/worker instance. The graph showed an elevated plateau with bursts, rather than proving a steadily growing JavaScript leak. The application did not previously log process/native/container memory, so the precise allocation at the kill cannot be established retrospectively.

## Changes

- The worker processes thumbnail/preview jobs sequentially. It still claims small batches and polls within two seconds, so this is not one image every ten seconds. Native capacity is reserved **before** reading the original and retained through persistence. Reads enforce the asset's declared byte size and the existing 32 MiB maximum. Already-generated variants skip the original read entirely.
- The API and worker both limit Sharp to one native thread per operation and a 16 MiB cache, including standalone entry points. Both combined children use one libuv thread and two malloc arenas. Password hash parameters and cryptographic verification are unchanged.
- Export image cache misses have two active download slots, eight byte-free waiting slots and a 24 MB source-byte budget. Matching tenant/URL requests reuse one in-flight download. Admission precedes database transactions; cache hits bypass that work. Capacity failures return retryable 429 responses, rather than initiating unbounded downloads.
- Catalog HTML is capped while streaming decoded HTTP bytes, including missing/misleading Content-Length and compressed bodies. Oversized/error responses are canceled and reader locks released.
- SVG/AVIF conversion to PNG is capped at 16 megapixels before pixel allocation. Existing PNG/JPEG/WebP originals retain their previous storage/pixel policy; they are not resized or replaced by this change.
- Protected request bodies are authenticated before JSON/raw parsing. Public identity forms retain their separate 64 KiB cap. Unexpected GET bodies are rejected, session checks are bounded, and the existing origin/role/password-change guards remain authoritative.
- Each process logs numeric RSS, heap, external/Buffer memory and available cgroup totals once a minute. Warnings start at 80% of the container limit. The monitor has an unreferenced, stoppable timer and cannot fail the application if counters are unavailable. It logs no request bodies, credentials or user identities.

## Operational limits

Heap/cache/admission limits reduce peaks; they are not a proof that arbitrary workloads fit 512 MB. The API and worker share the container, and long-lived native allocator reservations can outlast an individual operation. Observe numeric memory under normal editing/export work before raising concurrency. If sustained memory pressure remains, isolate the worker or increase capacity with the account owner's approval; do not weaken authentication, pixel limits or health checks.

Keep `/ready` as Render's HTTP health check and keep media in R2 with no persistent disk attached. Render deploys a replacement before switching traffic, then drains the old instance. Do not manually restart the live service as a workaround for memory pressure. A single instance can still experience an unexpected platform/process failure; uninterrupted service through every such failure requires redundant capacity.

Focused tests exercise bounded download/native admission, release on failure, duplicate reuse, oversized streamed pages, early authentication, SVG pixel rejection, numeric telemetry and graceful supervisor shutdown. Tests use local fixtures/mocks or the isolated test database, never paid image generation or a production load test.

References: [Render deploys](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks), [memory exhaustion](https://render.com/docs/troubleshooting-deploys#memory-exhaustion).
