import sharp from "sharp";

// Inspect the returned PNG without resizing or re-encoding the product pixels.
export async function validateProductCutout(bytes: Buffer): Promise<Buffer> {
  const invalid = "AI did not return a usable transparent product image. Try again.";
  try {
    const image = sharp(bytes, {limitInputPixels: 40_000_000});
    const metadata = await image.metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height || !metadata.hasAlpha) throw new Error(invalid);
    const stats = await image.stats();
    const alpha = stats.channels.at(-1);
    if (!alpha || alpha.min >= 20 || alpha.max <= 230) throw new Error(invalid);
    return bytes;
  } catch {
    throw new Error(invalid);
  }
}
