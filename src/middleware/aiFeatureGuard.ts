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
 * - `{ organizationId }`: read it from the request, or resolve it; a request that names none is refused.
 * - `"caller"`: a session route with no organization in it; any of the caller's organizations counts.
 * - `"public"`: a route outside session auth; open while anyone is on the preview list.
 */
export type AiFeatureScope =
  | { organizationId: (req: Request) => string | undefined | Promise<string | undefined> }
  | "caller"
  | "public";

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
 * not exist. A list of features opens the route while any of them is
 * available. `"caller"` and organization scopes run after `authSession`.
 */
export const requireAiFeature =
  (feature: AiFeature | readonly AiFeature[], scope: AiFeatureScope) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    const features: readonly AiFeature[] = typeof feature === "string" ? [feature] : feature;
    try {
      if (!features.some(isAiFeatureReachable)) return next(notFound());
      if (scope === "public") return next();
      if (scope === "caller") {
        const userId = req.auth?.userId;
        const available = userId
          ? await Promise.all(features.map((one) => isAiFeatureAvailableToUser(one, userId)))
          : [];
        return next(available.some(Boolean) ? undefined : notFound());
      }
      const organizationId = await scope.organizationId(req);
      return next(
        organizationId && features.some((one) => isAiFeatureAvailable(one, organizationId))
          ? undefined
          : notFound()
      );
    } catch (err) {
      return next(err);
    }
  };
