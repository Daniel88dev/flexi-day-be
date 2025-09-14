import type { RequestHandler, Request, NextFunction, Response } from "express";

/**
 * A higher-order function that wraps an asynchronous middleware function
 * and provides error handling. The tryCatch function ensures that any errors
 * thrown during the execution of the provided middleware are passed to the
 * `next` function for proper error handling.
 *
 * @param {RequestHandler} callback - The middleware function to be wrapped.
 * It is expected to be asynchronous and follow the (req, res, next) signature.
 *
 * @returns {RequestHandler} A new middleware function that wraps the provided
 * callback and catches any errors, forwarding them to the `next` function.
 */
export const tryCatch =
  (callback: RequestHandler): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await callback(req, res, next);
    } catch (err) {
      next(err);
    }
  };
