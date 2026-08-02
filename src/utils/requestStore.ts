import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  clientSessionId?: string;
  clientDeviceId?: string;
  method: string;
  /** Redacted — the calendar feed carries its token here. */
  path: string;
  /** Redacted, flattened `key=value&…`. */
  query?: string;
  userAgent?: string;
  userId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

export const updateRequestContext = (patch: Partial<RequestContext>): void => {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
};
