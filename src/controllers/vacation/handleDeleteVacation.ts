import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handleDeleteVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(
      vacationId,
      tx
    );

    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    if (vacationData.userId !== auth.userId) {
      const groupUser = await services.groupUser.getGroupUser(
        auth.userId,
        vacationData.groupId,
        tx
      );
      if (!groupUser || !groupUser.adminAccess) {
        throw new AppError({
          code: 403,
          message: "You are not allowed to cancel this vacation",
          logging: true,
          context: { auth, vacationId },
        });
      }
    }

    const deleted = await services.vacation.deleteVacation(vacationId, tx);
    if (!deleted) {
      throw new AppError({
        code: 500,
        message: "Failed to cancel vacation",
        logging: true,
        context: { auth, vacationId },
      });
    }
  });

  return res.status(200).json({ message: "Vacation cancelled" });
};
