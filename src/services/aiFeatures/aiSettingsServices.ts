import { eq } from "drizzle-orm";
import { dailyAiConnectionLimit, MEMBER_DAILY_LIMIT } from "../aiConnections/dailyLimits.js";
import { config } from "../../config.js";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { aiAgreementAcceptances } from "../../db/schema/ai-agreement-schema.js";
import { aiConnectionsChanges } from "../../db/schema/ai-connections-change-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import AppError, { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import {
  assertAiConnectionsPlan,
  assertAssistantPlan,
  isAiConnectionsPlan,
  isAssistantPlan,
  planForOrganization,
} from "../billing/guards.js";
import { lockOrganization } from "../organization/organizationServices.js";
import { deleteOrganizationGrants, listOrganizationGrants } from "../aiConnections/grants.js";
import { personName } from "../person/personName.js";
import type { OrganizationType } from "../organization/types.js";
import { AI_AGREEMENT_VERSION } from "./aiAgreement.js";
import { anyAiFeatureOn, readAgreement } from "./aiAgreementState.js";
import { isAiFeatureAvailable } from "./aiFeatureServices.js";
import {
  aiConnectionsMemberNotice,
  assistantMemberNotice,
  planMemberNotices,
  type MemberNotice,
} from "./memberNotices.js";

type Actor = { organizationId: string; userId: string };

const readOrganization = async (organizationId: string, tx?: DbTransaction) => {
  const [row] = await (tx ?? db)
    .select({
      id: organizations.id,
      name: organizations.name,
      ownerUserId: organizations.ownerUserId,
      ownerName: personName(user, { organizationId }),
      assistantEnabled: organizations.assistantEnabled,
      assistantEnabledAt: organizations.assistantEnabledAt,
      aiConnections: organizations.aiConnections,
    })
    .from(organizations)
    .innerJoin(user, eq(user.id, organizations.ownerUserId))
    .where(eq(organizations.id, organizationId));
  if (!row) {
    throw new AppError({
      message: "Organization not found",
      logging: true,
      code: 404,
      context: { organizationId },
    });
  }
  return row;
};

/** What the AI card shows an owner or org admin. */
export const readAiSettings = async (
  input: { organizationId: string; viewerUserId: string },
  tx?: DbTransaction
) => {
  const organization = await readOrganization(input.organizationId, tx);
  const plan = await planForOrganization(input.organizationId, tx);
  return {
    organizationId: organization.id,
    isOwner: organization.ownerUserId === input.viewerUserId,
    ownerName: organization.ownerName,
    plan,
    assistant: {
      enabled: organization.assistantEnabled,
      enabledAt: organization.assistantEnabledAt,
      planAllows: isAssistantPlan(plan),
      weeklyLimitMicroUsd: config.assistant.weeklyLimitMicroUsd,
    },
    aiConnections: {
      level: organization.aiConnections,
      planAllows: isAiConnectionsPlan(plan),
      dailyLimit: dailyAiConnectionLimit(plan),
      memberDailyLimit: MEMBER_DAILY_LIMIT,
      grants: await listOrganizationGrants(input.organizationId, tx),
    },
    agreement: await readAgreement(input.organizationId, anyAiFeatureOn(organization), tx),
    memberNotice: {
      assistant: assistantMemberNotice(organization.name),
      aiConnections: aiConnectionsMemberNotice(organization.name),
    },
  };
};

const assertCurrentAgreement = (agreementVersion: number, context: object) => {
  if (agreementVersion !== AI_AGREEMENT_VERSION) {
    throw refuse(
      409,
      "AGREEMENT_VERSION_STALE",
      "The AI features agreement has changed; read the current version",
      { ...context, agreementVersion, currentVersion: AI_AGREEMENT_VERSION }
    );
  }
};

/** One row per organization and version: accepting a version again writes nothing. */
const recordAcceptance = async ({ organizationId, userId }: Actor, tx: DbTransaction) => {
  await tx
    .insert(aiAgreementAcceptances)
    .values({
      id: generateRandomUUID(),
      organizationId,
      version: AI_AGREEMENT_VERSION,
      acceptedByUserId: userId,
    })
    .onConflictDoNothing({
      target: [aiAgreementAcceptances.organizationId, aiAgreementAcceptances.version],
    });
};

const assertOwner = (
  organization: Pick<OrganizationType, "id" | "ownerUserId">,
  userId: string
) => {
  if (organization.ownerUserId !== userId) {
    throw refuse(403, "OWNER_ONLY", "Only the organization owner can change the AI settings", {
      organizationId: organization.id,
      userId,
    });
  }
};

/**
 * Turns the Assistant on and records the acceptance of the current agreement
 * version, in the caller's transaction. Answers 404 while the Assistant is
 * unavailable to the organization (kill switch off, not on the preview list),
 * like every other Assistant route. Returns the members' notices to send after
 * the commit when `tellMembers` is set.
 */
export const enableAssistant = async (
  input: Actor & { agreementVersion: number; tellMembers: boolean },
  tx: DbTransaction
): Promise<MemberNotice[]> => {
  const { organizationId, userId } = input;
  if (!isAiFeatureAvailable("assistant", organizationId)) {
    throw new AppError({ message: "Not found", code: 404 });
  }
  await lockOrganization(organizationId, tx);
  const organization = await readOrganization(organizationId, tx);
  assertOwner(organization, userId);
  await assertAssistantPlan(organizationId, tx);
  if (organization.assistantEnabled) {
    throw refuse(409, "ASSISTANT_ALREADY_ON", "The Assistant is already on", { organizationId });
  }
  assertCurrentAgreement(input.agreementVersion, { organizationId });

  await tx
    .update(organizations)
    .set({ assistantEnabled: true, assistantEnabledAt: new Date() })
    .where(eq(organizations.id, organizationId));
  await recordAcceptance(input, tx);

  return input.tellMembers
    ? planMemberNotices(
        { organizationId, actorUserId: userId, copy: assistantMemberNotice(organization.name) },
        tx
      )
    : [];
};

