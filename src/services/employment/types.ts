import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";
import type { workerType } from "../../db/schema/employment-schema.js";

export type EmploymentType = {
  id: string;
  organizationId: string;
  /** Null for a person without an account. */
  userId: string | null;
  type: workerType;
  startedAt: Date;
  /** Null while the spell is open. */
  endedAt: Date | null;
  name: string | null;
  email: string | null;
  requiredMinutesPerDay: number | null;
  accountDeletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** An Employment with an account bound to it, the only kind attendance hangs off. */
export type BoundEmploymentType = EmploymentType & { userId: string };

export type EmploymentListItem = {
  id: string;
  /** Null for a person without an account; `user` is then keyed on the Employment's id. */
  userId: string | null;
  type: workerType;
  /** The account's email, else the Employment's own copy. */
  email: string | null;
  startedAt: Date;
  endedAt: Date | null;
  ended: boolean;
  /** This person's own required time, null while the organization's rule stands. */
  requiredMinutesPerDay: number | null;
  /** When the person deleted their account; the row then carries the "Account deleted" label. */
  accountDeletedAt: Date | null;
  accountDeleted: boolean;
  user: UserSummary;
  /** Org admins only: an open Employment no group, admin grant or ownership holds. */
  noLink?: boolean;
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
