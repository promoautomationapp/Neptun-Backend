import { BadRequestException, HttpException } from "@nestjs/common";

export const MAX_STORED_ASSET_BYTES = 32 * 1024 * 1024;

export function imageWorkBusy() {
  return new HttpException(
    {
      error: "Images are busy. Please try again in a moment.",
      code: "IMAGE_WORK_BUSY",
      retryAfterSeconds: 1,
    },
    429,
  );
}

/** Reserve before reading any object or starting native image work. Media reads
 * and conversions have small bounded waiting rooms for normal batches; upload
 * confirmation rejects excess requests immediately. No waiting read owns bytes. */
export function createImageWorkBudget(options: {
  maxConcurrent: number;
  maxBytes: number;
  maxQueued?: number;
  maxWaitMs?: number;
}) {
  const maxQueued = options.maxQueued ?? 0;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  if (
    !Number.isSafeInteger(options.maxConcurrent) ||
    options.maxConcurrent < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    !Number.isSafeInteger(maxQueued) ||
    maxQueued < 0 ||
    !Number.isSafeInteger(maxWaitMs) ||
    maxWaitMs < 1
  )
    throw new Error("Invalid image work budget.");
  let active = 0,
    bytes = 0;
  const waiting: {
    reservedBytes: number;
    start: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }[] = [];
  const available = (reservedBytes: number) =>
    active < options.maxConcurrent && bytes + reservedBytes <= options.maxBytes;
  function drain() {
    while (waiting.length && available(waiting[0]!.reservedBytes)) {
      const next = waiting.shift()!;
      clearTimeout(next.timer);
      next.start();
    }
  }
  async function enter<T>(
    reservedBytes: number,
    operation: () => Promise<T> | T,
  ) {
    active += 1;
    bytes += reservedBytes;
    try {
      return await operation();
    } finally {
      active -= 1;
      bytes -= reservedBytes;
      drain();
    }
  }
  return {
    async run<T>(
      reservedBytes: number,
      operation: () => Promise<T> | T,
    ): Promise<T> {
      if (
        !Number.isSafeInteger(reservedBytes) ||
        reservedBytes < 1 ||
        reservedBytes > options.maxBytes
      )
        throw new BadRequestException({
          error:
            "This image exceeds the supported size. Choose a smaller image.",
          code: "IMAGE_SIZE_LIMIT",
        });
      if (!waiting.length && available(reservedBytes))
        return enter(reservedBytes, operation);
      if (waiting.length >= maxQueued) throw imageWorkBusy();
      return new Promise<T>((resolve, reject) => {
        const entry = {
          reservedBytes,
          start: () =>
            void enter(reservedBytes, operation).then(resolve, reject),
          reject,
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(imageWorkBusy());
          drain();
        }, maxWaitMs);
        waiting.push(entry);
      });
    },
  };
}

const reads = createImageWorkBudget({
  maxConcurrent: 8,
  maxBytes: 64 * 1024 * 1024,
  maxQueued: 64,
  maxWaitMs: 10_000,
});
const confirmations = createImageWorkBudget({
  maxConcurrent: 2,
  maxBytes: 24 * 1024 * 1024,
});
const conversions = createImageWorkBudget({
  maxConcurrent: 1,
  maxBytes: 1,
  maxQueued: 4,
  maxWaitMs: 10_000,
});

export const withAssetReadWork = <T>(
  bytes: number,
  work: () => Promise<T> | T,
) => reads.run(bytes, work);
export const withUploadConfirmation = <T>(work: () => Promise<T> | T) =>
  confirmations.run(12 * 1024 * 1024, work);
export const withImageConversion = <T>(work: () => Promise<T> | T) =>
  conversions.run(1, work);
