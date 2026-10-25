import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSendTemplated,
  mockFilterUsersAcceptingEmail,
  mockCreateNotification,
  mockGetApprovalUsers,
  mockGetPersonContacts,
  mockGetPersonContact,
  mockGetGroupUsers,
  mockPushNotifications,
} = vi.hoisted(() => ({
  mockSendTemplated: vi.fn(),
  mockFilterUsersAcceptingEmail: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockGetApprovalUsers: vi.fn(),
  mockGetPersonContacts: vi.fn(),
  mockGetPersonContact: vi.fn(),
  mockGetGroupUsers: vi.fn(),
  mockPushNotifications: vi.fn(),
}));

vi.mock("../../push/pushServices.js", () => ({ pushNotifications: mockPushNotifications }));

vi.mock("../../email/index.js", () => ({
  emailSender: { sendTemplated: mockSendTemplated },
}));

vi.mock("../../group/groupServices.js", () => ({
  getApprovalUsers: mockGetApprovalUsers,
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  getGroupUsers: mockGetGroupUsers,
}));

vi.mock("../../notification/notificationServices.js", () => ({
  createNotification: mockCreateNotification,
}));

vi.mock("../../person/personName.js", () => ({
  getPersonContacts: mockGetPersonContacts,
  getPersonContact: mockGetPersonContact,
}));

vi.mock("../../userSettings/userSettingsServices.js", () => ({
  filterUsersAcceptingEmail: mockFilterUsersAcceptingEmail,
}));

import {
  formatDateRange,
  formatDayCount,
  notifyVacationCancelled,
  notifyVacationDecision,
  notifyVacationRequested,
  notifyVacationsCancelled,
} from "../vacationNotifier.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";

const groupId = "group-1";

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "vac-1",
  userId: "employee-1",
  groupId,
  requestedDay: "2026-08-12",
  vacationType: CalendarRecordType.Vacation,
  halfDay: false,
  ...overrides,
});

const mainApproverGroup = {
  groupId,
  groupName: "Platform",
  mainApprovalUserId: "approver-1",
  mainApprovalUserName: "Ada Lovelace",
  mainApprovalUserEmail: "ada@example.com",
  tempApprovalUserId: null,
  tempApprovalUserName: null,
  tempApprovalUserEmail: null,
};

// The main approver doubles as the manager, so the base fixture has one recipient.
const group = {
  ...mainApproverGroup,
  managerUserId: mainApproverGroup.mainApprovalUserId,
  managerUserName: mainApproverGroup.mainApprovalUserName,
  managerUserEmail: mainApproverGroup.mainApprovalUserEmail,
};

const manager = {
  managerUserId: "manager-1",
  managerUserName: "Mia Novak",
  managerUserEmail: "mia@example.com",
};

const sentTo = () =>
  mockSendTemplated.mock.calls.map(([email]) => (email as { to: string }).to).sort();

const notifiedUserIds = () =>
  mockCreateNotification.mock.calls.map(([n]) => (n as { userId: string }).userId).sort();

const employee = { id: "employee-1", name: "Dana Holt", email: "dana@example.com" };

describe("date formatting", () => {
  it("formats a single day", () => {
    expect(formatDateRange(["2026-08-12"])).toBe("12 Aug 2026");
  });

  it("formats a span from its outer days regardless of input order", () => {
    expect(formatDateRange(["2026-08-14", "2026-08-12", "2026-08-13"])).toBe(
      "12 Aug 2026 – 14 Aug 2026"
    );
  });

  it("pluralises the day count", () => {
    expect(formatDayCount(1)).toBe("1 day");
    expect(formatDayCount(3)).toBe("3 days");
  });

  it("renders fractional day counts in the plural", () => {
    expect(formatDayCount(0.5)).toBe("0.5 days");
    expect(formatDayCount(1.5)).toBe("1.5 days");
  });
});

