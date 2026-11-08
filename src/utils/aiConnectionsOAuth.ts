import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { session as sessionTable } from "../db/schema/auth-schema.js";
import { aiEligibility } from "../services/aiFeatures/aiEligibility.js";

export const FLEXIDAY_READ = "flexiday.read";
export const FLEXIDAY_WRITE = "flexiday.write";
export const AI_CONNECTION_SCOPES = [FLEXIDAY_READ, FLEXIDAY_WRITE, "offline_access"];

/** The access-token claim naming the one organization a grant acts in. */
export const ORGANIZATION_CLAIM = "https://flexi-day.com/organization";

type OAuthSession = { id: string; userId: string; oauthOrganizationId?: string | null };

const chosenOrganization = (session: Record<string, unknown>): string | undefined => {
  const value = session.oauthOrganizationId;
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * `postLogin.shouldRedirect`. A fresh authorization always goes to the picker
 * and forgets any choice an earlier one left on the session, so a consent
 * stored for that organization can never issue a code nobody picked this
 * time. On the way back from the picker it lets the flow on only when the
 * session holds a choice that is still eligible; `isContinuation` alone proves
 * nothing.
 */
export const shouldPickOrganization = async ({
  session,
  isContinuation,
}: {
  session: Record<string, unknown>;
  isContinuation: boolean;
}): Promise<boolean> => {
  const current = session as unknown as OAuthSession;
  if (!isContinuation) {
    if (chosenOrganization(session)) {
      await db
        .update(sessionTable)
        .set({ oauthOrganizationId: null })
        .where(eq(sessionTable.id, current.id));
    }
    return true;
  }
  const organizationId = chosenOrganization(session);
  if (!organizationId) return true;
  const answer = await aiEligibility({
    userId: current.userId,
    organizationId,
    feature: "aiConnections",
  });
  return !answer.eligible;
};

/**
 * `postLogin.consentReferenceId`: the chosen organization becomes the
 * consent's reference id, and from there the code's, every refresh token's and
 * the access token's organization claim. Throws when nothing was chosen or the
 * choice stopped being eligible since the picker.
 */
export const consentOrganization = async ({
  session,
}: {
  session: Record<string, unknown>;
}): Promise<string> => {
  const current = session as unknown as OAuthSession;
  const organizationId = chosenOrganization(session);
  if (!organizationId) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_request",
      error_description: "No organization was chosen for this connection",
    });
  }
  const answer = await aiEligibility({
    userId: current.userId,
    organizationId,
    feature: "aiConnections",
  });
  if (!answer.eligible) {
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "This organization no longer allows AI connections",
      reason: answer.reason,
    });
  }
  return organizationId;
};

export const organizationClaim = ({ referenceId }: { referenceId?: string }) =>
  referenceId ? { [ORGANIZATION_CLAIM]: referenceId } : {};

/**
 * Takes `flexiday.write` out of a consent for an organization set to Read
 * only, whatever the page posted. The consent endpoint grants every originally
 * requested scope when the body names none, so the narrower list is always
 * written into the body. Registered after `mcp()`, whose own hook has already
 * checked the signed query by then.
 */
export const readOnlyConsentScopes = {
  id: "ai-connections-read-only-consent",
  hooks: {
    before: [
      {
        matcher: (ctx) => ctx.path === "/oauth2/consent",
        handler: createAuthMiddleware(async (ctx) => {
          const body = (ctx.body ?? {}) as {
            accept?: unknown;
            scope?: unknown;
            oauth_query?: unknown;
          };
          if (body.accept !== true) return;
          const current = await getSessionFromCtx(ctx);
          const organizationId = current
            ? chosenOrganization(current.session as Record<string, unknown>)
            : undefined;
          if (!current || !organizationId) return;
          const answer = await aiEligibility({
            userId: current.user.id,
            organizationId,
            feature: "aiConnections",
          });
          if (!answer.eligible || answer.access === "write") return;

          const requested =
            typeof body.scope === "string"
              ? body.scope.split(" ")
              : (new URLSearchParams(typeof body.oauth_query === "string" ? body.oauth_query : "")
                  .get("scope")
                  ?.split(" ") ?? []);
          return {
            context: {
              body: {
                ...body,
                scope: requested.filter((scope) => scope !== FLEXIDAY_WRITE).join(" "),
              },
            },
          };
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
