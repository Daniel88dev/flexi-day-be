import { describe, expect, it } from "vitest";
import { contentDisposition } from "../contentDisposition.js";

describe("contentDisposition", () => {
  it("carries an ASCII fallback and the UTF-8 form of the name", () => {
    expect(contentDisposition("inline", "příloha.jpg")).toBe(
      `inline; filename="p__loha.jpg"; filename*=UTF-8''p%C5%99%C3%ADloha.jpg`
    );
  });

  it("escapes quotes in the fallback and RFC 8187's reserved marks in the UTF-8 form", () => {
    expect(contentDisposition("attachment", `doctor's "note" (1)*.pdf`)).toBe(
      `attachment; filename="doctor's _note_ (1)*.pdf"; filename*=UTF-8''doctor%27s%20%22note%22%20%281%29%2A.pdf`
    );
  });
});
