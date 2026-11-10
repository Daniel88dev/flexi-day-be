import { desc, eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { aiAgreementAcceptances } from "../../db/schema/ai-agreement-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { personName } from "../person/personName.js";
import { AI_AGREEMENT_VERSION } from "./aiAgreement.js";
import type { AiAgreementState } from "./types.js";

const latestAcceptance = async (organizationId: string, tx?: DbTransaction) => {
  const [latest] = await (tx ?? db)
    .select({
      version: aiAgreementAcceptances.version,
      acceptedAt: aiAgreementAcceptances.acceptedAt,
      acceptedByName: personName(user, { organizationId }),
    })
    .from(aiAgreementAcceptances)
    .leftJoin(user, eq(aiAgreementAcceptances.acceptedByUserId, user.id))
    .where(eq(aiAgreementAcceptances.organizationId, organizationId))
    .orderBy(desc(aiAgreementAcceptances.version))
    .limit(1);
  return latest ?? null;
};

const newVersionReady = (anyFeatureOn: boolean, acceptedVersion: number | null) =>
  anyFeatureOn && acceptedVersion !== null && acceptedVersion < AI_AGREEMENT_VERSION;

/** Whether any AI feature is on: the Assistant, or AI connections at any level. */
export const anyAiFeatureOn = (organization: {
  assistantEnabled: boolean;
  aiConnections: aiConnectionsLevel;
}): boolean =>
  organization.assistantEnabled || organization.aiConnections !== aiConnectionsLevel.Off;

export const readAgreement = async (
  organizationId: string,
  anyFeatureOn: boolean,
  tx?: DbTransaction
): Promise<AiAgreementState> => {
  const latest = await latestAcceptance(organizationId, tx);
  const acceptedVersion = latest?.version ?? null;
  return {
    currentVersion: AI_AGREEMENT_VERSION,
    acceptedVersion,
    acceptedAt: latest?.acceptedAt ?? null,
    acceptedByName: latest?.acceptedByName ?? null,
    newVersionReady: newVersionReady(anyFeatureOn, acceptedVersion),
  };
};

/**
 * Whether the owner has a raised agreement version to accept, for the
 * availability answer the web's shell banner reads. Owners own one organization.
 */
export const ownedNewAgreementVersions = async (userId: string): Promise<Set<string>> => {
  const owned = await db
    .select({
      id: organizations.id,
      assistantEnabled: organizations.assistantEnabled,
      aiConnections: organizations.aiConnections,
    })
    .from(organizations)
    .where(eq(organizations.ownerUserId, userId));
  const ready = new Set<string>();
  for (const organization of owned) {
    const latest = await latestAcceptance(organization.id);
    if (newVersionReady(anyAiFeatureOn(organization), latest?.version ?? null)) {
      ready.add(organization.id);
    }
  }
  return ready;
};
