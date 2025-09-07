import { Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";

export const validationMiddleware =
  (schema: z.ZodTypeAny) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues.map((issue) => ({
          message: `${issue.path.join(".")} is ${issue.message}`,
        }));
        return res
          .status(400)
          .json({ error: "Invalid data", details: errorMessages });
      } else {
        return res.status(500).json({ error: "Internal Server Error" });
      }
    }
  };
