import { eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { aiAgreementAcceptances } from "../../db/schema/ai-agreement-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import AppError, { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertAssistantPlan, isAssistantPlan, planForOrganization } from "../billing/guards.js";
import { lockOrganization } from "../organization/organizationServices.js";
import { personName } from "../person/personName.js";
import type { OrganizationType } from "../organization/types.js";
import { AI_AGREEMENT_VERSION } from "./aiAgreement.js";
import { readAgreement } from "./aiAgreementState.js";
import { isAiFeatureAvailable } from "./aiFeatureServices.js";
import {
  assistantMemberNotice,
  planAssistantNotices,
  type AssistantNotice,
} from "./assistantNotice.js";

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
    },
    agreement: await readAgreement(input.organizationId, organization.assistantEnabled, tx),
    memberNotice: { assistant: assistantMemberNotice(organization.name) },
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
): Promise<AssistantNotice[]> => {
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
    ? planAssistantNotices(
        { organizationId, organizationName: organization.name, actorUserId: userId },
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
  if (!organization.assistantEnabled) {
    throw refuse(409, "AI_FEATURES_OFF", "Turn an AI feature on to accept its agreement", {
      organizationId,
    });
  }
  assertCurrentAgreement(input.agreementVersion, { organizationId });
  await recordAcceptance(input, tx);
};
