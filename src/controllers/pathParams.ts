import AppError from "../utils/appError.js";

/** A path parameter Express typed as optional but the route cannot match without. */
export const requirePathParam = (value: string | undefined, what: string): string => {
  if (value) return value;
  throw new AppError({ message: `A ${what} is required`, logging: false, code: 422 });
};
