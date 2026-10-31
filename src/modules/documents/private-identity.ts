export interface PrivateIdentity {
  id: string;
  email: string;
  name: string;
  account_role: string;
}
export const privateIdentityQuery =
  "SELECT u.id,u.email,u.name,m.account_role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND (m.account_role='superadmin' OR m.status='disabled')";
export function privateIdentityLabel(identity: PrivateIdentity): string {
  return identity.account_role === "superadmin"
    ? "Workspace team"
    : "Team member";
}
/** Remove private identity references from quoted customer text without touching stored audit. */
export function redactPrivateText(
  value: string,
  identities: readonly PrivateIdentity[],
): string {
  const escaped = (token: string) =>
    token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = String.raw`\p{L}\p{N}_`;
  const email = `${word}@.+-`;
  return identities.reduce((text, identity) => {
    const tokens: { value: string; before: string; after: string }[] = [
      {
        value: identity.email,
        before: `(?<![${email}])`,
        // A terminal period is sentence punctuation; a continued domain is a different address.
        after: `(?!(?:[${word}@+-]|\\.[${email}]))`,
      },
      {
        value: identity.id,
        before: `(?<![${word}-])`,
        after: `(?![${word}-])`,
      },
      ...(identity.name.trim().includes(" ")
        ? [
            {
              value: identity.name,
              before: `(?<![${word}])`,
              after: `(?![${word}])`,
            },
          ]
        : []),
    ];
    return tokens
      .filter((token) => Boolean(token.value))
      .reduce(
        (result, token) =>
          result.replaceAll(
            new RegExp(
              `${token.before}${escaped(token.value)}${token.after}`,
              "giu",
            ),
            privateIdentityLabel(identity),
          ),
        text,
      );
  }, value);
}

/** Review schemas preserve extension fields; those must not bypass identity redaction. */
export function redactPrivateValues<T>(
  value: T,
  identities: readonly PrivateIdentity[],
): T {
  const visit = (entry: unknown, key = ""): unknown => {
    if (typeof entry === "string") {
      if (/role$/i.test(key) && entry === "superadmin") return "admin";
      const exact = identities.find((identity) =>
        [identity.id, identity.email, identity.name].some(
          (token) => token && token.toLowerCase() === entry.toLowerCase(),
        ),
      );
      return exact
        ? privateIdentityLabel(exact)
        : redactPrivateText(entry, identities);
    }
    if (Array.isArray(entry)) return entry.map((child) => visit(child));
    if (entry && typeof entry === "object")
      return Object.fromEntries(
        Object.entries(entry).map(([childKey, child]) => [
          childKey,
          visit(child, childKey),
        ]),
      );
    return entry;
  };
  return visit(value) as T;
}
