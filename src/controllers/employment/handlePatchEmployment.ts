import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { presentEmployment } from "./utils.js";
import { db } from "../../db/db.js";
import AppError from "../../utils/appError.js";
import {
  getEmploymentById,
  setEmploymentRequiredMinutes,
} from "../../services/employment/employmentServices.js";
import { isOrganizationAdmin } from "../../services/organization/organizationServices.js";
import type { ValidatedPatchEmploymentType } from "../../services/employment/types.js";

/**
 * The per-person required-time override. An organization admin's to set and
 * nobody else's — a group admin reads their members' attendance but does not
 * decide what a contract owes, so the read matrix in `attendanceAccess` is
 * deliberately not the one that applies here.
 */
export const handlePatchEmployment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { requiredMinutesPerDay } = req.body as ValidatedPatchEmploymentType;
  const employmentId = req.params.employmentId;

  if (!employmentId) {
    throw new AppError({ message: "An employment id is required", logging: false, code: 422 });
  }

  const employment = await db.transaction(async (tx) => {
    const existing = await getEmploymentById(employmentId, tx);

    if (!existing) {
      throw new AppError({
        message: "Employment not found",
        logging: true,
        code: 404,
        context: { userId: auth.userId, employmentId },
      });
    }

    if (!(await isOrganizationAdmin(auth.userId, existing.organizationId, tx))) {
      throw new AppError({
        message: "No permission for related organization",
        logging: true,
        code: 403,
        context: { userId: auth.userId, organizationId: existing.organizationId, employmentId },
      });
    }

    return setEmploymentRequiredMinutes(employmentId, requiredMinutesPerDay, tx);
  });

  return res.status(200).json(presentEmployment(employment));
};
