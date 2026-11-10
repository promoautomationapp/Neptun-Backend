import {
  imageBackgroundSignature,
  normalizeImageBackgroundContext,
} from "../../src/modules/ai/domain/image-context";

it("retains the previously saved opaque preparation signatures", () => {
  expect(imageBackgroundSignature({ kind: "solid", color: "#AABBCC" })).toBe(
    "bg-v1:435e04da",
  );
  expect(
    imageBackgroundSignature({
      kind: "gradient",
      gradient: { from: "#1c4075", to: "#86b3de", angle: 135 },
    }),
  ).toBe("bg-v1:8a615a46");
  expect(
    imageBackgroundSignature({
      kind: "image",
      color: "#1c4075",
      image: "/photo.png",
    }),
  ).toBe("bg-v1:2f712579");
});

it("canonicalizes alpha paint to the same visible color and signature as the client", () => {
  expect(
    normalizeImageBackgroundContext({ kind: "solid", color: "#00000080" }),
  ).toEqual({ kind: "solid", color: "#7f7f7f" });
  expect(imageBackgroundSignature({ kind: "solid", color: "#00000000" })).toBe(
    imageBackgroundSignature({ kind: "solid", color: "#ffffff" }),
  );
  expect(imageBackgroundSignature({ kind: "solid", color: "#aabbccff" })).toBe(
    "bg-v1:435e04da",
  );
  expect(
    imageBackgroundSignature({
      kind: "gradient",
      gradient: { from: "#1c4075ff", to: "#86b3deff", angle: 135 },
    }),
  ).toBe("bg-v1:8a615a46");
  expect(
    normalizeImageBackgroundContext({ kind: "solid", color: "#000000;url(x)" }),
  ).toEqual({ kind: "none" });
});
