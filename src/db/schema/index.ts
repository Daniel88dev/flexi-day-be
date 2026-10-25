import { account, session, twoFactor, user, verification } from "./auth-schema.js";
import { groupUsers } from "./group-users-schema.js";
import { groups } from "./group-schema.js";
import { groupMirrors } from "./group-mirror-schema.js";
import { userYearQuotas } from "./user-year-quotas-schema.js";
import { vacation } from "./vacation-schema.js";
import { inviteLink } from "./invite-link-schema.js";
import { bankHolidays } from "./bank-holiday-schema.js";
import { notifications } from "./notification-schema.js";
import { calendarSync, calendarSyncTeams, calendarSyncTypes } from "./calendar-sync-schema.js";
import {
  calendarConnection,
  calendarSyncEvents,
  calendarSyncFakeEvents,
} from "./calendar-connection-schema.js";
import { vacationEvents } from "./vacation-event-schema.js";
import { userSettings } from "./user-settings-schema.js";
import { userBirthdays } from "./user-birthday-schema.js";
import { groupEvents } from "./group-event-schema.js";
import { reportExports } from "./report-export-schema.js";
import { supportAccess } from "./support-access-schema.js";
import { organizations } from "./organization-schema.js";
import { organizationUsers } from "./organization-users-schema.js";
import { subscriptions } from "./subscription-schema.js";
import { paddleEvents } from "./paddle-event-schema.js";
import { attachments } from "./attachment-schema.js";
import { employments } from "./employment-schema.js";
import { organizationAttendanceSettings } from "./organization-attendance-settings-schema.js";
import { attendanceBreaks, attendanceEvents, attendanceSessions } from "./attendance-schema.js";
import { attendanceSettingsChanges } from "./attendance-settings-change-schema.js";
import { pushRegistrations } from "./push-registration-schema.js";
import { authSecretFingerprint } from "./auth-secret-schema.js";
import { personExports } from "./person-export-schema.js";
import { readLog } from "./read-log-schema.js";

export const schema = {
  account,
  session,
  twoFactor,
  user,
  verification,
  groupUsers,
  groups,
  groupMirrors,
  userSettings,
  userBirthdays,
  groupEvents,
  userYearQuotas,
  vacation,
  vacationEvents,
  inviteLink,
  bankHolidays,
  notifications,
  calendarSync,
  calendarSyncTeams,
  calendarSyncTypes,
  calendarConnection,
  calendarSyncEvents,
  calendarSyncFakeEvents,
  reportExports,
  supportAccess,
  organizations,
  organizationUsers,
  subscriptions,
  paddleEvents,
  attachments,
  employments,
  organizationAttendanceSettings,
  attendanceSessions,
  attendanceBreaks,
  attendanceEvents,
  attendanceSettingsChanges,
  pushRegistrations,
  authSecretFingerprint,
  personExports,
  readLog,
};
