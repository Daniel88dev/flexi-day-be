import type { Request } from "express";

// The route template (`/api/vacation/:id`), so failures group by endpoint
// instead of fanning out per id. Only populated once Express has matched.
export const routeOf = (req: Request): string | undefined => {
  const route = (req as { route?: { path?: unknown } }).route?.path;
  return typeof route === "string" ? `${req.baseUrl}${route}` : undefined;
};
