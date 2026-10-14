// An explicit brand takes precedence over compatible-device names on accessories.
export function isAppleProduct(
  product: { brand?: string; name?: string } | null | undefined,
) {
  const brand = String(product?.brand || "").trim();
  if (brand) return brand.toUpperCase() === "APPLE";
  return /^(?:APPLE\b|IPHONE\b|IPAD\b|MACBOOK\b|IMAC\b|AIRPODS\b|APPLE WATCH\b)/i.test(
    String(product?.name || "").trim(),
  );
}
