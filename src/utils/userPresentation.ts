export type UserSummary = {
  id: string;
  name: string;
  initials: string;
  avatarColor: string;
};

/**
 * Derives up to two-character initials from a full name string.
 * Falls back to "?" if the input contains no readable letters.
 */
export const getInitialsFromName = (name: string): string => {
  const tokens = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (tokens.length === 0) return "?";

  const first = tokens[0]?.[0] ?? "";
  const last = tokens.length > 1 ? (tokens[tokens.length - 1]?.[0] ?? "") : "";

  const initials = `${first}${last}`.toUpperCase();
  return initials || "?";
};

/**
 * Deterministically maps a user id to an HSL color string so the same user
 * always receives the same avatar color across requests.
 */
export const getAvatarColorForUserId = (userId: string): string => {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue.toString()}, 65%, 50%)`;
};

export const buildUserSummary = (input: {
  id: string;
  name: string;
}): UserSummary => ({
  id: input.id,
  name: input.name,
  initials: getInitialsFromName(input.name),
  avatarColor: getAvatarColorForUserId(input.id),
});
