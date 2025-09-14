import { v4 as uuid4 } from "uuid";

type UUID = string;

/**
 * Generates a random universally unique identifier (UUID) using the UUID version 4 algorithm.
 *
 * @function
 * @returns {UUID} A string representation of a new UUID version 4.
 */
export const generateRandomUUID = (): UUID => uuid4();
