// Attacker-controlled and headed for logs, Sentry and session rows: each value
// is matched whole against a bounded pattern and dropped entirely otherwise.
export const CLIENT_HEADERS = {
  sessionId: "x-client-session-id",
  deviceId: "x-client-device-id",
  platform: "x-client-platform",
  appVersion: "x-client-app-version",
} as const;

const CLIENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wider than a UUID so a 44-character base64 key id passes: the phone mints its
// own device id and is not bound to the shape the frontend uses.
const CLIENT_DEVICE_ID_PATTERN = /^[A-Za-z0-9+/=_.:-]{8,128}$/;

const CLIENT_APP_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;

export const CLIENT_PLATFORMS = ["ios", "android"] as const;

export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/** What a request from the phone app carries. Absent on every web request. */
export type NativeClient = {
  deviceId: string;
  platform: ClientPlatform | null;
  appVersion: string | null;
};

/** Structurally a `Headers`, which is what a better-auth hook context holds. */
type HeaderSource = { get: (name: string) => string | null | undefined };

export const acceptClientSessionId = (value: string | null | undefined): string | undefined =>
  value && CLIENT_SESSION_ID_PATTERN.test(value) ? value : undefined;

export const acceptClientDeviceId = (value: string | null | undefined): string | undefined =>
  value && CLIENT_DEVICE_ID_PATTERN.test(value) ? value : undefined;

export const acceptClientPlatform = (
  value: string | null | undefined
): ClientPlatform | undefined =>
  value && (CLIENT_PLATFORMS as readonly string[]).includes(value)
    ? (value as ClientPlatform)
    : undefined;

export const acceptClientAppVersion = (value: string | null | undefined): string | undefined =>
  value && CLIENT_APP_VERSION_PATTERN.test(value) ? value : undefined;

/**
 * The single definition of "native": a request is from the phone app when, and
 * only when, it carries a well-formed device id. Platform and app version ride
 * along best-effort and each falls to null on its own.
 */
export const readNativeClient = (headers: HeaderSource | null | undefined): NativeClient | null => {
  const deviceId = acceptClientDeviceId(headers?.get(CLIENT_HEADERS.deviceId));
  if (!deviceId) return null;

  return {
    deviceId,
    platform: acceptClientPlatform(headers?.get(CLIENT_HEADERS.platform)) ?? null,
    appVersion: acceptClientAppVersion(headers?.get(CLIENT_HEADERS.appVersion)) ?? null,
  };
};
