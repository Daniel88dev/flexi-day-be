import AppError from "./appError.js";

export type DateString = string;

export const formatDateToISOString = (date: Date): DateString => {
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      message: "Invalid date",
      logging: true,
      context: { input: String(date) },
    });
  }
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const formatStartAndEndDate = (
  year: number,
  month: number
): { startDate: DateString; endDate: DateString } => {
  if (month < 1 || month > 12) {
    throw new AppError({
      message: "month must be between 1 and 12",
      logging: true,
      context: { month: month, year: year },
    });
  }
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1));

  return {
    startDate: formatDateToISOString(startDate),
    endDate: formatDateToISOString(endDate),
  };
};
