import { z } from "zod";

export const validateAiAgreementBody = z.object({
  /** The agreement version the owner was shown. */
  agreementVersion: z.number().int().min(1),
});

export type AiAgreementBody = z.infer<typeof validateAiAgreementBody>;

export const validateEnableAssistantBody = validateAiAgreementBody.extend({
  /** Send the members' notice after the turn-on commits. Absent reads as false. */
  tellMembers: z.boolean().optional(),
});

export type EnableAssistantBody = z.infer<typeof validateEnableAssistantBody>;

export type AiAgreementState = {
  currentVersion: number;
  acceptedVersion: number | null;
  acceptedAt: Date | null;
  acceptedByName: string | null;
  /** An AI feature is on and the newest acceptance is older than the current version. */
  newVersionReady: boolean;
};

const raisedLevel = z.enum(["read", "write"]);

export const validateEnableAiConnectionsBody = validateEnableAssistantBody.extend({
  /** "Start with": the level the setting turns on at. */
  level: raisedLevel,
});

export type EnableAiConnectionsBody = z.infer<typeof validateEnableAiConnectionsBody>;

export const validateAiConnectionsLevelBody = z.object({ level: raisedLevel });

export type AiConnectionsLevelBody = z.infer<typeof validateAiConnectionsLevelBody>;

/** A past week on the AI usage page, named by its Monday. */
export const validateUsageWeekStart = z.iso.date();
