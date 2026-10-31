import {
  redactPrivateText,
  redactPrivateValues,
} from "../../src/modules/documents/private-identity";
const identities = [
  {
    id: "f028b7ef-47ba-499b-a1f6-a5276b09572f",
    email: "private@example.test",
    name: "Hidden Operator",
    account_role: "superadmin",
  },
  {
    id: "disabled-user-id",
    email: "former@example.test",
    name: "Former Colleague",
    account_role: "staff",
  },
];
test("redacts nested review extension identities without leaking role, email, name, or ID", () => {
  const raw = {
    authorEmail: identities[0]!.email,
    authorId: identities[0]!.id,
    authorRole: "superadmin",
    profile: { name: identities[0]!.name },
    text: `Quoted ${identities[0]!.email} and ${identities[1]!.name}`,
    replies: [{ userId: identities[1]!.id }],
  };
  const view = redactPrivateValues(raw, identities);
  expect(JSON.stringify(view)).not.toMatch(
    /private@example\.test|Hidden Operator|Former Colleague|superadmin|disabled-user-id|f028b7ef/,
  );
  expect(view.authorRole).toBe("admin");
  expect(view.text).toBe("Quoted Workspace team and Team member");
  expect(raw.authorEmail).toBe("private@example.test");
});
test("leaves ordinary customer text and technical values unchanged", () => {
  const value = "Samsung 65-inch TV, 4K UHD, 299 €";
  expect(redactPrivateText(value, identities)).toBe(value);
  expect(
    redactPrivateValues(
      { text: value, role: "pm", position: { x: 10, y: 12 } },
      identities,
    ),
  ).toEqual({ text: value, role: "pm", position: { x: 10, y: 12 } });
});

test("redaction never corrupts longer active identities sharing a private email, ID, or full-name substring", () => {
  const active = [
    "newprivate@example.test",
    "pre-private@example.test",
    "old.private@example.test",
    "private@example.test.co",
    "Hidden Operatorly",
    "PreHidden Operator",
    "Former Colleagues",
    `prefix${identities[0]!.id}`,
    `${identities[0]!.id}suffix`,
    `prefix-${identities[0]!.id}`,
  ].join("; ");
  expect(redactPrivateText(active, identities)).toBe(active);
  expect(
    redactPrivateValues(
      {
        authorEmail: "newprivate@example.test",
        name: "Hidden Operatorly",
        text: active,
      },
      identities,
    ),
  ).toEqual({
    authorEmail: "newprivate@example.test",
    name: "Hidden Operatorly",
    text: active,
  });
  expect(
    redactPrivateText(
      "<PRIVATE@EXAMPLE.TEST>, private@example.test.",
      identities,
    ),
  ).toBe("<Workspace team>, Workspace team.");
});