describe("vacation notifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApprovalUsers.mockResolvedValue(group);
    mockGetGroupUsers.mockResolvedValue([]);
    mockFilterUsersAcceptingEmail.mockImplementation((ids: string[]) => new Set(ids));
  });

  it("pushes the notices it recorded", async () => {
    const notice = { id: "notice-1", userId: "approver-1" };
    mockCreateNotification.mockResolvedValue(notice);

    await notifyVacationRequested([row()], { id: "employee-1", name: "Dana Holt" }, null);

    expect(mockPushNotifications).toHaveBeenCalledWith([notice]);
  });

  it("emails the group approver when a request is created", async () => {
    await notifyVacationRequested(
      [row(), row({ id: "vac-2", requestedDay: "2026-08-13" })],
      { id: "employee-1", name: "Dana Holt" },
      "Family trip"
    );

    expect(mockSendTemplated).toHaveBeenCalledWith({
      to: "ada@example.com",
      template: "vacation-approval-request",
      data: expect.objectContaining({
        approverName: "Ada Lovelace",
        employeeName: "Dana Holt",
        teamName: "Platform",
        dateRange: "12 Aug 2026 – 13 Aug 2026",
        dayCount: "2 days",
        note: "Family trip",
      }),
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("also reaches members holding approverAccess, and only once each", async () => {
    mockGetGroupUsers.mockResolvedValue([
      // Already the main approver: must not be mailed twice.
      {
        userId: "approver-1",
        approverAccess: true,
        email: "ada@example.com",
        user: { name: "Ada Lovelace" },
      },
      {
        userId: "approver-2",
        approverAccess: true,
        email: "grace@example.com",
        user: { name: "Grace Hopper" },
      },
      {
        userId: "member-3",
        approverAccess: false,
        email: "bob@example.com",
        user: { name: "Bob Dvorak" },
      },
      {
        userId: "employee-1",
        approverAccess: true,
        email: "dana@example.com",
        user: { name: "Dana Holt" },
      },
    ]);

    await notifyVacationRequested([row()], { id: "employee-1", name: "Dana Holt" }, null);

    const recipients = mockSendTemplated.mock.calls.map(([email]) => (email as { to: string }).to);
    expect(recipients.sort()).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("reaches the group's manager even when they hold no approver role", async () => {
    mockGetApprovalUsers.mockResolvedValue({ ...group, ...manager });

    await notifyVacationRequested([row()], { id: "employee-1", name: "Dana Holt" }, null);

    expect(sentTo()).toEqual(["ada@example.com", "mia@example.com"]);
    expect(notifiedUserIds()).toEqual(["approver-1", "manager-1"]);
  });

  it("asks the manager of a group with no main or temp approver", async () => {
    mockGetApprovalUsers.mockResolvedValue({
      ...group,
      mainApprovalUserId: null,
      mainApprovalUserName: null,
      mainApprovalUserEmail: null,
      ...manager,
    });

    await notifyVacationRequested([row()], { id: "employee-1", name: "Dana Holt" }, null);

    expect(sentTo()).toEqual(["mia@example.com"]);
    expect(notifiedUserIds()).toEqual(["manager-1"]);
  });

  it("never tells the person who booked on the member's behalf about their own filing", async () => {
    mockGetApprovalUsers.mockResolvedValue({ ...group, ...manager });

    await notifyVacationRequested(
      [row()],
      { id: "employee-1", name: "Dana Holt" },
      null,
      "manager-1"
    );

    expect(sentTo()).toEqual(["ada@example.com"]);
    expect(notifiedUserIds()).toEqual(["approver-1"]);
  });

  it("substitutes a dash for an empty note so SES never renders a blank", async () => {
    await notifyVacationRequested([row()], { id: "employee-1", name: "Dana Holt" }, "  ");

    expect(mockSendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ note: "—" }),
      })
    );
  });

  it("does not email the requester when they are their own approver", async () => {
    await notifyVacationRequested([row()], { id: "approver-1", name: "Ada Lovelace" }, null);

    expect(mockSendTemplated).not.toHaveBeenCalled();
  });

  it("emails each requester of a bulk decision", async () => {
    mockGetPersonContacts.mockResolvedValue([
      employee,
      { id: "employee-2", name: "Sam Reed", email: "sam@example.com" },
    ]);

    await notifyVacationDecision([row(), row({ id: "vac-2", userId: "employee-2" })], "approved", {
      id: "approver-1",
      name: "Ada Lovelace",
    });

    expect(mockSendTemplated).toHaveBeenCalledTimes(2);
    expect(mockSendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({ to: "dana@example.com", template: "vacation-approved" })
    );
  });

  it("counts a half-day booking as half a day in the approval email", async () => {
    mockGetPersonContacts.mockResolvedValue([employee]);

    await notifyVacationDecision([row({ halfDay: true })], "approved", {
      id: "approver-1",
      name: "Ada Lovelace",
    });

    expect(mockSendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "vacation-approved",
        data: expect.objectContaining({ dayCount: "0.5 days" }),
      })
    );
  });

  it("shows a half-day booking as half a day in the in-app notification", async () => {
    mockGetPersonContacts.mockResolvedValue([employee]);

    await notifyVacationDecision([row({ halfDay: true })], "approved", {
      id: "approver-1",
      name: "Ada Lovelace",
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Vacation · 12 Aug 2026 (0.5 days)" })
    );
  });

  it("skips the email but still records the in-app notification when the user opted out", async () => {
    mockGetPersonContacts.mockResolvedValue([employee]);
    mockFilterUsersAcceptingEmail.mockResolvedValue(new Set<string>());

    await notifyVacationDecision([row()], "rejected", { id: "approver-1", name: "Ada Lovelace" });

    expect(mockSendTemplated).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("tells the employee when someone else cancels their approved time off", async () => {
    mockGetPersonContacts.mockResolvedValue([employee]);

    await notifyVacationCancelled(
      { ...row(), approvedAt: new Date("2026-08-01T00:00:00Z"), rejectedAt: null },
      { id: "approver-1", name: "Ada Lovelace" },
      null
    );

    expect(mockSendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dana@example.com",
        template: "vacation-cancelled",
        data: expect.objectContaining({
          recipientName: "Dana Holt",
          cancelledByName: "Ada Lovelace",
          reason: "—",
        }),
      })
    );
  });

  it("tells the approver when the employee cancels their own approved time off", async () => {
    mockGetPersonContacts.mockResolvedValue([employee]);

    await notifyVacationCancelled(
      { ...row(), approvedAt: new Date("2026-08-01T00:00:00Z"), rejectedAt: null },
      { id: "employee-1", name: "Dana Holt" },
      "Plans changed"
    );

    expect(mockSendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        data: expect.objectContaining({ recipientName: "Ada Lovelace", reason: "Plans changed" }),
      })
    );
  });

  it("tells every approver, the manager included, when an employee bulk-cancels approved days", async () => {
    mockGetPersonContacts.mockResolvedValue([employee]);
    mockGetApprovalUsers.mockResolvedValue({ ...group, ...manager });
    mockGetGroupUsers.mockResolvedValue([
      {
        userId: "approver-2",
        approverAccess: true,
        email: "grace@example.com",
        user: { name: "Grace Hopper" },
      },
    ]);
    const approvedAt = new Date("2026-08-01T00:00:00Z");

    await notifyVacationsCancelled(
      [
        { ...row(), approvedAt, rejectedAt: null },
        { ...row({ id: "vac-2", requestedDay: "2026-08-13" }), approvedAt, rejectedAt: null },
      ],
      { id: "employee-1", name: "Dana Holt" },
      null
    );

    expect(sentTo()).toEqual(["ada@example.com", "grace@example.com", "mia@example.com"]);
    expect(notifiedUserIds()).toEqual(["approver-1", "approver-2", "manager-1"]);
  });
});

