/** An expected policy failure: retrying the same object cannot make it smaller. */
export class StorageReadLimitError extends Error {
  override name = "StorageReadLimitError";
  constructor() {
    super("Stored object exceeds the allowed byte limit.");
  }
}

export function validateReadLimit(maxBytes: number | undefined): void {
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
  )
    throw new Error("Invalid storage read limit.");
}

/** Count actual chunks as well as metadata; length headers are not trusted. */
export async function readBoundedStream(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new StorageReadLimitError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
