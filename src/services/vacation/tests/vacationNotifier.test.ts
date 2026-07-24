import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSendTemplated,
  mockFilterUsersAcceptingEmail,
  mockCreateNotification,
  mockGetApprovalUsers,
  mockGetUsersByIds,
  mockGetUserById,
} = vi.hoisted(() => ({
  mockSendTemplated: vi.fn(),
  mockFilterUsersAcceptingEmail: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockGetApprovalUsers: vi.fn(),
  mockGetUsersByIds: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock("../../email/index.js", () => ({
  emailSender: { sendTemplated: mockSendTemplated },
}));

vi.mock("../../DBServices.js", () => ({
  createDBServices: () => ({
    userSettings: { filterUsersAcceptingEmail: mockFilterUsersAcceptingEmail },
    notification: { createNotification: mockCreateNotification },
    group: { getApprovalUsers: mockGetApprovalUsers },
    user: { getUsersByIds: mockGetUsersByIds, getUserById: mockGetUserById },
  }),
}));

import {
  formatDateRange,
  formatDayCount,
  notifyVacationCancelled,
  notifyVacationDecision,
  notifyVacationRequested,
} from "../vacationNotifier.js";
import { vacationType } from "../../../db/schema/vacation-schema.js";

const groupId = "group-1";

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "vac-1",
  userId: "employee-1",
  groupId,
  requestedDay: "2026-08-12",
  vacationType: vacationType.Vacation,
  ...overrides,
});

const group = {
  groupId,
  groupName: "Platform",
  mainApprovalUserId: "approver-1",
  mainApprovalUserName: "Ada Lovelace",
  mainApprovalUserEmail: "ada@example.com",
  tempApprovalUserId: null,
  tempApprovalUserName: null,
  tempApprovalUserEmail: null,
};

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
});

describe("vacation notifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApprovalUsers.mockResolvedValue(group);
    mockFilterUsersAcceptingEmail.mockImplementation((ids: string[]) => new Set(ids));
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
    mockGetUsersByIds.mockResolvedValue([
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

  it("skips the email but still records the in-app notification when the user opted out", async () => {
    mockGetUsersByIds.mockResolvedValue([employee]);
    mockFilterUsersAcceptingEmail.mockResolvedValue(new Set<string>());

    await notifyVacationDecision([row()], "rejected", { id: "approver-1", name: "Ada Lovelace" });

    expect(mockSendTemplated).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a pending (never approved) request is cancelled", async () => {
    await notifyVacationCancelled({ ...row(), approvedAt: null }, { id: "x", name: "X" }, null);

    expect(mockSendTemplated).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("tells the employee when someone else cancels their approved time off", async () => {
    mockGetUserById.mockResolvedValue(employee);

    await notifyVacationCancelled(
      { ...row(), approvedAt: new Date("2026-08-01T00:00:00Z") },
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
    mockGetUserById.mockResolvedValue(employee);

    await notifyVacationCancelled(
      { ...row(), approvedAt: new Date("2026-08-01T00:00:00Z") },
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
});
