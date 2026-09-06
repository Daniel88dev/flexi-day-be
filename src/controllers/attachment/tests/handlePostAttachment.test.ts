import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetRequestAnchorRow,
  mockResolveVacationPermissions,
  mockIsRequestPastRetention,
  mockGetGroup,
  mockAssertAttachmentUploadAvailable,
  mockCountAttachmentSlotsUsed,
  mockCreateAttachment,
  mockDiscardAttachment,
  mockCreateUploadTarget,
} = vi.hoisted(() => ({
  mockGetRequestAnchorRow: vi.fn(),
  mockResolveVacationPermissions: vi.fn(),
  mockIsRequestPastRetention: vi.fn(),
  mockGetGroup: vi.fn(),
  mockAssertAttachmentUploadAvailable: vi.fn(),
  mockCountAttachmentSlotsUsed: vi.fn(),
  mockCreateAttachment: vi.fn(),
  mockDiscardAttachment: vi.fn(),
  mockCreateUploadTarget: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: (run: (tx: unknown) => unknown) => run({}) },
}));

vi.mock("../../../services/vacation/vacationServices.js", () => ({
  getRequestAnchorRow: mockGetRequestAnchorRow,
}));

vi.mock("../../../services/vacation/vacationPermissions.js", () => ({
  resolveVacationPermissions: mockResolveVacationPermissions,
}));

vi.mock("../../../services/attachment/attachmentRetention.js", () => ({
  isRequestPastRetention: mockIsRequestPastRetention,
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  getGroup: mockGetGroup,
}));

vi.mock("../../../services/billing/guards.js", () => ({
  assertAttachmentUploadAvailable: mockAssertAttachmentUploadAvailable,
}));

vi.mock("../../../services/attachment/attachmentServices.js", () => ({
  lockRequestForAttachments: vi.fn(),
  countAttachmentSlotsUsed: mockCountAttachmentSlotsUsed,
  createAttachment: mockCreateAttachment,
  discardAttachment: mockDiscardAttachment,
  toAttachmentView: (row: { id: string }) => ({ id: row.id }),
}));

vi.mock("../../../services/attachment/attachmentStore.js", () => ({
  attachmentStore: { createUploadTarget: mockCreateUploadTarget },
}));

import { handlePostAttachment } from "../handlePostAttachment.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const groupId = "550e8400-e29b-41d4-a716-446655440009";

const body = {
  requestId,
  fileName: "note.png",
  contentType: "image/png",
  size: 1024,
};

const target = { url: "http://store/upload", method: "PUT", headers: {}, expiresAt: "soon" };

describe("handlePostAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    mockGetRequestAnchorRow.mockResolvedValue({ userId: mockAuthData.userId, groupId });
    mockResolveVacationPermissions.mockResolvedValue({ canAttach: true });
    mockIsRequestPastRetention.mockResolvedValue(false);
    mockGetGroup.mockResolvedValue({ id: groupId, organizationId: "org-1" });
    mockAssertAttachmentUploadAvailable.mockResolvedValue(undefined);
    mockCountAttachmentSlotsUsed.mockResolvedValue(0);
    mockCreateAttachment.mockImplementation((data: { id: string }) =>
      Promise.resolve({ ...body, ...data })
    );
    mockDiscardAttachment.mockResolvedValue(undefined);
    mockCreateUploadTarget.mockResolvedValue(target);
  });

  it("registers the row and answers with where to send the bytes", async () => {
    const { req, res } = makeReqRes({ body });

    await handlePostAttachment(req, res);

    const created = mockCreateAttachment.mock.calls[0]![0] as { id: string };
    expect(mockCreateUploadTarget).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: created.id, contentType: "image/png" })
    );
    expect(mockDiscardAttachment).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ attachment: { id: created.id }, upload: target });
  });

  it("drops the row again when no upload target can be made, so its slot is free", async () => {
    mockCreateUploadTarget.mockRejectedValue(new Error("no credentials"));
    const { req, res } = makeReqRes({ body });

    await expect(handlePostAttachment(req, res)).rejects.toThrow("no credentials");

    const created = mockCreateAttachment.mock.calls[0]![0] as { id: string };
    expect(mockDiscardAttachment).toHaveBeenCalledWith(created.id);
    expect(res.status).not.toHaveBeenCalled();
  });
});
