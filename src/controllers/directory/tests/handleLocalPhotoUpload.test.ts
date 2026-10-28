import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockProcess, mockSettle, mockRemove } = vi.hoisted(() => ({
  mockProcess: vi.fn(),
  mockSettle: vi.fn(),
  mockRemove: vi.fn(async () => {}),
}));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})) },
}));

vi.mock("../../../services/directory/directoryPhotoServices.js", () => ({
  processLocalPhotoUpload: mockProcess,
  settlePhoto: mockSettle,
  removePhotoObjects: mockRemove,
}));

vi.mock("../../../services/organizationData/organizationDataStore.js", () => ({
  verifyLocalPhotoUpload: vi.fn(() => true),
}));

import { handleLocalPhotoUpload } from "../handleLocalPhotoUpload.js";
import { makeReqRes } from "../../../tests/testUtils.js";

const photoId = "photo_1";
const prefix = "org/photos/photo_1/";

const upload = () =>
  makeReqRes({
    params: { photoId },
    query: { expires: "9999999999", signature: "sig" },
    body: Buffer.from("jpeg"),
  });

describe("handleLocalPhotoUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockResolvedValue({ outcome: { status: "READY" }, written: prefix });
  });

  it("keeps the written objects when a racing upload already settled the photo as READY", async () => {
    mockSettle.mockResolvedValue({ result: "already", photo: { id: photoId, status: "READY" } });
    const { req, res } = upload();

    await expect(handleLocalPhotoUpload(req, res)).rejects.toMatchObject({ code: 409 });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("removes the written objects when the photo settled as anything but READY", async () => {
    mockSettle.mockResolvedValue({ result: "already", photo: { id: photoId, status: "REJECTED" } });
    const { req, res } = upload();

    await expect(handleLocalPhotoUpload(req, res)).rejects.toMatchObject({ code: 409 });
    expect(mockRemove).toHaveBeenCalledWith([prefix]);
  });

  it("removes the written objects when the photo is gone", async () => {
    mockSettle.mockResolvedValue({ result: "gone" });
    const { req, res } = upload();

    await expect(handleLocalPhotoUpload(req, res)).rejects.toMatchObject({ code: 409 });
    expect(mockRemove).toHaveBeenCalledWith([prefix]);
  });
});
