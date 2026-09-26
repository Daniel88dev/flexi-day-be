import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateNotification, mockLoggerError } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("../../notification/notificationServices.js", () => ({
  createNotification: mockCreateNotification,
}));

vi.mock("../../../middleware/logger.js", () => ({
  logger: { error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { notifySessionAutoClosed } from "../attendanceNotifier.js";
import { notificationType } from "../../../db/schema/notification-schema.js";

const closed = {
  id: "session-1",
  userId: "user-1",
  businessDate: "2026-08-25",
  timezone: "Europe/Prague",
  closeAt: new Date("2026-08-25T16:30:00Z"),
};

describe("notifySessionAutoClosed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNotification.mockResolvedValue(undefined);
  });

  it("tells the session owner when their clock was closed, in the session's own zone", async () => {
    await notifySessionAutoClosed(closed);

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith({
      id: expect.any(String),
      userId: "user-1",
      type: notificationType.SessionAutoClosed,
      title: "Clock closed automatically",
      body: "Your clock on 25 Aug 2026 was closed automatically at 18:30, check and correct it.",
      href: "/my-attendance/?date=2026-08-25",
    });
  });

  it("links to the business date even when the close falls on the next calendar day", async () => {
    await notifySessionAutoClosed({ ...closed, closeAt: new Date("2026-08-25T22:15:00Z") });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Your clock on 25 Aug 2026 was closed automatically at 00:15, check and correct it.",
        href: "/my-attendance/?date=2026-08-25",
      })
    );
  });

  it("logs and swallows a failed insert, so the sweep carries on", async () => {
    mockCreateNotification.mockRejectedValue(new Error("db down"));

    await expect(notifySessionAutoClosed(closed)).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: "session-1", error: "db down" })
    );
  });
});
