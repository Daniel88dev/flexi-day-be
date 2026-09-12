import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { presentAttendanceSettings, resolveAdministeredOrganization } from "./utils.js";
import type { ValidatedPutAttendanceSettingsType } from "../../services/organization/types.js";
import {
  getAttendanceSettings,
  upsertAttendanceSettings,
} from "../../services/organization/attendanceSettingsServices.js";
import { assertAttendanceActive, isAttendanceActive } from "../../services/billing/guards.js";

/**
 * Replaces the organization's attendance rules. Org admins alike, owner and
 * delegate — the settings are not billing-adjacent.
 *
 * The plan check runs *after* the write and inside its transaction: it is the
 * same `assertAttendanceActive` every later attendance write calls, and it
 * reads the toggle, so it can only answer once the new value is in place. A
 * 402 rolls the whole put back. Only an actual switch-on is gated, so a lapsed
 * organization can still correct its rules and turning the feature off is
 * never refused.
 */
export const handlePutAttendanceSettings = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutAttendanceSettingsType = req.body;

  const { organization } = await resolveAdministeredOrganization(req);

  const settings = await db.transaction(async (tx) => {
    const stored = await getAttendanceSettings(organization.id, tx);
    const turningOn = data.attendanceEnabled && !stored?.attendanceEnabled;

    const written = await upsertAttendanceSettings(organization.id, data, tx);

    if (turningOn) await assertAttendanceActive(organization.id, tx);

    return written;
  });

  return res
    .status(200)
    .json(presentAttendanceSettings(settings, await isAttendanceActive(organization.id)));
};