describe("cancellation notices to the member", () => {
  const approvedAt = new Date("2026-08-01T00:00:00Z");
  const manager = { id: "manager-1", name: "Mia Novak" };
  const otherMember = { id: "employee-2", name: "Eli Park", email: "eli@example.com" };
  const contacts = [employee, otherMember];

  const pending = (overrides: Partial<Record<string, unknown>> = {}) => ({
    ...row(overrides),
    approvedAt: null,
    rejectedAt: null,
  });
  const approved = (overrides: Partial<Record<string, unknown>> = {}) => ({
    ...pending(overrides),
    approvedAt,
  });

  const notices = () =>
    mockCreateNotification.mock.calls.map(
      ([n]) => n as { userId: string; title: string; body: string }
    );
  const mails = () =>
    mockSendTemplated.mock.calls.map(
      ([m]) => m as { to: string; template: string; data: Record<string, string> }
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApprovalUsers.mockResolvedValue(group);
    mockGetGroupUsers.mockResolvedValue([]);
    mockFilterUsersAcceptingEmail.mockImplementation((ids: string[]) => new Set(ids));
    mockGetPersonContact.mockImplementation(async (id: string) =>
      contacts.find((c) => c.id === id)
    );
    mockGetPersonContacts.mockImplementation(async (ids: string[]) =>
      contacts.filter((c) => ids.includes(c.id))
    );
  });

  it("tells the member who cancelled their pending request and why", async () => {
    await notifyVacationCancelled(pending(), manager, " Team offsite that week ");

    expect(notices()).toEqual([
      expect.objectContaining({
        userId: "employee-1",
        title: "Mia Novak cancelled your time-off request",
        body: "Vacation · 12 Aug 2026 (1 day) · Reason: Team offsite that week",
      }),
    ]);
    expect(mails()).toEqual([
      {
        to: "dana@example.com",
        template: "vacation-request-cancelled",
        data: {
          employeeName: "Dana Holt",
          cancelledByName: "Mia Novak",
          teamName: "Platform",
          leaveType: "Vacation",
          dateRange: "12 Aug 2026",
          dayCount: "1 day",
          reason: "Team offsite that week",
          requestUrl: expect.stringContaining("vacationId=vac-1"),
        },
      },
    ]);
  });

  it("puts a dash in the mail and leaves the reason out of the notice when none was given", async () => {
    await notifyVacationCancelled(pending(), manager, null);

    expect(notices()[0]?.body).toBe("Vacation · 12 Aug 2026 (1 day)");
    expect(mails()[0]?.data.reason).toBe("—");
  });

  it("tells each member of a bulk cancel about their own pending days", async () => {
    await notifyVacationsCancelled(
      [
        pending(),
        pending({ id: "vac-2", requestedDay: "2026-08-13" }),
        pending({ id: "vac-3", userId: "employee-2", requestedDay: "2026-08-20" }),
      ],
      manager,
      "Team offsite"
    );

    expect(notifiedUserIds()).toEqual(["employee-1", "employee-2"]);
    expect(mails().map((m) => [m.to, m.template, m.data.dateRange])).toEqual([
      ["dana@example.com", "vacation-request-cancelled", "12 Aug 2026 – 13 Aug 2026"],
      ["eli@example.com", "vacation-request-cancelled", "20 Aug 2026"],
    ]);
  });

  it("names the canceller to the member, not the member, when their approved time off is cancelled", async () => {
    await notifyVacationCancelled(approved(), manager, "Coverage gap");

    expect(notices()).toEqual([
      expect.objectContaining({
        userId: "employee-1",
        title: "Mia Novak cancelled your approved time off",
        body: "Vacation · 12 Aug 2026 (1 day) · Reason: Coverage gap",
      }),
    ]);
    expect(notices()[0]?.body).not.toContain("Dana Holt");
    expect(mails()).toEqual([
      expect.objectContaining({
        to: "dana@example.com",
        template: "vacation-cancelled",
        data: expect.objectContaining({ cancelledByName: "Mia Novak", reason: "Coverage gap" }),
      }),
    ]);
  });

  it("stays silent when the member cancels their own pending request", async () => {
    await notifyVacationCancelled(pending(), { id: "employee-1", name: "Dana Holt" }, null);
    await notifyVacationsCancelled([pending()], { id: "employee-1", name: "Dana Holt" }, null);

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendTemplated).not.toHaveBeenCalled();
  });

  it("keeps the approver wording when the member cancels their own approved days", async () => {
    await notifyVacationsCancelled([approved()], { id: "employee-1", name: "Dana Holt" }, null);

    expect(notices()).toEqual([
      expect.objectContaining({
        userId: "approver-1",
        title: "Approved time off cancelled",
        body: "Dana Holt · Vacation · 12 Aug 2026",
      }),
    ]);
    expect(mails()).toEqual([
      expect.objectContaining({ to: "ada@example.com", template: "vacation-cancelled" }),
    ]);
  });

  it("notifies only the other member when the actor's own rows share the batch", async () => {
    await notifyVacationsCancelled(
      [pending(), pending({ id: "vac-3", userId: "employee-2" })],
      { id: "employee-1", name: "Dana Holt" },
      null
    );

    expect(notifiedUserIds()).toEqual(["employee-2"]);
    expect(sentTo()).toEqual(["eli@example.com"]);
    expect(notices()[0]?.title).toBe("Dana Holt cancelled your time-off request");
  });

  it("tells a member about both their pending and their approved days in one batch", async () => {
    await notifyVacationsCancelled(
      [approved(), pending({ id: "vac-2", requestedDay: "2026-08-14" })],
      manager,
      null
    );

    expect(notices().map((n) => [n.userId, n.title, n.body])).toEqual([
      [
        "employee-1",
        "Mia Novak cancelled your approved time off",
        "Vacation · 12 Aug 2026 (1 day)",
      ],
      ["employee-1", "Mia Novak cancelled your time-off request", "Vacation · 14 Aug 2026 (1 day)"],
    ]);
    expect(mails().map((m) => m.template)).toEqual([
      "vacation-cancelled",
      "vacation-request-cancelled",
    ]);
  });

  it("records the notice but sends no mail to a member who opted out of e-mail", async () => {
    mockFilterUsersAcceptingEmail.mockResolvedValue(new Set<string>());

    await notifyVacationCancelled(pending(), manager, null);

    expect(notifiedUserIds()).toEqual(["employee-1"]);
    expect(mockSendTemplated).not.toHaveBeenCalled();
  });

  it("says nothing about days that had already been declined", async () => {
    await notifyVacationsCancelled([{ ...pending(), rejectedAt: approvedAt }], manager, null);

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendTemplated).not.toHaveBeenCalled();
  });

  it("swallows a delivery failure so the cancellation still succeeds", async () => {
    mockCreateNotification.mockRejectedValue(new Error("db down"));

    await expect(notifyVacationCancelled(pending(), manager, null)).resolves.toBeUndefined();
    await expect(notifyVacationsCancelled([pending()], manager, null)).resolves.toBeUndefined();
  });
});
