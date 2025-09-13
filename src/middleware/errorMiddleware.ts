import type { NextFunction, Request, Response } from "express";
import { CustomError } from "../utils/appError.js";
import { logger } from "./logger.js";

export const errorMiddleware = (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof CustomError) {
    const { statusCode, errors, logging } = err;
    if (logging) {
      logger.error({
        msg: "Controlled Error",
        code: statusCode,
        errors: errors,
        stack: err.stack,
      });
    }

    return res.status(statusCode).json({ errors });
  }

  logger.error({ msg: "Unhandled Error", err: err, stack: err.stack });
  return res
    .status(500)
    .json({ errors: [{ message: "Internal Server Error" }] });
};
