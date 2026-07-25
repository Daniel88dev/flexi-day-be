// Enum values as a non-empty tuple, the shape drizzle's pgEnum requires.
export const enumToPgEnum = <T extends Record<string, string>>(
  myEnum: T
): [T[keyof T], ...T[keyof T][]] => {
  const values = Object.values(myEnum) as T[keyof T][];
  const [first, ...rest] = values;
  if (!first) {
    throw new Error("Enum must have at least one value");
  }
  return [first, ...rest];
};
