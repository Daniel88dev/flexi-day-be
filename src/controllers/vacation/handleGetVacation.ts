import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { resolveVacationPermissions } from "../../services/vacation/vacationPermissions.js";
import { getVacationDetailById } from "../../services/vacation/vacationServices.js";
import { getVacationEvents } from "../../services/vacationEvent/vacationEventServices.js";
import {
  holdsAttachmentSlot,
  listAttachmentsForRequest,
} from "../../services/attachment/attachmentServices.js";
import { isRequestPastRetention } from "../../services/attachment/attachmentRetention.js";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../../services/attachment/types.js";
import { isAttachmentUploadAvailable } from "../../services/billing/guards.js";
import { getGroup } from "../../services/group/groupServices.js";
import type { VacationDetail } from "../../services/vacation/types.js";
import type { VacationPermissions } from "../../services/vacation/vacationPermissions.js";

/**
 * The Request's attachments and whether this caller may add one right now:
 * standing, plan, the per-request cap and retention together, so the client
 * never offers an upload the create endpoint would refuse.
 */
const attachmentsFor = async (detail: VacationDetail, permissions: VacationPermissions) => {
  const attachments = await listAttachmentsForRequest(detail.requestId);
  const slotsUsed = attachments.filter(
    (a) => a.deletedAt === null && holdsAttachmentSlot(a.status)
  ).length;
  const group = permissions.canAttach ? await getGroup(detail.groupId) : undefined;
  const uploadsAvailable = group ? await isAttachmentUploadAvailable(group.organizationId) : false;
  const open =
    permissions.canAttach &&
    uploadsAvailable &&
    slotsUsed < MAX_ATTACHMENTS_PER_REQUEST &&
    !(await isRequestPastRetention(detail.requestId));
  return {
    attachments,
    canAttach: open,
    canDeleteAnyAttachment: permissions.canDeleteAnyAttachment,
  };
};

/**
 * One request with its full audit trail — who asked, who decided, who
 * cancelled — plus the actions this caller is allowed to take on it.
 */
export const handleGetVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = z.uuid().parse(req.params.id);

  const detail = await getVacationDetailById(vacationId);

  if (!detail) {
    throw new AppError({
      code: 404,
      message: "Vacation not found",
      context: { userId: auth.userId, vacationId },
    });
  }

  const permissions = await resolveVacationPermissions(auth.userId, detail);

  if (!permissions.canView) {
    throw new AppError({
      code: 403,
      message: "You are not allowed to view this vacation",
      logging: true,
      context: { userId: auth.userId, vacationId },
    });
  }

  const history = await getVacationEvents(vacationId);

  // Absent, not empty, for a view-only member: they may see the day, not the file.
  const attachmentFields = permissions.canViewAttachments
    ? await attachmentsFor(detail, permissions)
    : {};

  return res.status(200).json({
    ...detail,
    canApprove: permissions.canApprove,
    canCancel: permissions.canCancel,
    canEdit: permissions.canEdit,
    history,
    ...attachmentFields,
  });
};
