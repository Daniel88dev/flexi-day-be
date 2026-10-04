import { describe, expect, it } from "vitest";
import { auth } from "../../utils/auth.js";

describe("the Expo authorization proxy", () => {
  it("stays disabled", () => {
    // The proxy redirects to any https URL its query names, and no sign-in
    // goes through it: the phone posts its id token to /sign-in/social.
    expect(auth.options.disabledPaths).toContain("/expo-authorization-proxy");
  });
});
