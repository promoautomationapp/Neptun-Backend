import { z } from "zod";

export interface Mailbox {
  address: string;
  name: string;
}
export function hasMailControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/** Accept one mailbox, never a recipient list or raw header fragment. */
export function parseSender(value: string, fallbackName = ""): Mailbox | null {
  if (!value || hasMailControlCharacters(value)) return null;
  const trimmed = value.trim();
  const named = /^([^<>]+)\s*<([^<>]+)>$/.exec(trimmed);
  const address = (named?.[2] ?? trimmed).trim();
  if (!z.email().safeParse(address).success) return null;
  const name = named?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? fallbackName;
  if (hasMailControlCharacters(name) || /[<>]/.test(name)) return null;
  return { address, name };
}
