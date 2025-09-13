import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { logger } from "./logger.js";

export const bodyValidationMiddleware =
  <T>(schema: z.ZodType<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (result.success) {
      req.body = result.data;
      return next();
    }
    const errorMessages = result.error.issues.map((issue) => ({
      message: `${issue.path.length ? issue.path.join(".") : "(root)"}: ${
        issue.message
      }`,
    }));
    logger.error("bodyValidationMiddleware Error", {
      req: req.path,
      errors: errorMessages,
    });
    return res
      .status(422)
      .json({ error: "Invalid data", details: errorMessages });
  };
