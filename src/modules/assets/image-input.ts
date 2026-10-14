import { BadRequestException } from "@nestjs/common";
import sharp from "sharp";
import type { Metadata, Sharp } from "sharp";

export const UPLOAD_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/avif",
] as const;
const MAX_IMAGE_PIXELS = 67_000_000;

// SVG scripts and references are never served as uploaded active content.
// AVIF shares the same portable PNG path, retaining its alpha channel.
export async function canonicalAssetInput(bytes: Buffer, mimeType: string) {
  if (!mimeType.startsWith("image/"))
    return { bytes, mimeType, width: null, height: null };
  let image: Sharp;
  let details: Metadata;
  try {
    image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
    details = await image.metadata();
    if (
      !details.width ||
      !details.height ||
      details.width * details.height > MAX_IMAGE_PIXELS
    )
      throw new Error("Invalid image dimensions.");
  } catch {
    throw new BadRequestException(
      "Invalid image or image exceeds the pixel limit.",
    );
  }
  const detected =
    details.mediaType ||
    (details.format === "svg"
      ? "image/svg+xml"
      : details.format === "heif" && details.compression === "av1"
        ? "image/avif"
        : `image/${details.format}`);
  if (detected !== mimeType)
    throw new BadRequestException(
      "Image MIME type does not match the file contents.",
    );
  if (mimeType === "image/svg+xml" || mimeType === "image/avif") {
    try {
      const normalized = await image
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        bytes: normalized.data,
        mimeType: "image/png",
        width: normalized.info.width,
        height: normalized.info.height,
      };
    } catch {
      throw new BadRequestException("The image could not be converted to PNG.");
    }
  }
  return { bytes, mimeType, width: details.width, height: details.height };
}

export function embeddedImageInput(value: string) {
  const match =
    /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml|avif))((?:;[^,]*)?),(.*)$/is.exec(
      value,
    );
  if (!match) return null;
  const mimeType = (match[1] ?? "").toLowerCase();
  const parameters = (match[2] ?? "").toLowerCase();
  const payload = match[3] ?? "";
  if (parameters.split(";").includes("base64")) {
    if (!/^[a-zA-Z0-9+/=\s]+$/.test(payload))
      throw new BadRequestException("Invalid embedded image encoding.");
    return { mimeType, bytes: Buffer.from(payload, "base64") };
  }
  if (mimeType !== "image/svg+xml") return null;
  try {
    return {
      mimeType,
      bytes: Buffer.from(decodeURIComponent(payload), "utf8"),
    };
  } catch {
    throw new BadRequestException("Invalid embedded SVG encoding.");
  }
}
