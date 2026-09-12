import type { Request, Response } from "express";
import { presentAttendanceSettings, resolveAdministeredOrganization } from "./utils.js";
import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
import { getAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { isAttendanceActive } from "../../services/billing/guards.js";

/**
 * An organization that never set attendance up has no row and gets the
 * defaults with the feature off, not a 404 — the screen renders the same form
 * either way.
 */
export const handleGetAttendanceSettings = async (req: Request, res: Response) => {
  const { organization } = await resolveAdministeredOrganization(req);

  const settings = (await getAttendanceSettings(organization.id)) ?? {
    organizationId: organization.id,
    ...ATTENDANCE_SETTINGS_DEFAULTS,
  };

  return res
    .status(200)
    .json(presentAttendanceSettings(settings, await isAttendanceActive(organization.id)));
};
