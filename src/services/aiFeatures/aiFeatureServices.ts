import { config } from "../../config.js";
import { aiConnectionsLevel } from "../../db/schema/organization-schema.js";
import type { Entitlements } from "../billing/entitlements.js";
import { isAiConnectionsPlan, isAssistantPlan } from "../billing/guards.js";
import { linkedOrganizationIds } from "../employment/organizationLinks.js";
import { ownedNewAgreementVersions } from "./aiAgreementState.js";
import type { AiConnectionAccess } from "./aiEligibility.js";

export type AiFeature = "assistant" | "aiConnections";

export type OrganizationAiAvailability = {
  organizationId: string;
  assistant: boolean;
  aiConnections: boolean;
  /** The caller owns it and has a raised AI features agreement version to accept. */
  newAgreementVersionReady: boolean;
};

export type AiAvailability = {
  /** Available in at least one of the caller's organizations, or switched on for everyone. */
  assistant: boolean;
  aiConnections: boolean;
  organizations: OrganizationAiAvailability[];
};

type OrganizationAiSettings = { assistantEnabled: boolean; aiConnections: aiConnectionsLevel };

/** What differs between the two features, in one place: the kill switch, the owner's setting, the plan, the access. */
export const AI_FEATURE_RULES: Record<
  AiFeature,
  {
    switchedOn: () => boolean;
    turnedOn: (organization: OrganizationAiSettings) => boolean;
    planAllows: (plan: Entitlements["plan"]) => boolean;
    access: (organization: OrganizationAiSettings) => AiConnectionAccess | null;
  }
> = {
  assistant: {
    switchedOn: () => config.aiFeatures.assistantEnabled,
    turnedOn: (organization) => organization.assistantEnabled,
    planAllows: (plan) => isAssistantPlan(plan),
    access: () => null,
  },
  aiConnections: {
    switchedOn: () => config.aiFeatures.aiConnectionsEnabled,
    turnedOn: (organization) => organization.aiConnections !== aiConnectionsLevel.Off,
    planAllows: (plan) => isAiConnectionsPlan(plan),
    access: (organization) =>
      organization.aiConnections === aiConnectionsLevel.Write ? "write" : "read",
  },
};

const isSwitchedOn = (feature: AiFeature): boolean => AI_FEATURE_RULES[feature].switchedOn();

/** The kill switch is on, or the organization is on the preview list. */
export const isAiFeatureAvailable = (feature: AiFeature, organizationId: string): boolean =>
  isSwitchedOn(feature) || config.aiFeatures.previewOrganizationIds.includes(organizationId);

/**
 * For routes that name no organization and run before any session (the
 * webhook, OAuth discovery): open while the switch is on or anyone is in preview.
 */
export const isAiFeatureReachable = (feature: AiFeature): boolean =>
  isSwitchedOn(feature) || config.aiFeatures.previewOrganizationIds.length > 0;

export const getAiAvailabilityForUser = async (userId: string): Promise<AiAvailability> => {
  const newVersions = await ownedNewAgreementVersions(userId);
  const organizations = (await linkedOrganizationIds(userId)).map((organizationId) => ({
    organizationId,
    assistant: isAiFeatureAvailable("assistant", organizationId),
    aiConnections: isAiFeatureAvailable("aiConnections", organizationId),
    newAgreementVersionReady: newVersions.has(organizationId),
  }));
  return {
    assistant: isSwitchedOn("assistant") || organizations.some((o) => o.assistant),
    aiConnections: isSwitchedOn("aiConnections") || organizations.some((o) => o.aiConnections),
    organizations,
  };
};

/** The switch is on, or the user belongs to an organization on the preview list. */
export const isAiFeatureAvailableToUser = async (
  feature: AiFeature,
  userId: string
): Promise<boolean> => {
  if (isSwitchedOn(feature)) return true;
  if (config.aiFeatures.previewOrganizationIds.length === 0) return false;
  const organizationIds = await linkedOrganizationIds(userId);
  return organizationIds.some((id) => config.aiFeatures.previewOrganizationIds.includes(id));
};
