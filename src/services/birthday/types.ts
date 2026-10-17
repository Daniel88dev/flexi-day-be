import { z } from "zod";

/** `publicContext.code` beside `reason: "PLAN_LIMIT"` when sharing needs a paid group. */
export const BIRTHDAY_SHARE_PLAN_REQUIRED = "BIRTHDAY_SHARE_PLAN_REQUIRED";

export const EARLIEST_BIRTH_YEAR = 1900;

/** 29 February counts, whatever the year: the birthday shows on 28 February in other years. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export const validatePutBirthday = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    year: z
      .number()
      .int()
      .min(EARLIEST_BIRTH_YEAR)
      .refine((year) => year <= new Date().getUTCFullYear(), {
        message: "The year cannot be in the future",
      })
      .nullable()
      .default(null),
    shared: z.boolean(),
  })
  .refine((body) => body.day <= DAYS_IN_MONTH[body.month - 1]!, {
    message: "That month has no such day",
    path: ["day"],
  });

export type PutBirthdayBody = z.infer<typeof validatePutBirthday>;

export type BirthdayRecord = {
  userId: string;
  month: number | null;
  day: number | null;
  year: number | null;
  shared: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** A live birthday: month and day are set. */
export type Birthday = Omit<BirthdayRecord, "month" | "day" | "deletedAt"> & {
  month: number;
  day: number;
};

export type ShareGroup = { groupId: string; groupName: string };

export type BirthdaySettings = {
  birthday: { month: number; day: number; year: number | null; shared: boolean } | null;
  canShare: boolean;
  shareGroups: ShareGroup[];
};
