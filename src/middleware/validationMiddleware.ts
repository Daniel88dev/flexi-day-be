import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { logger } from "./logger.js";

/**
 * Middleware function to validate and process the request body using a provided Zod schema.
 *
 * @param {z.ZodType<T>} schema - The Zod schema used to validate the request body.
 * @returns {(req: Request, res: Response, next: NextFunction) => void} A middleware function.
 *
 * The middleware parses the request body according to the supplied schema. If the validation
 * is successful, it replaces `req.body` with the parsed data and calls `next()` to proceed
 * to the next middleware or route handler. If the validation fails, it logs the errors and
 * sends a 422 Unprocessable Entity response containing error details.
 *
 * Error structure returned in the response:
 * - `error`: A string description of the error ("Invalid data").
 * - `details`: Array of objects containing validation issues:
 *   - `message`: A string message detailing the issue, including the path and the error description.
 *
 * Log Structure:
 * - Message: "bodyValidationMiddleware Error"
 * - Properties:
 *   - `req`: Request path where the error occurred.
 *   - `errors`: Array of validation error messages.
 *
 * @template T - The type of the data expected in the request body.
 */
export const bodyValidationMiddleware =
  <T>(
    schema: z.ZodType<T>
  ): ((req: Request, res: Response, next: NextFunction) => void) =>
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
