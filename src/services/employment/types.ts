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
