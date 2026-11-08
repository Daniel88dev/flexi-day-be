import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { oauthConsent, user } from "../../db/schema/auth-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { FLEXIDAY_WRITE } from "../../utils/aiConnectionsOAuth.js";
import { aiEligibility, type AiIneligibleReason } from "../aiFeatures/aiEligibility.js";

export type McpGrantUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  language: appLanguage;
};

/**
 * What one `/mcp` call may do, decided afresh on every call:
 * - `revoked`: the consent row or the user is gone, or the owner turned AI
 *   connections off. The token is dead; the app has to connect again.
 * - `unavailable`: AI connections are switched off for this organization.
 * - `refused`: the grant stands, but every tool call is refused for `reason`.
 * - `active`: tools run with `access`, the lower of what the token, the
 *   consent and the organization's setting allow.
 */
export type McpGrant =
  | { status: "revoked" }
  | { status: "unavailable" }
  | {
      status: "refused";
      user: McpGrantUser;
      reason: Exclude<AiIneligibleReason, "UNAVAILABLE" | "TURNED_OFF">;
    }
  | { status: "active"; user: McpGrantUser; access: "read" | "write" };

export const loadMcpGrant = async (args: {
  userId: string;
  clientId: string;
  organizationId: string;
  tokenScopes: string[];
}): Promise<McpGrant> => {
  const [consent] = await db
    .select({ scopes: oauthConsent.scopes })
    .from(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, args.userId),
        eq(oauthConsent.clientId, args.clientId),
        eq(oauthConsent.referenceId, args.organizationId)
      )
    );
  if (!consent) return { status: "revoked" };

  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      language: userSettings.language,
    })
    .from(user)
    .leftJoin(userSettings, eq(userSettings.userId, user.id))
    .where(eq(user.id, args.userId));
  if (!row) return { status: "revoked" };
  const grantUser: McpGrantUser = {
    ...row,
    emailVerified: Boolean(row.emailVerified),
    language: row.language ?? appLanguage.English,
  };

  const answer = await aiEligibility({
    userId: args.userId,
    organizationId: args.organizationId,
    feature: "aiConnections",
  });
  if (!answer.eligible) {
    if (answer.reason === "UNAVAILABLE") return { status: "unavailable" };
    // Turning AI connections off deletes every grant; one still on file is dead all the same.
    if (answer.reason === "TURNED_OFF") return { status: "revoked" };
    return { status: "refused", user: grantUser, reason: answer.reason };
  }

  const write =
    answer.access === "write" &&
    consent.scopes.includes(FLEXIDAY_WRITE) &&
    args.tokenScopes.includes(FLEXIDAY_WRITE);
  return { status: "active", user: grantUser, access: write ? "write" : "read" };
};
