import sharp from "sharp";

/** Apply to both the API and worker, including standalone entry points.
 * Heap limits do not cover libvips' native caches or per-operation threads. */
export function configureImageRuntime(): void {
  sharp.cache({ memory: 16, files: 0, items: 50 });
  sharp.concurrency(1);
}
