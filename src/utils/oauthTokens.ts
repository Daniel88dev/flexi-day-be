import type { AuthContext } from "better-auth";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { auth } from "./auth.js";

// better-auth types `$context` against this config's own adapter, which its
// token helpers do not accept, though it is the same object at runtime.
const authContext = async () => (await auth.$context) as unknown as AuthContext;

/** How better-auth itself writes an access or refresh token to the `account` row. */
export const encryptOAuthToken = async (token: string): Promise<string> =>
  (await setTokenUtil(token, await authContext())) as string;

/** Reads a stored token back, whether it was written encrypted or before encryption went on. */
export const decryptStoredOAuthToken = async (stored: string): Promise<string> =>
  decryptOAuthToken(stored, await authContext());
