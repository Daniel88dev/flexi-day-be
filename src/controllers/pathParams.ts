import AppError from "../utils/appError.js";

/**
 * A path parameter Express typed as optional but the route cannot match without. Express 5 types
 * every parameter as possibly a wildcard's segment list, which is no usable id either.
 */
export const requirePathParam = (value: string | string[] | undefined, what: string): string => {
  if (typeof value === "string" && value) return value;
  throw new AppError({ message: `A ${what} is required`, logging: false, code: 422 });
};
