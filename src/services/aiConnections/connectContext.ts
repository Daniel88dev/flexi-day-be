import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { oauthClient, session as sessionTable } from "../../db/schema/auth-schema.js";
import AppError from "../../utils/appError.js";
import { auth } from "../../utils/auth.js";
import { FLEXIDAY_READ, FLEXIDAY_WRITE } from "../../utils/aiConnectionsOAuth.js";
import {
  aiEligibility,
  aiEligibilityForUser,
  assertAiEligible,
  type AiConnectionAccess,
  type AiIneligibleReason,
} from "../aiFeatures/aiEligibility.js";

export const INVALID_OAUTH_QUERY = "INVALID_OAUTH_QUERY";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ConnectOrganization = {
  organizationId: string;
  organizationName: string;
  access: AiConnectionAccess;
};

export type LeftOutOrganization = {
  organizationId: string;
  organizationName: string;
  ownerName: string;
  reason: Exclude<AiIneligibleReason, "UNAVAILABLE" | "NO_STANDING">;
};

export type ConnectContext = {
  client: {
    clientId: string;
    name: string | null;
    /** A Client ID Metadata Document: its address was fetched, so `host` is checked. */
    verified: boolean;
    /** The `client_id` host when verified, the redirect host otherwise. */
    host: string;
    logoUri: string | null;
    clientUri: string | null;
    policyUri: string | null;
    tosUri: string | null;
  };
  redirect: { host: string; local: boolean };
  /** The product scopes the app asked for. */
  scopes: string[];
  signedIn: boolean;
  /** The organization picked for this flow, while it is still eligible. */
  organization: ConnectOrganization | null;
  /** Present when signed in: what the picker offers and what it leaves out. */
  organizations: { eligible: ConnectOrganization[]; leftOut: LeftOutOrganization[] } | null;
};

const invalidQuery = () =>
  new AppError({
    message: "The connection request is invalid or has expired",
    code: 400,
    publicContext: { code: INVALID_OAUTH_QUERY },
  });

const httpsOnly = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

const isLoopback = (value: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

/**
 * Checks the signed query through the provider's own prelogin endpoint, the
 * same check `/oauth2/consent` makes later, so a page never renders what an
 * unsigned or expired URL claims.
 */
const verifiedClient = async (oauthQuery: string) => {
  const clientId = new URLSearchParams(oauthQuery).get("client_id");
  if (!clientId) throw invalidQuery();
  try {
    await auth.api.getOAuthClientPublicPrelogin({
      body: { client_id: clientId, oauth_query: oauthQuery },
    });
  } catch {
    throw invalidQuery();
  }
  const [client] = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!client || client.disabled) throw invalidQuery();
  return client;
};

/** Everything the static sign-in, picker and consent pages show about one authorization request. */
export const readConnectContext = async (args: {
  oauthQuery: string;
  viewer: { userId: string; oauthOrganizationId: string | null } | null;
}): Promise<ConnectContext> => {
  const client = await verifiedClient(args.oauthQuery);
  const query = new URLSearchParams(args.oauthQuery);
  const redirectUri = query.get("redirect_uri") ?? client.redirectUris[0] ?? "";
  const redirectHost = hostOf(redirectUri) ?? "";
  const verified = client.clientDiscoveryId === "cimd";
  const scopes = (query.get("scope") ?? "")
    .split(" ")
    .filter((scope) => scope === FLEXIDAY_READ || scope === FLEXIDAY_WRITE);

  let organization: ConnectOrganization | null = null;
  let organizations: ConnectContext["organizations"] = null;
  if (args.viewer) {
    const answers = await aiEligibilityForUser({
      userId: args.viewer.userId,
      feature: "aiConnections",
    });
    organizations = { eligible: [], leftOut: [] };
    for (const answer of answers) {
      if (answer.eligible) {
        organizations.eligible.push({
          organizationId: answer.organizationId,
          organizationName: answer.organizationName,
          access: answer.access ?? "read",
        });
      } else if (answer.reason === "TURNED_OFF" || answer.reason === "PLAN") {
        organizations.leftOut.push({
          organizationId: answer.organizationId,
          organizationName: answer.organizationName,
          ownerName: answer.ownerName,
          reason: answer.reason,
        });
      }
    }
    if (args.viewer.oauthOrganizationId) {
      const chosen = await aiEligibility({
        userId: args.viewer.userId,
        organizationId: args.viewer.oauthOrganizationId,
        feature: "aiConnections",
      });
      if (chosen.eligible) {
        organization = {
          organizationId: chosen.organizationId,
          organizationName: chosen.organizationName,
          access: chosen.access ?? "read",
        };
      }
    }
  }

  return {
    client: {
      clientId: client.clientId,
      name: client.name,
      verified,
      host: (verified ? hostOf(client.clientId) : null) ?? redirectHost,
      logoUri: httpsOnly(client.icon),
      clientUri: httpsOnly(client.uri),
      policyUri: httpsOnly(client.policy),
      tosUri: httpsOnly(client.tos),
    },
    redirect: { host: redirectHost, local: isLoopback(redirectUri) },
    scopes,
    signedIn: args.viewer !== null,
    organization,
    organizations,
  };
};

/**
 * The picker's choice. Stored on the session the flow runs in, where
 * `postLogin.consentReferenceId` reads it; checked here and again at consent.
 */
export const chooseConnectOrganization = async (args: {
  userId: string;
  sessionId: string;
  organizationId: string;
}): Promise<ConnectOrganization> => {
  const answer = await assertAiEligible({
    userId: args.userId,
    organizationId: args.organizationId,
    feature: "aiConnections",
  });
  await db
    .update(sessionTable)
    .set({ oauthOrganizationId: answer.organizationId })
    .where(eq(sessionTable.id, args.sessionId));
  return {
    organizationId: answer.organizationId,
    organizationName: answer.organizationName,
    access: answer.access ?? "read",
  };
};
