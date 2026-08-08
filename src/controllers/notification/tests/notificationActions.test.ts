import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDeleteOne, mockDeleteAll, mockMarkAllRead } = vi.hoisted(() => ({
  mockDeleteOne: vi.fn(),
  mockDeleteAll: vi.fn(),
  mockMarkAllRead: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    notification: {
      deleteNotificationForUser: mockDeleteOne,
      deleteAllNotificationsForUser: mockDeleteAll,
      markAllNotificationsRead: mockMarkAllRead,
    },
  }),
}));

import { handleDeleteNotification } from "../handleDeleteNotification.js";
import { handleDeleteAllNotifications } from "../handleDeleteAllNotifications.js";
import { handlePostNotificationsReadAll } from "../handlePostNotificationsReadAll.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";
import AppError from "../../../utils/appError.js";

const NOTIFICATION_ID = "3f1b8a2c-9d47-4c1e-8f2a-5b6c7d8e9f01";

describe("notification actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
  });

  describe("handleDeleteNotification", () => {
    it("removes the notification scoped to the caller", async () => {
      mockDeleteOne.mockResolvedValue({ id: NOTIFICATION_ID });
      const { req, res } = makeReqRes({ params: { id: NOTIFICATION_ID } });

      await handleDeleteNotification(req, res);

      expect(mockDeleteOne).toHaveBeenCalledWith(NOTIFICATION_ID, mockAuthData.userId);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: "Notification removed" });
    });

    it("throws 404 when nothing was deleted", async () => {
      mockDeleteOne.mockResolvedValue(undefined);
      const { req, res } = makeReqRes({ params: { id: NOTIFICATION_ID } });

      await expect(handleDeleteNotification(req, res)).rejects.toThrow(AppError);
      expect(res.json).not.toHaveBeenCalled();
    });

    it("rejects a non-uuid id", async () => {
      const { req, res } = makeReqRes({ params: { id: "not-a-uuid" } });

      await expect(handleDeleteNotification(req, res)).rejects.toThrow();
      expect(mockDeleteOne).not.toHaveBeenCalled();
    });
  });

  describe("handleDeleteAllNotifications", () => {
    it("clears every notification of the caller and reports the count", async () => {
      mockDeleteAll.mockResolvedValue(3);
      const { req, res } = makeReqRes();

      await handleDeleteAllNotifications(req, res);

      expect(mockDeleteAll).toHaveBeenCalledWith(mockAuthData.userId);
      expect(res.json).toHaveBeenCalledWith({ message: "Notifications cleared", removed: 3 });
    });

    it("succeeds when there was nothing to clear", async () => {
      mockDeleteAll.mockResolvedValue(0);
      const { req, res } = makeReqRes();

      await handleDeleteAllNotifications(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: "Notifications cleared", removed: 0 });
    });
  });

  describe("handlePostNotificationsReadAll", () => {
    it("marks every unread notification of the caller as read", async () => {
      mockMarkAllRead.mockResolvedValue(2);
      const { req, res } = makeReqRes();

      await handlePostNotificationsReadAll(req, res);

      expect(mockMarkAllRead).toHaveBeenCalledWith(mockAuthData.userId);
      expect(res.json).toHaveBeenCalledWith({
        message: "Notifications marked as read",
        updated: 2,
      });
    });
  });
});
