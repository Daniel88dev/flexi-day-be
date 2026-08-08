import * as vacationServices from "./vacation/vacationServices.js";
import * as vacationEventServices from "./vacationEvent/vacationEventServices.js";
import * as groupUserServices from "./groupUser/groupUserServices.js";
import * as groupServices from "./group/groupServices.js";
import * as groupMirrorServices from "./groupMirror/groupMirrorServices.js";
import * as userYearQuotasServices from "./userYearQuotas/userYearQuotasServices.js";
import * as changesServices from "./changes/changesServices.js";
import * as userSettingsServices from "./userSettings/userSettingsServices.js";
import * as userServices from "./user/userServices.js";
import * as bankHolidayServices from "./bankHoliday/bankHolidayServices.js";
import * as notificationServices from "./notification/notificationServices.js";
import * as calendarSyncServices from "./calendarSync/calendarSyncServices.js";
import * as reportServices from "./report/reportServices.js";
import * as quotaRolloverServices from "./quotaRollover/quotaRolloverServices.js";

export type DBServices = Readonly<{
  vacation: {
    getVacationById: typeof vacationServices.getVacationById;
    getVacationDetailById: typeof vacationServices.getVacationDetailById;
    getVacationsForGroup: typeof vacationServices.getVacationsForGroup;
    getVacationsForUser: typeof vacationServices.getVacationsForUser;
    postVacation: typeof vacationServices.postVacation;
    postVacationBulk: typeof vacationServices.postVacationBulk;
    approveVacation: typeof vacationServices.approveVacation;
    rejectVacation: typeof vacationServices.rejectVacation;
    approveVacationsBulk: typeof vacationServices.approveVacationsBulk;
    rejectVacationsBulk: typeof vacationServices.rejectVacationsBulk;
    cancelVacationsBulk: typeof vacationServices.cancelVacationsBulk;
    getVacationsByIds: typeof vacationServices.getVacationsByIds;
    deleteVacation: typeof vacationServices.deleteVacation;
    getPendingApprovalsForApprover: typeof vacationServices.getPendingApprovalsForApprover;
    countUsersOutOnDay: typeof vacationServices.countUsersOutOnDay;
    countApprovedVacationsInRange: typeof vacationServices.countApprovedVacationsInRange;
    aggregateUserUsageForYear: typeof vacationServices.aggregateUserUsageForYear;
    sumCountedDaysForQuota: typeof vacationServices.sumCountedDaysForQuota;
  };
  vacationEvent: {
    createVacationEvent: typeof vacationEventServices.createVacationEvent;
    createVacationEvents: typeof vacationEventServices.createVacationEvents;
    getVacationEvents: typeof vacationEventServices.getVacationEvents;
  };
  groupUser: {
    getGroupUser: typeof groupUserServices.getGroupUser;
    getGroupUsers: typeof groupUserServices.getGroupUsers;
    createGroupUser: typeof groupUserServices.createGroupUser;
    updateGroupUserPermissions: typeof groupUserServices.updateGroupUserPermissions;
    deleteGroupUser: typeof groupUserServices.deleteGroupUser;
    getAllGroupsForUser: typeof groupUserServices.getAllGroupsForUser;
    getAdminGroupIdsForUser: typeof groupUserServices.getAdminGroupIdsForUser;
    getMembershipPairs: typeof groupUserServices.getMembershipPairs;
    countDistinctUsersInGroups: typeof groupUserServices.countDistinctUsersInGroups;
  };
  inviteLinks: {
    createInviteLink: typeof groupUserServices.createInviteLink;
    getInviteLinksForGroup: typeof groupUserServices.getInviteLinksForGroup;
    getOpenInvitesForGroup: typeof groupUserServices.getOpenInvitesForGroup;
    getInviteLinkByCode: typeof groupUserServices.getInviteLinkByCode;
    getInviteLinkById: typeof groupUserServices.getInviteLinkById;
    revokeOpenInviteForEmail: typeof groupUserServices.revokeOpenInviteForEmail;
    revokeInviteLink: typeof groupUserServices.revokeInviteLink;
    useInviteLink: typeof groupUserServices.useInviteLink;
  };
  group: {
    getGroup: typeof groupServices.getGroup;
    getAllGroups: typeof groupServices.getAllGroups;
    createGroup: typeof groupServices.createGroup;
    updateGroupManager: typeof groupServices.updateGroupManager;
    updateGroupApprovalUsers: typeof groupServices.updateGroupApprovalUsers;
    deleteGroup: typeof groupServices.deleteGroup;
    updateGroupQuotas: typeof groupServices.updateGroupQuotas;
    updateGroupWorkingDays: typeof groupServices.updateGroupWorkingDays;
    getApprovalUsers: typeof groupServices.getApprovalUsers;
    getGroupsWhereUserCanApprove: typeof groupServices.getGroupsWhereUserCanApprove;
  };
  groupMirror: {
    getMirrorsIntoGroupForUser: typeof groupMirrorServices.getMirrorsIntoGroupForUser;
    getMirrorsIntoGroupForUsers: typeof groupMirrorServices.getMirrorsIntoGroupForUsers;
    getMirrorsForUser: typeof groupMirrorServices.getMirrorsForUser;
    hasMirrorIntoGroup: typeof groupMirrorServices.hasMirrorIntoGroup;
    setMirrorsIntoGroupForUser: typeof groupMirrorServices.setMirrorsIntoGroupForUser;
  };
  userYearQuotas: {
    getUserYearGroupQuotas: typeof userYearQuotasServices.getUserYearGroupQuotas;
    insertUserYearQuotas: typeof userYearQuotasServices.insertUserYearQuotas;
    decreaseChangeForUserYearQuotas: typeof userYearQuotasServices.decreaseChangeForUserYearQuotas;
    updateUserYearQuotasById: typeof userYearQuotasServices.updateUserYearQuotasById;
    upsertUserYearQuota: typeof userYearQuotasServices.upsertUserYearQuota;
    openQuotaFromGroupDefaults: typeof userYearQuotasServices.openQuotaFromGroupDefaults;
    sumUserQuotasForYear: typeof userYearQuotasServices.sumUserQuotasForYear;
  };
  changes: {
    getChanges: typeof changesServices.getChangesForUser;
    postChanges: typeof changesServices.postChanges;
  };
  user: {
    getUserById: typeof userServices.getUserById;
    getUserByEmail: typeof userServices.getUserByEmail;
    getUsersByIds: typeof userServices.getUsersByIds;
  };
  userSettings: {
    getUserSettings: typeof userSettingsServices.getUserSettings;
    upsertUserSettings: typeof userSettingsServices.upsertUserSettings;
    filterUsersAcceptingEmail: typeof userSettingsServices.filterUsersAcceptingEmail;
  };
  bankHoliday: {
    listBankHolidays: typeof bankHolidayServices.listBankHolidays;
  };
  notification: {
    listNotificationsForUser: typeof notificationServices.listNotificationsForUser;
    markNotificationRead: typeof notificationServices.markNotificationRead;
    markAllNotificationsRead: typeof notificationServices.markAllNotificationsRead;
    getNotificationForUser: typeof notificationServices.getNotificationForUser;
    createNotification: typeof notificationServices.createNotification;
    deleteNotificationForUser: typeof notificationServices.deleteNotificationForUser;
    deleteAllNotificationsForUser: typeof notificationServices.deleteAllNotificationsForUser;
  };
  calendarSync: {
    generateFeedToken: typeof calendarSyncServices.generateFeedToken;
    createCalendarSync: typeof calendarSyncServices.createCalendarSync;
    getCalendarSyncForUser: typeof calendarSyncServices.getCalendarSyncForUser;
    getCalendarSyncById: typeof calendarSyncServices.getCalendarSyncById;
    getCalendarSyncByToken: typeof calendarSyncServices.getCalendarSyncByToken;
    updateCalendarSync: typeof calendarSyncServices.updateCalendarSync;
    softDeleteCalendarSync: typeof calendarSyncServices.softDeleteCalendarSync;
    regenerateToken: typeof calendarSyncServices.regenerateToken;
    touchLastFetched: typeof calendarSyncServices.touchLastFetched;
    getFeedRecords: typeof calendarSyncServices.getFeedRecords;
  };
  report: {
    getScopeEntries: typeof reportServices.getScopeEntries;
    getReportScope: typeof reportServices.getReportScope;
    getScopeMembers: typeof reportServices.getScopeMembers;
    aggregateUsageByUserMonth: typeof reportServices.aggregateUsageByUserMonth;
    aggregateUsageSplit: typeof reportServices.aggregateUsageSplit;
    getQuotasForScope: typeof reportServices.getQuotasForScope;
    getBookingsForScope: typeof reportServices.getBookingsForScope;
    getMemberGroupsInScope: typeof reportServices.getMemberGroupsInScope;
    getMemberChanges: typeof reportServices.getMemberChanges;
    getCarryOverSuggestion: typeof reportServices.getCarryOverSuggestion;
    recordReportExport: typeof reportServices.recordReportExport;
  };
  quotaRollover: {
    findRolloverCandidates: typeof quotaRolloverServices.findRolloverCandidates;
    rolloverQuotasForYear: typeof quotaRolloverServices.rolloverQuotasForYear;
  };
}>;

