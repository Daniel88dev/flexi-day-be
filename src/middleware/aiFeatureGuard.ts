import type { NextFunction, Request, Response } from "express";
import {
  isAiFeatureAvailable,
  isAiFeatureAvailableToUser,
  isAiFeatureReachable,
  type AiFeature,
} from "../services/aiFeatures/aiFeatureServices.js";
import AppError from "../utils/appError.js";

/**
 * How a guarded route names the organization it serves:
 * - `{ organizationId }`: read it from the request; a request that names none is refused.
 * - `"caller"`: a session route with no organization in it; any of the caller's organizations counts.
 * - `"public"`: a route outside session auth; open while anyone is on the preview list.
 */
export type AiFeatureScope =
  { organizationId: (req: Request) => string | undefined } | "caller" | "public";

/** Reads the organization id from a path parameter, for `{ organizationId: organizationIdParam("organizationId") }`. */
export const organizationIdParam =
  (name: string) =>
  (req: Request): string | undefined => {
    const value = req.params[name];
    return typeof value === "string" ? value : undefined;
  };

const notFound = () => new AppError({ message: "Not found", code: 404 });

/**
 * Answers 404 while the feature is unavailable, the same as a route that does
 * not exist. `"caller"` and organization scopes run after `authSession`.
 */
export const requireAiFeature =
  (feature: AiFeature, scope: AiFeatureScope) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (scope === "public") {
        return next(isAiFeatureReachable(feature) ? undefined : notFound());
      }
      if (scope === "caller") {
        const userId = req.auth?.userId;
        const available = userId ? await isAiFeatureAvailableToUser(feature, userId) : false;
        return next(available ? undefined : notFound());
      }
      const organizationId = scope.organizationId(req);
      return next(
        organizationId && isAiFeatureAvailable(feature, organizationId) ? undefined : notFound()
      );
    } catch (err) {
      return next(err);
    }
  };
