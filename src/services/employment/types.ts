import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";

export type EmploymentType = {
  id: string;
  organizationId: string;
  userId: string;
  startedAt: Date;
  /** Null while the person is still one of the organization's people. */
  endedAt: Date | null;
  requiredMinutesPerDay: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EmploymentListItem = {
  id: string;
  userId: string;
  email: string;
  startedAt: Date;
  endedAt: Date | null;
  ended: boolean;
  /** This person's own required time, null while the organization's rule stands. */
  requiredMinutesPerDay: number | null;
  /** When the person deleted their account; the row then carries the "Account deleted" label. */
  accountDeletedAt: Date | null;
  accountDeleted: boolean;
  user: UserSummary;
};

/**
 * Both employment routes name their organization in the query rather than the
 * path: an employee may belong to several and administers none, so there is no
 * default to fall back on. `userId` asks about someone else, which
 * `attendanceAccess` decides.
 */
export const validateEmploymentQuery = z.object({
  // better-auth user ids are opaque non-UUID strings.
  organizationId: z.string().min(1),
  userId: z.string().min(1).optional(),
});

export type ValidatedEmploymentQueryType = z.infer<typeof validateEmploymentQuery>;

/**
 * The one field of an Employment an admin sets by hand. Null clears the
 * override and puts the person back on the organization's required time, which
 * is why it is nullable rather than optional — an absent key would be
 * indistinguishable from "leave it alone" in a body with nothing else in it.
 */
export const validatePatchEmployment = z.object({
  requiredMinutesPerDay: z.number().int().min(0).max(1440).nullable(),
});

export type ValidatedPatchEmploymentType = z.infer<typeof validatePatchEmployment>;

/** End employment: the last day of the spell, today or earlier in the organization's zone. */
export const validateEndEmployment = z.object({
  endedOn: z.iso.date(),
});

export type ValidatedEndEmploymentType = z.infer<typeof validateEndEmployment>;

/** Erase: the person's name as the People card shows it, typed by the admin to confirm. */
export const validateEraseEmployment = z.object({
  confirmName: z.string().trim().min(1).max(200),
});

export type ValidatedEraseEmploymentType = z.infer<typeof validateEraseEmployment>;
