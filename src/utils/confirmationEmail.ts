import { AsyncLocalStorage } from "node:async_hooks";

const suppressed = new AsyncLocalStorage<true>();

/**
 * Runs `fn` with the sign-up confirmation email switched off. The switch lives
 * in async context rather than on the request, so no client can flip it.
 */
export const withoutConfirmationEmail = <T>(fn: () => Promise<T>): Promise<T> =>
  suppressed.run(true, fn);

export const confirmationEmailSuppressed = (): boolean => suppressed.getStore() === true;
