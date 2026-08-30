import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";

export type OrganizationType = {
  id: string;
  name: string;
  ownerUserId: string;
  billingEmail: string;
  paddleCustomerId: string | null;
  sickDayBenefitEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganizationAdminListItem = {
  userId: string;
  email: string;
  /** The owner is synthesised from `organizations.ownerUserId`, not stored. */
  isOwner: boolean;
  grantedAt: Date | null;
  user: UserSummary;
};

export type OrganizationCandidate = {
  userId: string;
  email: string;
  groupNames: string[];
  user: UserSummary;
};

export const validatePatchOrganization = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Normalise before validating: `z.email()` runs first in a chain, so a
    // trailing space would be rejected rather than trimmed away.
    billingEmail: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
    sickDayBenefitEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.billingEmail !== undefined ||
      body.sickDayBenefitEnabled !== undefined,
    { message: "At least one field must be provided" }
  );

export type ValidatedPatchOrganizationType = z.infer<typeof validatePatchOrganization>;

// better-auth user ids are opaque non-UUID strings.
export const validatePostOrganizationAdmin = z.object({
  userId: z.string().min(1),
});

export type ValidatedPostOrganizationAdminType = z.infer<typeof validatePostOrganizationAdmin>;
