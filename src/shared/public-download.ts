import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

export interface PublicDownload {
  bytes: Buffer;
  mimeType: string;
  url: string;
}
interface Address {
  address: string;
  family: number;
}
interface Reply {
  status: number;
  location?: string;
  mimeType: string;
  bytes: Buffer;
}
export interface PublicDownloadDependencies {
  resolve(hostname: string): Promise<Address[]>;
  request(url: URL, address: Address, maxBytes: number): Promise<Reply>;
}

/** Only globally routable addresses. In particular, reject IPv4-mapped IPv6,
 * link-local metadata endpoints, documentation and transition address ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
  );
}

export function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    hostname === "localhost" ||
    /\.(?:localhost|local|internal|test)$/.test(hostname) ||
    (isIP(hostname) !== 0 && !isPublicAddress(hostname))
  )
    throw new Error("Only public HTTPS sources are supported.");
  url.hash = "";
  return url;
}

const defaults: PublicDownloadDependencies = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: (url, address, maxBytes) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          family: address.family,
          // Pin the validated resolution for this connection, preventing DNS rebinding.
          lookup: (_host, _options, callback) =>
            callback(null, address.address, address.family),
          signal: AbortSignal.timeout(12_000),
          headers: {
            Accept:
              "text/html,image/png,image/jpeg,image/webp,image/avif,image/gif",
            "Accept-Encoding": "identity",
            "User-Agent": "NeptunBrochureImageLookup/1.0",
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const mimeType =
            (response.headers["content-type"] ?? "")
              .split(";")[0]
              ?.trim()
              .toLowerCase() ?? "";
          if (
            Number(response.headers["content-length"] ?? 0) > maxBytes ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity")
          ) {
            response.destroy();
            reject(new Error("Remote source exceeds the download limit."));
            return;
          }
          if (status >= 300 && status < 400) {
            response.destroy();
            resolve({
              status,
              location: response.headers.location,
              mimeType,
              bytes: Buffer.alloc(0),
            });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy(
                new Error("Remote source exceeds the download limit."),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({ status, mimeType, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    }),
};

export async function downloadPublic(
  value: string,
  maxBytes: number,
  dependencies: PublicDownloadDependencies = defaults,
  validateSource: (url: URL) => void = () => {},
): Promise<PublicDownload> {
  let url = publicHttpsUrl(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    validateSource(url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      dependencies.resolve(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("DNS lookup timed out.")),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicAddress(address))
    )
      throw new Error("Remote source does not resolve to a public address.");
    const address = addresses[0];
    if (!address) throw new Error("Remote source unavailable.");
    const reply = await dependencies.request(url, address, maxBytes);
    if (reply.status >= 300 && reply.status < 400 && reply.location) {
      url = publicHttpsUrl(new URL(reply.location, url).href);
      continue;
    }
    if (
      reply.status !== 200 ||
      reply.bytes.length > maxBytes ||
      !reply.bytes.length
    )
      throw new Error("Remote source unavailable or oversized.");
    return { bytes: reply.bytes, mimeType: reply.mimeType, url: url.href };
  }
  throw new Error("Remote source has too many redirects.");
}
