import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { resolveVacationPermissions } from "../../services/vacation/vacationPermissions.js";

const services = createDBServices();

/**
 * One request with its full audit trail — who asked, who decided, who
 * cancelled — plus the actions this caller is allowed to take on it.
 */
export const handleGetVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = z.uuid().parse(req.params.id);

  const detail = await services.vacation.getVacationDetailById(vacationId);

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

  const history = await services.vacationEvent.getVacationEvents(vacationId);

  return res.status(200).json({
    ...detail,
    canApprove: permissions.canApprove,
    canCancel: permissions.canCancel,
    canEdit: permissions.canEdit,
    history,
  });
};
