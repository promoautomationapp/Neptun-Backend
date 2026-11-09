import { readFile } from "node:fs/promises";
import { logger } from "./logger";

const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Log only numeric process/container measurements; never request/user data.
 * cgroup readings include both children in the combined Render instance. */
export function startMemoryTelemetry(role: "api" | "worker"): () => void {
  let reading = false;
  const sample = async () => {
    if (reading) return;
    reading = true;
    try {
      const usage = process.memoryUsage();
      const fields: Record<string, string | number> = {
        role,
        rssMiB: mib(usage.rss),
        heapUsedMiB: mib(usage.heapUsed),
        heapTotalMiB: mib(usage.heapTotal),
        externalMiB: mib(usage.external),
        arrayBuffersMiB: mib(usage.arrayBuffers),
      };
      if (process.platform === "linux") {
        const [current, limit] = await Promise.all([
          readFile("/sys/fs/cgroup/memory.current", "utf8").catch(() => ""),
          readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => ""),
        ]);
        if (current.trim() && Number.isFinite(Number(current)))
          fields.containerMiB = mib(Number(current));
        if (limit.trim() && Number.isFinite(Number(limit)))
          fields.containerLimitMiB = mib(Number(limit));
      }
      if (Number(fields.containerMiB) > Number(fields.containerLimitMiB) * 0.8)
        logger.warn(fields, "Runtime memory pressure");
      else logger.info(fields, "Runtime memory usage");
    } catch {
      // Observability must never take down the service it monitors.
    } finally {
      reading = false;
    }
  };
  void sample();
  const timer = setInterval(() => {
    void sample();
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
