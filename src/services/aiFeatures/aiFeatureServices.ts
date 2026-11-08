import { config } from "../../config.js";
import { linkedOrganizationIds } from "../employment/organizationLinks.js";
import { ownedNewAgreementVersions } from "./aiAgreementState.js";

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

const isSwitchedOn = (feature: AiFeature): boolean =>
  feature === "assistant"
    ? config.aiFeatures.assistantEnabled
    : config.aiFeatures.aiConnectionsEnabled;

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
