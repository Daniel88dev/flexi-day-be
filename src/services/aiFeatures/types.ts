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
