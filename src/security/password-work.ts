import { HttpException } from "@nestjs/common";
import { hash as argonHash, verify as argonVerify } from "argon2";
import type { Options } from "argon2";

// Argon2's existing parameters use 64 MiB per job. Reject excess work immediately
// instead of letting libuv's queue retain an unbounded number of password jobs.
let active = 0;
export async function withPasswordWork<T>(
  work: () => Promise<T> | T,
): Promise<T> {
  if (active >= 2)
    throw new HttpException(
      {
        error: "Too many requests. Please try again later.",
        code: "PASSWORD_WORK_BUSY",
        retryAfterSeconds: 1,
      },
      429,
    );
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
  }
}

export function hashPassword(
  password: Buffer | string,
  options: Options & { raw: true },
): Promise<Buffer>;
export function hashPassword(
  password: Buffer | string,
  options?: Options & { raw?: boolean },
): Promise<string>;
export function hashPassword(
  password: Buffer | string,
  options?: Options & { raw?: boolean },
): Promise<string | Buffer> {
  return withPasswordWork(() => argonHash(password, options));
}
export function verifyPassword(
  ...args: Parameters<typeof argonVerify>
): Promise<boolean> {
  return withPasswordWork(() => argonVerify(...args));
}
