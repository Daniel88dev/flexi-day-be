/**
 * Converts a TypeScript enum object into a tuple of its values, ensuring
 * at least one value exists in the resulting tuple.
 *
 * @template T - Represents a record where keys are strings, and values are strings.
 * @param {T} myEnum - A TypeScript enum object where the values are strings.
 * @returns {[T[keyof T], ...T[keyof T][]]} A tuple containing all the values of the provided enum,
 * starting with the first value in the enum.
 * @throws {Error} If the provided enum has no values.
 */
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
