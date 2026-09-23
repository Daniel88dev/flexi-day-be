import { db, type DbTransaction } from "../../db/db.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  organizationAttendanceSettings,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { attendanceSettingsChanges } from "../../db/schema/attendance-settings-change-schema.js";
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

/**
 * The self-service window a save writes. Unlike the other rules, a field the
 * body leaves out keeps what is stored, falling back to the defaults on a first
 * save — a client predating the window must not switch it off.
 */
export const selfServiceToSave = (
  body: { selfServiceEnabled?: boolean; selfServiceDays?: number | null },
  stored: AttendanceSettingsType | undefined
): Pick<AttendanceSettingsValues, "selfServiceEnabled" | "selfServiceDays"> => {
  const kept = stored ?? ATTENDANCE_SETTINGS_DEFAULTS;
  return {
    selfServiceEnabled: body.selfServiceEnabled ?? kept.selfServiceEnabled,
    selfServiceDays:
      body.selfServiceDays === undefined ? kept.selfServiceDays : body.selfServiceDays,
  };
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

/** Stripped to the rules, so the log compares like with like whatever columns change. */
const loggedValues = ({
  organizationId: _organizationId,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...values
}: AttendanceSettingsType & { createdAt?: Date; updatedAt?: Date }): AttendanceSettingsValues =>
  values;

/** One row per settings write. Write-only: nothing in the product reads it back. */
export const appendAttendanceSettingsChange = async (
  input: {
    organizationId: string;
    changedByUserId: string;
    before: AttendanceSettingsType | undefined;
    after: AttendanceSettingsType;
  },
  tx: DbTransaction
): Promise<void> => {
  await tx.insert(attendanceSettingsChanges).values({
    id: uuidv4(),
    organizationId: input.organizationId,
    changedByUserId: input.changedByUserId,
    before: input.before ? loggedValues(input.before) : null,
    after: loggedValues(input.after),
  });
};
