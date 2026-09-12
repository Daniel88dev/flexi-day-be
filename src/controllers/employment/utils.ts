import type { EmploymentType } from "../../services/employment/types.js";

/** The one shape an Employment answers in, whether it was read or just patched. */
export const presentEmployment = (employment: EmploymentType) => ({
  id: employment.id,
  organizationId: employment.organizationId,
  userId: employment.userId,
  startedAt: employment.startedAt,
  endedAt: employment.endedAt,
  ended: employment.endedAt !== null,
  requiredMinutesPerDay: employment.requiredMinutesPerDay,
});
