import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";

const services = createDBServices();

const queryParams = z.object({
  year: z.coerce
    .number()
    .int()
    .min(2023)
    .max(2050)
    .default(() => new Date().getFullYear()),
  userId: z.uuid().optional(),
});

export const handleGetUserQuota = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  const { data: parsedParams, error: paramsError } = queryParams.safeParse(
    req.query
  );
  if (paramsError) {
    return res.status(400).json({ error: paramsError.message });
  }

  const result = await db.transaction(async (tx) => {
    const access = await services.groupUser.getGroupUser(
      auth.userId,
      groupId,
      tx
    );

    if (!access || !access.viewAccess) {
      throw new AppError({
        message: "No permission for related group",
        logging: true,
        code: 403,
        context: { url: req.url, user: auth.userId, data: parsedParams },
      });
    }

    return services.userYearQuotas.getUserYearGroupQuotas(
      parsedParams.year.toString(),
      groupId,
      parsedParams.userId ?? null,
      tx
    );
  });

  return res.status(200).json(result);
};
