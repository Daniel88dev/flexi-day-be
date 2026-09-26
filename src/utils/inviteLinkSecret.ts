import { createHash, randomBytes } from "node:crypto";

/** 256 bits, base64url: 43 characters that survive a URL untouched. */
export const generateInviteLinkSecret = (): string => randomBytes(32).toString("base64url");

// A plain digest is enough: the secret is random, so there is nothing to
// brute-force that a slow hash would protect.
export const hashInviteLinkSecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");
