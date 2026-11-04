import sharp from "sharp";
import {
  ProductCutoutValidationError,
  validateProductCutout,
} from "../../src/worker/ai/product-cutout";

async function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), (y * width + x) * 4);
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
const clear: [number, number, number, number] = [0, 0, 0, 0];
const white: [number, number, number, number] = [255, 255, 255, 255];

test("an already tightly framed transparent product retains every byte", async () => {
  const bytes = await png(20, 20, (x, y) =>
    x >= 2 && x < 18 && y >= 2 && y < 18 ? white : clear,
  );
  expect(await validateProductCutout(bytes)).toBe(bytes);
});

test("a large product with a genuine one-pixel transparent exterior is accepted", async () => {
  const bytes = await png(1024, 1024, (x, y) =>
    x === 0 || y === 0 || x === 1023 || y === 1023 ? clear : white,
  );
  expect(await validateProductCutout(bytes)).toBe(bytes);
});

test("only empty outside padding is trimmed; white product pixels and faint parts are preserved exactly", async () => {
  const bytes = await png(120, 80, (x, y) => {
    if (x === 20 && y === 40) return [30, 80, 100, 1];
    if (x >= 45 && x < 75 && y >= 25 && y < 55) return white;
    return clear;
  });
  const result = await validateProductCutout(bytes);
  expect(await sharp(result).metadata()).toMatchObject({
    width: 59,
    height: 34,
    hasAlpha: true,
  });
  const expected = await sharp(bytes)
    .extract({ left: 18, top: 23, width: 59, height: 34 })
    .raw()
    .toBuffer();
  expect(await sharp(result).raw().toBuffer()).toEqual(expected);
  expect(expected.filter((value) => value === 255).length).toBe(30 * 30 * 4);
});

test("an opaque photo with token alpha or only an interior transparent hole is not a finished cutout", async () => {
  const invalid = [
    await png(100, 100, (x, y) => (x === 0 && y === 0 ? clear : white)),
    await png(100, 100, (x, y) =>
      x >= 30 && x < 70 && y >= 30 && y < 70 ? clear : white,
    ),
    await png(100, 100, () => white),
    await png(100, 100, () => clear),
    await png(100, 100, (x, y) =>
      x >= 30 && x < 70 && y >= 30 && y < 70 ? white : [255, 255, 255, 1],
    ),
    await png(100, 100, (x, y) => (x === 50 && y === 50 ? white : clear)),
    Buffer.from("invalid image"),
  ];
  for (const bytes of invalid)
    await expect(validateProductCutout(bytes)).rejects.toBeInstanceOf(
      ProductCutoutValidationError,
    );
});

test("a translucent coloured backdrop with clear outer borders is rejected, not saved as a cutout", async () => {
  const halo = await png(100, 100, (x, y) => {
    if (x < 2 || y < 2 || x >= 98 || y >= 98) return clear;
    if (x >= 30 && x < 70 && y >= 30 && y < 70) return white;
    return [210, 160, 170, 100];
  });
  await expect(validateProductCutout(halo)).rejects.toBeInstanceOf(
    ProductCutoutValidationError,
  );
});
