import type { NextFunction, Request, Response } from "express";
import { CustomError } from "../utils/appError.js";
import { logger } from "./logger.js";

/**
 * Middleware function for handling errors in an Express application.
 * This middleware intercepts errors, logs them, and sends appropriate HTTP responses based on their type.
 *
 * @param {Error} err - The error object that was thrown or passed in the middleware chain.
 * @param {Request} _req - The Express request object (unused in this function).
 * @param {Response} res - The Express response object used to send the HTTP response.
 * @param {NextFunction} next - The next middleware function in the middleware chain.
 *
 * - If the response headers have already been sent, the error is passed to the next function.
 * - If the error is an instance of `CustomError`, it extracts relevant information such as
 *   status code, error messages, and logging preference. Controlled errors will be logged and
 *   sent as a JSON response based on the status code.
 * - Logs critical `CustomError` instances as errors and less critical ones as warnings.
 * - Unhandled errors are logged as critical errors and a generic 500 Internal Server Error
 *   response is returned to the client.
 */
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
    const safeStatus =
      Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
        ? statusCode
        : 500;
    if (logging) {
      const meta = {
        msg: "Controlled Error",
        code: statusCode,
        errors: errors,
        stack: err.stack,
      };
      if (safeStatus >= 500) {
        logger.error(meta);
      } else {
        logger.warn(meta);
      }
    }

    const clientErrors =
      Array.isArray(errors) && errors.length
        ? errors.map((e) => ({ message: e.message }))
        : [{ message: err.message }];

    return res.status(safeStatus).json({ errors: clientErrors });
  }

  logger.error({ msg: "Unhandled Error", err: err, stack: err.stack });
  return res
    .status(500)
    .json({ errors: [{ message: "Internal Server Error" }] });
};
