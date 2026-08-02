import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { CustomError } from "../utils/appError.js";
import { logger } from "./logger.js";
import { routeOf } from "../utils/routeTemplate.js";
import { redactObject } from "../utils/redact.js";

export const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }

  // Everything else already rides along from the request context format.
  const requestMeta = { "http.route": routeOf(req) ?? req.path };

  if (err instanceof CustomError) {
    const { statusCode, errors, logging } = err;
    const safeStatus =
      Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
    if (logging) {
      // Message first, meta second — never one merged object: the Sentry winston
      // transport takes `message` as the log body, so an object renders as
      // "[object Object]" with nothing searchable.
      const meta = {
        code: statusCode,
        // `context` is internal but reaches Sentry from here, and the sign-up
        // and invite paths put the user's email in it — which would undo this
        // service's id-only rule for Sentry.
        errors: redactObject(errors),
        stack: err.stack,
        ...requestMeta,
      };
      if (safeStatus >= 500) {
        logger.error("Controlled Error", meta);
      } else {
        logger.warn("Controlled Error", meta);
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
    logger.warn("Request validation Error", { errors: clientErrors, ...requestMeta });
    return res.status(422).json({ errors: clientErrors });
  }

  logger.error("Unhandled Error", { err, ...requestMeta });
  return res.status(500).json({ errors: [{ message: "Internal Server Error" }] });
};
