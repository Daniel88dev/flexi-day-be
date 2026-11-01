import type { Request, Response } from "express";
import { getGroupDetailForSupport } from "../../services/support/supportServices.js";
import AppError from "../../utils/appError.js";
import { requirePathParam } from "../pathParams.js";

export const handleGetGroupDetail = async (req: Request, res: Response) => {
  const groupId = requirePathParam(req.params.groupId, "group id");
  const detail = await getGroupDetailForSupport(groupId);

  if (!detail) {
    throw new AppError({
      message: "Group not found",
      code: 404,
      logging: true,
      context: { groupId },
    });
  }

  return res.status(200).json(detail);
};
