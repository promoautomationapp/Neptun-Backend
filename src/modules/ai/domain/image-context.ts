export interface BackgroundContext {
  kind: string;
  image?: string;
  color?: string;
  description?: string;
  gradient?: { from: string; to: string; angle: number };
}
export const IMAGE_PREPARATION_REVISION = 3;

// Preserve every existing opaque signature. Translucent paint uses its actual
// appearance on white paper, identically to the client's canonical context.
function color(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)
  )
    return "";
  const hex = value.toLowerCase();
  if (hex.length === 7) return hex;
  const alpha = parseInt(hex.slice(7, 9), 16) / 255;
  return (
    "#" +
    [1, 3, 5]
      .map((offset) =>
        Math.round(
          parseInt(hex.slice(offset, offset + 2), 16) * alpha +
            255 * (1 - alpha),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

// Keep the same canonical context on the client and server. Image URLs identify
// the background; the signature stored on a product never contains image data.
export function normalizeImageBackgroundContext(
  value: BackgroundContext | null | undefined,
) {
  if (!value || typeof value !== "object") return { kind: "none" };
  const description = String(value.description || "")
    .trim()
    .slice(0, 500);
  const image = typeof value.image === "string" ? value.image : "";
  const from = color(value.gradient?.from);
  const to = color(value.gradient?.to);
  const angle = Number(value.gradient?.angle);
  const solid = color(value.color);
  let result: BackgroundContext;
  if (value.kind === "image" && image)
    result = { kind: "image", ...(solid ? { color: solid } : {}), image };
  else if (value.kind === "gradient" && from && to && Number.isFinite(angle))
    result = {
      kind: "gradient",
      gradient: { from, to, angle: Math.max(0, Math.min(360, angle)) },
    };
  else if (solid) result = { kind: "solid", color: solid };
  else result = { kind: "none" };
  if (description) result.description = description;
  return result;
}

export function imageBackgroundSignature(
  value: BackgroundContext | null | undefined,
) {
  const canonical = JSON.stringify(normalizeImageBackgroundContext(value));
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `bg-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
