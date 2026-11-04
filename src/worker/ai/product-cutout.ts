import sharp from "sharp";
import { withImageConversion } from "../../security/image-work";

export class ProductCutoutValidationError extends Error {
  constructor() {
    super(
      "The photo background could not be removed completely. Your original photo is unchanged. Try again or describe what needs fixing.",
    );
  }
}

/** Validate exterior transparency, then remove only wholly transparent padding.
 * Never infer background from white/color: white products, glass, screen content
 * and even faint alpha pixels must all survive unchanged. */
export async function validateProductCutout(bytes: Buffer): Promise<Buffer> {
  return withImageConversion(async () => {
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      const { width, height } = metadata;
      if (
        metadata.format !== "png" ||
        !width ||
        !height ||
        !metadata.hasAlpha ||
        (metadata.pages ?? 1) !== 1
      )
        throw new ProductCutoutValidationError();
      const alpha = await image
        .clone()
        .extractChannel("alpha")
        .raw()
        .toBuffer();
      let transparent = 0;
      let opaque = 0;
      let translucent = 0;
      let clearBorder = 0;
      let borderPixels = 0;
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const value = alpha[y * width + x]!;
          if (value === 0) transparent++;
          if (value >= 230) opaque++;
          else if (value > 0) translucent++;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
            borderPixels++;
            if (value === 0) clearBorder++;
          }
          if (value > 0) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
      }
      const pixels = width * height;
      // A token transparent corner is not a cutout. Require a meaningful clear
      // exterior rather than accepting an otherwise opaque white rectangle.
      if (
        transparent <
          Math.max(4, Math.min(pixels * 0.005, borderPixels * 0.5)) ||
        opaque < Math.max(4, pixels * 0.0001) ||
        // Wide soft-alpha glows/backdrops can have transparent borders while
        // still covering the page. Reject them; never erase uncertain pixels
        // from the product or silently mark the original as a finished cutout.
        translucent > Math.max(pixels * 0.02, opaque * 0.15) ||
        clearBorder < borderPixels * 0.25 ||
        right < left ||
        bottom < top
      )
        throw new ProductCutoutValidationError();

      const padding = Math.max(
        2,
        Math.ceil(Math.max(right - left + 1, bottom - top + 1) * 0.01),
      );
      left = Math.max(0, left - padding);
      top = Math.max(0, top - padding);
      right = Math.min(width - 1, right + padding);
      bottom = Math.min(height - 1, bottom + padding);
      if (
        left === 0 &&
        top === 0 &&
        right === width - 1 &&
        bottom === height - 1
      )
        return bytes;
      return await image
        .extract({
          left,
          top,
          width: right - left + 1,
          height: bottom - top + 1,
        })
        .png()
        .toBuffer();
    } catch {
      throw new ProductCutoutValidationError();
    }
  });
}