/** Turns the Assistant off. Owner only, on every plan; a second call changes nothing. */
export const disableAssistant = async ({ organizationId, userId }: Actor, tx: DbTransaction) => {
  await lockOrganization(organizationId, tx);
  const organization = await readOrganization(organizationId, tx);
  assertOwner(organization, userId);
  await tx
    .update(organizations)
    .set({ assistantEnabled: false })
    .where(eq(organizations.id, organizationId));
};

/** The owner accepts a raised agreement version while an AI feature is on. Never plan-gated. */
export const acceptAiAgreement = async (
  input: Actor & { agreementVersion: number },
  tx: DbTransaction
) => {
  const { organizationId, userId } = input;
  await lockOrganization(organizationId, tx);
  const organization = await readOrganization(organizationId, tx);
  assertOwner(organization, userId);
  if (!anyAiFeatureOn(organization)) {
    throw refuse(409, "AI_FEATURES_OFF", "Turn an AI feature on to accept its agreement", {
      organizationId,
    });
  }
  assertCurrentAgreement(input.agreementVersion, { organizationId });
  await recordAcceptance(input, tx);
};

const notFoundUnlessAvailable = (organizationId: string) => {
  if (!isAiFeatureAvailable("aiConnections", organizationId)) {
    throw new AppError({ message: "Not found", code: 404 });
  }
};

/** Sets the level and writes the setting change log row, in the caller's transaction. */
const changeAiConnections = async (
  { organizationId, userId }: Actor,
  before: aiConnectionsLevel,
  after: aiConnectionsLevel,
  tx: DbTransaction
) => {
  await tx
    .update(organizations)
    .set({ aiConnections: after, aiConnectionsChangedAt: new Date() })
    .where(eq(organizations.id, organizationId));
  await tx.insert(aiConnectionsChanges).values({
    id: generateRandomUUID(),
    organizationId,
    changedByUserId: userId,
    before,
    after,
  });
};

/**
 * Turns AI connections on at the chosen level and records the acceptance of the
 * current agreement version, once per version, like the Assistant. Any Paid
 * plan. Answers 404 while AI connections are unavailable to the organization.
 * Returns the members' notices to send after the commit when `tellMembers` is set.
 */
export const enableAiConnections = async (
  input: Actor & {
    level: aiConnectionsLevel.Read | aiConnectionsLevel.Write;
    agreementVersion: number;
    tellMembers: boolean;
  },
  tx: DbTransaction
): Promise<MemberNotice[]> => {
  const { organizationId, userId } = input;
  notFoundUnlessAvailable(organizationId);
  await lockOrganization(organizationId, tx);
  const organization = await readOrganization(organizationId, tx);
  assertOwner(organization, userId);
  await assertAiConnectionsPlan(organizationId, tx);
  if (organization.aiConnections !== aiConnectionsLevel.Off) {
    throw refuse(409, "AI_CONNECTIONS_ALREADY_ON", "AI connections are already on", {
      organizationId,
    });
  }
  assertCurrentAgreement(input.agreementVersion, { organizationId });

  await changeAiConnections(input, aiConnectionsLevel.Off, input.level, tx);
  await recordAcceptance(input, tx);

  return input.tellMembers
    ? planMemberNotices(
        { organizationId, actorUserId: userId, copy: aiConnectionsMemberNotice(organization.name) },
        tx
      )
    : [];
};

/**
 * Moves AI connections between Read only and Read and write while they are on.
 * Raising needs a Paid plan and the feature available, and no new acceptance;
 * lowering works on any plan and deletes the grants holding write access. The
 * same level again changes nothing.
 */
export const setAiConnectionsLevel = async (
  input: Actor & { level: aiConnectionsLevel.Read | aiConnectionsLevel.Write },
  tx: DbTransaction
) => {
  const { organizationId, userId, level } = input;
  await lockOrganization(organizationId, tx);
  const organization = await readOrganization(organizationId, tx);
  assertOwner(organization, userId);
  if (organization.aiConnections === aiConnectionsLevel.Off) {
    throw refuse(409, "AI_CONNECTIONS_OFF", "Turn AI connections on first", { organizationId });
  }
  if (organization.aiConnections === level) return;
  if (level === aiConnectionsLevel.Write) {
    notFoundUnlessAvailable(organizationId);
    await assertAiConnectionsPlan(organizationId, tx);
  }
  await changeAiConnections(input, organization.aiConnections, level, tx);
  if (level === aiConnectionsLevel.Read) {
    await deleteOrganizationGrants({ organizationIds: [organizationId], writeOnly: true }, tx);
  }
};

/**
 * Turns AI connections off and deletes every grant in the organization. Owner
 * only, on every plan, whatever the kill switch says.
 */
export const disableAiConnections = async (input: Actor, tx: DbTransaction) => {
  await lockOrganization(input.organizationId, tx);
  const organization = await readOrganization(input.organizationId, tx);
  assertOwner(organization, input.userId);
  if (organization.aiConnections === aiConnectionsLevel.Off) return;
  await changeAiConnections(input, organization.aiConnections, aiConnectionsLevel.Off, tx);
  await deleteOrganizationGrants({ organizationIds: [input.organizationId] }, tx);
};
