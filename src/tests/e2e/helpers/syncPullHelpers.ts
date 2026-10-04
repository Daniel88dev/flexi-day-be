import { expect } from "vitest";

export const expectFirstOnlyOnPageOne = (pages: { first: boolean }[]): void => {
  expect(pages.map((page) => page.first)).toEqual(pages.map((_, index) => index === 0));
};
