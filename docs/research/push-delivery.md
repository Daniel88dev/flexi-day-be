# Push delivery to the iPhone app

Research for fenro task T-24 (map T-22), gathered 2026-09-26. The question: should `flexi-day-be`
send push notifications to `flexi-day-rn` through Expo's push service or straight to APNs?

## Recommendation

Send straight to APNs. The app is iPhone-only, both paths need the same Apple key, and the direct
path drops a third party, an Expo account and a delayed receipt check that App Runner is poorly
suited to. The reasons are spelled out under [Comparison](#comparison).

Either path is blocked on one thing the user has to do: join the paid Apple Developer Program. The
free personal team the phone app signs with today cannot use push at all.

## Blocker: the free team has no push

- Apple's capability table lists Push notifications for the paid Apple Developer Program and the
  Enterprise Program, and not for a free Apple Account
  ([Supported capabilities (iOS)](https://developer.apple.com/help/account/reference/supported-capabilities-ios)).
- Expo's setup guide says the same for its path: "A paid Apple Developer Account is required to
  generate credentials"
  ([Expo push setup](https://github.com/expo/expo/blob/main/docs/pages/push-notifications/push-notifications-setup.mdx)).
- The program costs 99 USD a year and individuals can enroll with a two-factor Apple Account
  ([Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment)).
- `expo-notifications`' config plugin writes the `aps-environment` entitlement (default
  `development`) into the generated project
  ([plugin source](https://github.com/expo/expo/blob/main/packages/expo-notifications/plugin/src/withNotificationsIOS.ts)).
  Once the plugin is in `app.json`, a device build signed by the free personal team should fail
  provisioning. Adding the plugin therefore waits for enrollment, or goes in with the team switch.

Not verified here: whether the team id changes when the existing Apple ID enrolls. `app.json`
`ios.appleTeamId` must match the team that owns the push-enabled App ID.

## Client side: tokens without EAS

- `expo-notifications` works without EAS Build; a local build is fine
  ([Expo push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/)). Push
  does not work in Expo Go from SDK 53, so a development build is required, which this project
  already uses ([Expo push FAQ](https://docs.expo.dev/push-notifications/faq/)).
- Direct APNs: `getDevicePushTokenAsync()` returns the native APNs token
  ([Send with FCM and APNs](https://docs.expo.dev/push-notifications/sending-notifications-custom/)).
  `addPushTokenListener()` fires when the token changes while the app runs
  ([Notifications API](https://docs.expo.dev/versions/latest/sdk/notifications/)).
- Expo path: `getExpoPushTokenAsync()` needs an EAS `projectId` and throws
  `ERR_NOTIFICATIONS_NO_EXPERIENCE_ID` without one. It posts the native token, bundle id, project
  id and a `development` flag to Expo's servers, then keeps that mapping updated on its own
  ([source](https://github.com/expo/expo/blob/main/packages/expo-notifications/src/getExpoPushTokenAsync.ts)).
  The project id comes from `npx eas init` writing `extra.eas.projectId`; this needs a (free)
  Expo account but no EAS Build.
- Sandbox vs production: a dev client carries `aps-environment` `development`, so its tokens belong
  to the APNs sandbox. Xcode switches the entitlement to `production` for a distribution build
  ([Notifications API](https://docs.expo.dev/versions/latest/sdk/notifications/)). The Expo SDK
  reads this itself; the direct path must record the environment with each token and send to the
  matching host.
- Simulator: since Xcode 14, a simulator on macOS 13+ with Apple silicon or T2 registers with the
  APNs sandbox and receives real remote notifications. Tokens are per simulator and Mac, and may be
  longer than device tokens. `xcrun simctl push` and `.apns` files simulate a push locally without
  any server
  ([Xcode 14 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes)).
  `simctl push` can exercise the app's notification handling before enrollment.

## Credentials

| Path | Needs                                                                                                                                                                                                                                                                                                                                      | Where it lives                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| APNs | `.p8` signing key, 10-char Key ID, 10-char Team ID, bundle id as `apns-topic` ([token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns))                                                                                                                        | `.p8` as a Secrets Manager secret, Key ID and Team ID as plain env vars, per `docs/terraform.md` |
| Expo | Same `.p8` uploaded to Expo with `eas credentials` (iOS, Push Notifications) ([Expo push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/)); EAS project id in `app.json`; optional access token when "enhanced push security" is on ([sending](https://docs.expo.dev/push-notifications/sending-notifications/)) | `.p8` on Expo's servers; access token as a Secrets Manager secret                                |

Key facts from Apple:

- Only the Account Holder or an Admin can create a key, and the `.p8` downloads once
  ([Create a private key](https://developer.apple.com/help/account/keys/create-a-private-key/)).
- Team-scoped keys are now tied to Sandbox or Production, at most two per environment. Keys that
  already cover both keep working, but Apple recommends one per environment
  ([token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)).
  A dev client needs a Sandbox key; TestFlight or App Store builds need a Production key.
- The JWT is ES256 with `kid` and `iss`, must be under an hour old, and may be refreshed at most
  once every 20 minutes on a connection (`TooManyProviderTokenUpdates` otherwise).

## Token lifecycle and dead tokens

- APNs issues a new token after a restore from backup, on a new device, or after an OS reinstall,
  and Apple says not to cache it: ask the system each launch and forward it to the server
  ([Registering with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)).
  A user can have several devices, so the server stores many tokens per user.
- Direct APNs reports a dead token in the response to the send itself: `410` with `Unregistered`
  or `ExpiredToken`, plus a `timestamp` of when the token went invalid. Apple lists
  `BadDeviceToken`, `DeviceTokenNotForTopic`, `Forbidden`, `ExpiredToken`, `Unregistered` and
  `PayloadTooLarge` as never to be retried. `5xx` may be retried after 15 minutes with backoff
  ([Handling responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)).
- Expo push token: stable across upgrades and iOS reinstalls, never expires, changes only if the
  application id or experience id changes. A dead one shows as `DeviceNotRegistered`
  ([Expo push FAQ](https://docs.expo.dev/push-notifications/faq/)). The send returns tickets only;
  delivery errors, `DeviceNotRegistered` included, arrive in receipts. Expo advises checking
  receipts about 15 minutes after sending, and clears them after 24 hours
  ([sending](https://docs.expo.dev/push-notifications/sending-notifications/)).

## Sending from Node

- Expo: [`expo-server-sdk`](https://github.com/expo/expo-server-sdk-node) 7.2.0 (2026-08-24), ESM,
  Node `>=22.12`. Chunks sends to 100 messages and receipt lookups to 300 ids, caps concurrent
  requests at 6, retries 429s twice, gzips large bodies
  ([source](https://github.com/expo/expo-server-sdk-node/blob/main/src/ExpoClient.ts)). The service
  allows 600 notifications per second per project and 4096 bytes per message
  ([sending](https://docs.expo.dev/push-notifications/sending-notifications/)).
- APNs: [`@parse/node-apn`](https://github.com/parse-community/node-apn) 8.1.0 (2026-04-12),
  CommonJS, Node 20, 22 or 24. Token auth via `key`, `keyId`, `teamId`; a `production` flag picks
  the host; keeps long-lived HTTP/2 connections and resends on failure; reports failures with the
  status and `reason`. The alternative is `node:http2` plus an ES256 JWT, which the Expo guide
  outlines in a few lines
  ([Send with FCM and APNs](https://docs.expo.dev/push-notifications/sending-notifications-custom/)).
- APNs protocol: HTTP/2 over TLS 1.2+ to `api.push.apple.com` or `api.sandbox.push.apple.com`,
  port 443 or 2197, `POST /3/device/<token>`, uncompressed JSON payload up to 4096 bytes
  ([Sending requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)).
  Apple's older guide asks providers to keep connections open rather than open and close them
  rapidly, but calls a new connection per send acceptable when the provider sends rarely
  ([Communicating with APNs, archived](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html)).
- Volume here is low (request decided, request waiting, session auto-closed, maybe clock
  reminders), so neither path's rate limits matter.

## Privacy and cost

- Expo's push service is free
  ([Expo push FAQ](https://docs.expo.dev/push-notifications/faq/)). APNs is free with the program
  membership.
- Expo says it keeps notification contents only as long as delivery to Apple or Google takes, and
  that its staff may see contents while debugging the service
  ([Expo push FAQ](https://docs.expo.dev/push-notifications/faq/)). Payloads naming people and
  their days off would pass through Expo as a third party on top of Apple. The direct path
  involves Apple only.

## App Runner

- Outbound HTTP/2 is not a problem: the service uses App Runner's default public egress, no VPC
  connector (`terraform/apprunner.tf`).
- App Runner keeps no state beyond a single request and throttles CPU on idle instances
  ([Developing for App Runner](https://docs.aws.amazon.com/apprunner/latest/dg/develop.html),
  [Auto scaling](https://docs.aws.amazon.com/apprunner/latest/dg/manage-autoscaling.html)).
  Sends should therefore complete inside the request that triggers them. That fits event-driven
  sending, and it fits APNs better than Expo: APNs answers with the dead-token result in the same
  response, while Expo's receipts come 15 minutes later and would need a stored check that some
  later request or job picks up.
- A long-lived APNs connection may not outlive an idle, throttled instance; the client has to
  reconnect on demand, which `@parse/node-apn` does.
- The App Runner developer guide now states the service is closed to new customers; existing
  services keep running. Nothing in this decision depends on it.

## Comparison

| Concern                   | Expo push service                                  | APNs direct                                           |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Paid Apple program        | Required                                           | Required                                              |
| EAS Build                 | Not required                                       | Not required                                          |
| Extra accounts            | Expo account, EAS project id, key uploaded to Expo | None                                                  |
| Secrets in AWS            | Expo access token (optional)                       | `.p8`                                                 |
| Dead-token signal         | Receipt, about 15 min later                        | Same response (`410`)                                 |
| Native token rotation     | Handled by Expo; Expo token stays stable           | App re-sends token each launch and on listener events |
| Sandbox vs production     | Handled by the SDK                                 | Store environment per token, pick the host            |
| Third party sees payloads | Yes                                                | No                                                    |
| Android later             | Same API covers FCM                                | Would need an FCM sender too                          |

Expo's one clear advantage is a single API for a future Android app. Android is out of scope for
now, and adding an FCM sender later is a bounded job.

## Steps only the user can do

1. Enroll in the Apple Developer Program (99 USD a year).
2. Confirm the team id after enrollment and update `ios.appleTeamId` in `flexi-day-rn/app.json` if
   it changed.
3. Register the App ID `com.flexiday.app` under the paid team with Push Notifications enabled.
   Xcode's automatic signing can do this on the next device build.
4. Create an APNs key (Account Holder or Admin), Sandbox first, and download the `.p8`. It
   downloads once. Note the Key ID.
5. Hand the `.p8` to Terraform as a `TF_VAR_*` secret and run `terraform apply`.

## Open points

- Whether the bundle id `com.flexiday.app` is free to register under the paid team.
- Whether simulator builds keep signing with the entitlement before enrollment; device builds
  will not.