export const createDBServices = (): DBServices => {
  return {
    vacation: {
      getVacationById: vacationServices.getVacationById,
      getVacationDetailById: vacationServices.getVacationDetailById,
      getVacationsForGroup: vacationServices.getVacationsForGroup,
      getVacationsForUser: vacationServices.getVacationsForUser,
      postVacation: vacationServices.postVacation,
      postVacationBulk: vacationServices.postVacationBulk,
      approveVacation: vacationServices.approveVacation,
      rejectVacation: vacationServices.rejectVacation,
      approveVacationsBulk: vacationServices.approveVacationsBulk,
      rejectVacationsBulk: vacationServices.rejectVacationsBulk,
      cancelVacationsBulk: vacationServices.cancelVacationsBulk,
      getVacationsByIds: vacationServices.getVacationsByIds,
      deleteVacation: vacationServices.deleteVacation,
      getPendingApprovalsForApprover: vacationServices.getPendingApprovalsForApprover,
      countUsersOutOnDay: vacationServices.countUsersOutOnDay,
      countApprovedVacationsInRange: vacationServices.countApprovedVacationsInRange,
      aggregateUserUsageForYear: vacationServices.aggregateUserUsageForYear,
      sumCountedDaysForQuota: vacationServices.sumCountedDaysForQuota,
    },
    vacationEvent: {
      createVacationEvent: vacationEventServices.createVacationEvent,
      createVacationEvents: vacationEventServices.createVacationEvents,
      getVacationEvents: vacationEventServices.getVacationEvents,
    },
    groupUser: {
      getGroupUser: groupUserServices.getGroupUser,
      getGroupUsers: groupUserServices.getGroupUsers,
      createGroupUser: groupUserServices.createGroupUser,
      updateGroupUserPermissions: groupUserServices.updateGroupUserPermissions,
      deleteGroupUser: groupUserServices.deleteGroupUser,
      getAllGroupsForUser: groupUserServices.getAllGroupsForUser,
      getAdminGroupIdsForUser: groupUserServices.getAdminGroupIdsForUser,
      getMembershipPairs: groupUserServices.getMembershipPairs,
      countDistinctUsersInGroups: groupUserServices.countDistinctUsersInGroups,
    },
    inviteLinks: {
      createInviteLink: groupUserServices.createInviteLink,
      getInviteLinksForGroup: groupUserServices.getInviteLinksForGroup,
      getOpenInvitesForGroup: groupUserServices.getOpenInvitesForGroup,
      getInviteLinkByCode: groupUserServices.getInviteLinkByCode,
      getInviteLinkById: groupUserServices.getInviteLinkById,
      revokeOpenInviteForEmail: groupUserServices.revokeOpenInviteForEmail,
      revokeInviteLink: groupUserServices.revokeInviteLink,
      useInviteLink: groupUserServices.useInviteLink,
    },
    group: {
      getGroup: groupServices.getGroup,
      getAllGroups: groupServices.getAllGroups,
      createGroup: groupServices.createGroup,
      updateGroupManager: groupServices.updateGroupManager,
      updateGroupApprovalUsers: groupServices.updateGroupApprovalUsers,
      deleteGroup: groupServices.deleteGroup,
      updateGroupQuotas: groupServices.updateGroupQuotas,
      updateGroupWorkingDays: groupServices.updateGroupWorkingDays,
      getApprovalUsers: groupServices.getApprovalUsers,
      getGroupsWhereUserCanApprove: groupServices.getGroupsWhereUserCanApprove,
    },
    groupMirror: {
      getMirrorsIntoGroupForUser: groupMirrorServices.getMirrorsIntoGroupForUser,
      getMirrorsIntoGroupForUsers: groupMirrorServices.getMirrorsIntoGroupForUsers,
      getMirrorsForUser: groupMirrorServices.getMirrorsForUser,
      hasMirrorIntoGroup: groupMirrorServices.hasMirrorIntoGroup,
      setMirrorsIntoGroupForUser: groupMirrorServices.setMirrorsIntoGroupForUser,
    },
    userYearQuotas: {
      getUserYearGroupQuotas: userYearQuotasServices.getUserYearGroupQuotas,
      insertUserYearQuotas: userYearQuotasServices.insertUserYearQuotas,
      decreaseChangeForUserYearQuotas: userYearQuotasServices.decreaseChangeForUserYearQuotas,
      updateUserYearQuotasById: userYearQuotasServices.updateUserYearQuotasById,
      upsertUserYearQuota: userYearQuotasServices.upsertUserYearQuota,
      openQuotaFromGroupDefaults: userYearQuotasServices.openQuotaFromGroupDefaults,
      sumUserQuotasForYear: userYearQuotasServices.sumUserQuotasForYear,
    },
    changes: {
      getChanges: changesServices.getChangesForUser,
      postChanges: changesServices.postChanges,
    },
    user: {
      getUserById: userServices.getUserById,
      getUserByEmail: userServices.getUserByEmail,
      getUsersByIds: userServices.getUsersByIds,
    },
    userSettings: {
      getUserSettings: userSettingsServices.getUserSettings,
      upsertUserSettings: userSettingsServices.upsertUserSettings,
      filterUsersAcceptingEmail: userSettingsServices.filterUsersAcceptingEmail,
    },
    bankHoliday: {
      listBankHolidays: bankHolidayServices.listBankHolidays,
    },
    notification: {
      listNotificationsForUser: notificationServices.listNotificationsForUser,
      markNotificationRead: notificationServices.markNotificationRead,
      markAllNotificationsRead: notificationServices.markAllNotificationsRead,
      getNotificationForUser: notificationServices.getNotificationForUser,
      createNotification: notificationServices.createNotification,
      deleteNotificationForUser: notificationServices.deleteNotificationForUser,
      deleteAllNotificationsForUser: notificationServices.deleteAllNotificationsForUser,
    },
    calendarSync: {
      generateFeedToken: calendarSyncServices.generateFeedToken,
      createCalendarSync: calendarSyncServices.createCalendarSync,
      getCalendarSyncForUser: calendarSyncServices.getCalendarSyncForUser,
      getCalendarSyncById: calendarSyncServices.getCalendarSyncById,
      getCalendarSyncByToken: calendarSyncServices.getCalendarSyncByToken,
      updateCalendarSync: calendarSyncServices.updateCalendarSync,
      softDeleteCalendarSync: calendarSyncServices.softDeleteCalendarSync,
      regenerateToken: calendarSyncServices.regenerateToken,
      touchLastFetched: calendarSyncServices.touchLastFetched,
      getFeedRecords: calendarSyncServices.getFeedRecords,
    },
    report: {
      getScopeEntries: reportServices.getScopeEntries,
      getReportScope: reportServices.getReportScope,
      getScopeMembers: reportServices.getScopeMembers,
      aggregateUsageByUserMonth: reportServices.aggregateUsageByUserMonth,
      aggregateUsageSplit: reportServices.aggregateUsageSplit,
      getQuotasForScope: reportServices.getQuotasForScope,
      getBookingsForScope: reportServices.getBookingsForScope,
      getMemberGroupsInScope: reportServices.getMemberGroupsInScope,
      getMemberChanges: reportServices.getMemberChanges,
      getCarryOverSuggestion: reportServices.getCarryOverSuggestion,
      recordReportExport: reportServices.recordReportExport,
    },
    quotaRollover: {
      findRolloverCandidates: quotaRolloverServices.findRolloverCandidates,
      rolloverQuotasForYear: quotaRolloverServices.rolloverQuotasForYear,
    },
  };
};
