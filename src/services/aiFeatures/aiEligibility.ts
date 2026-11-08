import { eq, inArray } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import AppError from "../../utils/appError.js";
import { isAiConnectionsPlan, isAssistantPlan, planForOrganization } from "../billing/guards.js";
import { hasOrganizationLink, linkedOrganizationIds } from "../employment/organizationLinks.js";
import { isAiFeatureAvailable, type AiFeature } from "./aiFeatureServices.js";

/** What an eligible organization lets an AI connection do. Always `null` for the Assistant. */
export type AiConnectionAccess = "read" | "write";

export type AiIneligibleReason =
  /** The user holds none of the four links to it. */
  | "NO_STANDING"
  /** The kill switch is off and the organization is not on the preview list. */
  | "UNAVAILABLE"
  /** The owner has the feature off. */
  | "TURNED_OFF"
  /** The plan doesn't allow it: Free for AI connections, below Enterprise for the Assistant. */
  | "PLAN";

type OrganizationFacts = {
  organizationId: string;
  organizationName: string;
  ownerName: string;
};

export type AiEligibility =
  | (OrganizationFacts & { eligible: true; access: AiConnectionAccess | null })
  | (OrganizationFacts & { eligible: false; reason: AiIneligibleReason });

export const AI_ORGANIZATION_NOT_ELIGIBLE = "AI_ORGANIZATION_NOT_ELIGIBLE";

type OrganizationRow = OrganizationFacts & {
  assistantEnabled: boolean;
  aiConnections: aiConnectionsLevel;
};

const loadOrganizations = async (
  organizationIds: string[],
  client: DbTransaction | typeof db
): Promise<OrganizationRow[]> => {
  if (organizationIds.length === 0) return [];
  return client
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      ownerName: user.name,
      assistantEnabled: organizations.assistantEnabled,
      aiConnections: organizations.aiConnections,
    })
    .from(organizations)
    .innerJoin(user, eq(user.id, organizations.ownerUserId))
    .where(inArray(organizations.id, organizationIds));
};

/** Standing is settled by the caller; this decides switch, setting and plan. */
const decide = async (
  feature: AiFeature,
  row: OrganizationRow,
  tx?: DbTransaction
): Promise<AiEligibility> => {
  const facts: OrganizationFacts = {
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    ownerName: row.ownerName,
  };
  if (!isAiFeatureAvailable(feature, row.organizationId)) {
    return { ...facts, eligible: false, reason: "UNAVAILABLE" };
  }
  const turnedOn =
    feature === "assistant" ? row.assistantEnabled : row.aiConnections !== aiConnectionsLevel.Off;
  if (!turnedOn) return { ...facts, eligible: false, reason: "TURNED_OFF" };

  const plan = await planForOrganization(row.organizationId, tx);
  const planAllows = feature === "assistant" ? isAssistantPlan(plan) : isAiConnectionsPlan(plan);
  if (!planAllows) return { ...facts, eligible: false, reason: "PLAN" };

  return {
    ...facts,
    eligible: true,
    access:
      feature === "assistant"
        ? null
        : row.aiConnections === aiConnectionsLevel.Write
          ? "write"
          : "read",
  };
};

/**
 * Whether the user may use an AI feature in one organization: standing (any of
 * ADR 0004's four links), the feature available there, the owner's setting on,
 * and a plan that allows it. The one answer the connect flow's picker and
 * consent, every `/mcp` call and the Assistant's organization picker share.
 * An organization that does not exist reads as `NO_STANDING`.
 */
export const aiEligibility = async (
  args: { userId: string; organizationId: string; feature: AiFeature },
  tx?: DbTransaction
): Promise<AiEligibility> => {
  const client = tx ?? db;
  const [row] = await loadOrganizations([args.organizationId], client);
  if (!row) {
    return {
      organizationId: args.organizationId,
      organizationName: "",
      ownerName: "",
      eligible: false,
      reason: "NO_STANDING",
    };
  }
  if (!(await hasOrganizationLink(args.userId, args.organizationId, tx))) {
    return {
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      ownerName: row.ownerName,
      eligible: false,
      reason: "NO_STANDING",
    };
  }
  return decide(args.feature, row, tx);
};

/** Every organization the user has standing in, oldest first, each with its answer. */
export const aiEligibilityForUser = async (
  args: { userId: string; feature: AiFeature },
  tx?: DbTransaction
): Promise<AiEligibility[]> => {
  const client = tx ?? db;
  const ids = await linkedOrganizationIds(args.userId, tx);
  const rows = new Map(
    (await loadOrganizations(ids, client)).map((row) => [row.organizationId, row])
  );
  const answers: AiEligibility[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row) answers.push(await decide(args.feature, row, tx));
  }
  return answers;
};

/** `aiEligibility`, throwing 403 `AI_ORGANIZATION_NOT_ELIGIBLE` with the reason when it says no. */
export const assertAiEligible = async (
  args: { userId: string; organizationId: string; feature: AiFeature },
  tx?: DbTransaction
): Promise<Extract<AiEligibility, { eligible: true }>> => {
  const answer = await aiEligibility(args, tx);
  if (answer.eligible) return answer;
  throw new AppError({
    message: "This organization can't use this AI feature",
    code: 403,
    context: { ...args },
    publicContext: { code: AI_ORGANIZATION_NOT_ELIGIBLE, reason: answer.reason },
  });
};
