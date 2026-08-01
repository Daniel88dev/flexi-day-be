import crypto from "crypto";

// Crockford-style alphabet: no I/L/O/U/0/1, so a code read off a screen and
// typed into the join form cannot be ambiguous.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const GROUP_SIZE = 4;
const GROUPS = 3;

/**
 * A 12-character invite code formatted as `XXXX-XXXX-XXXX`. ~59 bits of
 * entropy from `randomInt`, which rejection-samples and so stays uniform over
 * the 30-character alphabet.
 */
export const generateInviteCode = (): string =>
  Array.from({ length: GROUPS }, () =>
    Array.from(
      { length: GROUP_SIZE },
      () => ALPHABET[crypto.randomInt(ALPHABET.length)] as string
    ).join("")
  ).join("-");

/**
 * Accepts what a human typed: case-insensitive, dashes and spaces optional.
 * Returns the canonical stored form, or null when it isn't a plausible code.
 */
export const normalizeInviteCode = (raw: string): string | null => {
  const stripped = raw.toUpperCase().replace(/[\s-]/g, "");
  if (stripped.length !== GROUP_SIZE * GROUPS) return null;
  if (![...stripped].every((char) => ALPHABET.includes(char))) return null;

  const chunks: string[] = [];
  for (let i = 0; i < stripped.length; i += GROUP_SIZE) {
    chunks.push(stripped.slice(i, i + GROUP_SIZE));
  }
  return chunks.join("-");
};
