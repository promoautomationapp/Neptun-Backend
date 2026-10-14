import sharp from "sharp";
import {validateProductCutout} from "../../src/worker/ai/product-cutout";

async function png(alpha: number, foreground = false) {
  const image = sharp({create: {width: 24, height: 16, channels: 4, background: {r: 255, g: 255, b: 255, alpha}}});
  if (foreground) image.composite([{input: Buffer.from('<svg width="24" height="16"><rect x="4" y="4" width="16" height="8" fill="#123456"/></svg>')}]);
  return image.png().toBuffer();
}

test("a transparent product PNG retains every original byte and full canvas", async () => {
  const bytes = await png(0, true);
  const result = await validateProductCutout(bytes);
  expect(result).toBe(bytes);
  expect(await sharp(result).metadata()).toMatchObject({width: 24, height: 16, hasAlpha: true});
});

test("opaque, empty and malformed images cannot be used as finished cutouts", async () => {
  await expect(validateProductCutout(await png(1))).rejects.toThrow("transparent product image");
  await expect(validateProductCutout(await png(0))).rejects.toThrow("transparent product image");
  await expect(validateProductCutout(Buffer.from("invalid image"))).rejects.toThrow("transparent product image");
});
