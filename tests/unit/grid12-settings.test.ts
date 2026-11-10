import { workspaceSettingsSchema } from "../../src/modules/settings/domain/settings.schema";

it("accepts the12offer grid in saved workspace layout defaults", () => {
  const settings = workspaceSettingsSchema.parse({
    brochure: { layout: "grid12" },
  });
  expect(settings.brochure.layout).toBe("grid12");
});
