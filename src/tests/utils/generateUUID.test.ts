import { v4 as uuid4 } from "uuid";

type UUID = string;

export const generateRandomUUID = (): UUID => uuid4();