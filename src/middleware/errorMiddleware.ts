import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { CustomError } from "../utils/appError.js";
import { logger } from "./logger.js";

export const errorMiddleware = (err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof CustomError) {
    const { statusCode, errors, logging } = err;
    const safeStatus =
      Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
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

    // Only `publicContext` is forwarded to the client. The internal `context`
    // field (which may carry auth/PII) stays in logs above and is dropped here.
    const clientErrors =
      Array.isArray(errors) && errors.length
        ? errors.map((e) => {
            const hasPublic = e.publicContext && Object.keys(e.publicContext).length > 0;
            return hasPublic
              ? { message: e.message, context: e.publicContext }
              : { message: e.message };
          })
        : [{ message: err.message }];

    return res.status(safeStatus).json({ errors: clientErrors });
  }

  // Controllers validate path params and query strings by calling `.parse()`
  // straight in the handler, so a malformed one arrives here as a ZodError.
  // That is bad input, not a server fault — answer 422 like
  // `bodyValidationMiddleware` does rather than letting it fall through to 500.
  if (err instanceof ZodError) {
    const clientErrors = err.issues.map((issue) => ({
      message: `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    }));
    logger.warn({ msg: "Request validation Error", errors: clientErrors });
    return res.status(422).json({ errors: clientErrors });
  }

  logger.error({ msg: "Unhandled Error", err: err, stack: err.stack });
  return res.status(500).json({ errors: [{ message: "Internal Server Error" }] });
};
