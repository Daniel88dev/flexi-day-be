import { db, type DbTransaction } from "../../db/db.js";
import { organizationAttendanceSettings } from "../../db/schema/organization-attendance-settings-schema.js";
import { eq } from "drizzle-orm";
import AppError from "../../utils/appError.js";
import type { AttendanceSettingsType, AttendanceSettingsValues } from "./types.js";

/** Undefined when the organization never set attendance up. */
export const getAttendanceSettings = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<AttendanceSettingsType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(organizationAttendanceSettings)
    .where(eq(organizationAttendanceSettings.organizationId, organizationId))
    .limit(1);

  return row;
};

export const upsertAttendanceSettings = async (
  organizationId: string,
  values: AttendanceSettingsValues,
  tx?: DbTransaction
): Promise<AttendanceSettingsType> => {
  const [row] = await (tx ?? db)
    .insert(organizationAttendanceSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: organizationAttendanceSettings.organizationId,
      set: values,
    })
    .returning();

  if (!row) {
    throw new AppError({
      message: "Failed to save attendance settings",
      logging: true,
      code: 500,
      context: { organizationId },
    });
  }

  return row;
};
