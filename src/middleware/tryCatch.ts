import type { RequestHandler, Request, NextFunction, Response } from "express";

export const tryCatch =
  (callback: RequestHandler) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await callback(req, res, next);
    } catch (err) {
      next(err);
    }
  };
