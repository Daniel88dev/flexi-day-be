# Account deletion

The rules behind the **Account deletion** row in [`GLOSSARY.md`](../GLOSSARY.md). A signed-in user
deletes their own account through two routes in `src/routes/usersRouter.ts`, with the work in
`src/services/accountDeletion/`. Both accept a web cookie or a Native session.

- `GET /api/users/me/deletion` answers `{ canDelete, blockers, confirmation }`, so a client can show
  the blockers and the right prompt before asking for anything.
- `POST /api/users/me/delete` with `{ password? }` deletes the account and answers 204, or refuses
  and changes nothing.

better-auth's own `deleteUser` stays disabled: its hooks cannot share a transaction with the cleanup
below. The `deleteUser` in `userServices.ts` is a different thing, the cleanup of a failed sign-up
with invite, and is not this flow.

## Confirmation

| Account                                          | `confirmation`   | What the delete needs                      | Refusal                |
| ------------------------------------------------ | ---------------- | ------------------------------------------ | ---------------------- |
| Has an email-and-password (`credential`) account | `password`       | The current password in the body           | 403 `PASSWORD_INVALID` |
| Google, Microsoft or Apple only, no password     | `recent-sign-in` | A session created within the last 24 hours | 403 `REAUTH_REQUIRED`  |

The password is checked with better-auth's own hasher against the stored credential hash. A
password user always needs the password, however new the session. 24 hours is better-auth's default
fresh-session age, which this config does not change. A refused attempt is a signed-in request,
so `apiLimiter` bounds it (see the Rate limiting section of [`invariants.md`](invariants.md)).
There is no email step and no second factor beyond what sign-in already asked for.

## Blockers

Any blocker makes the delete answer 409 with `reason: DELETION_BLOCKED` and the full `blockers`
list in `errors[0].context`, the same list the status route returns.

| `kind`                     | When                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GROUP_HAS_MEMBERS`        | The user manages a live group in which another user has a live membership                            |
| `ORGANIZATION_HAS_MEMBERS` | The user owns an organization in which another user has an open Employment                           |
| `SUBSCRIPTION_RENEWING`    | An organization the user owns has a Paddle subscription that is not `canceled` and has no `cancelAt` |
| `SUPPORT_ADMIN`            | The user is in `SUPPORT_ADMIN_USER_IDS`, or was and still has `support_access` rows                  |

The way out of a renewing subscription is the Paddle customer portal: the owner schedules the
cancellation, the webhook records `cancelAt`, and the owner gives up the rest of the paid period.
The backend never cancels a subscription. A Paddle event that arrives for the organization after
the deletion resolves no organization, so it is acknowledged and ignored.

Support admins cannot delete themselves, so the `support_access` trail survives. A former support
admin, removed from the allowlist, still has that trail, and the rows alone keep the blocker on.

Transferring a group or an organization to someone else does not exist yet, so a blocked manager or
owner has to remove the other people first.

## What goes and what stays

One transaction, all or nothing. It locks every organization the user owns or manages a group in, in
id order, then the user row, and checks the blockers again under those locks. Every join, invite
redemption and admin grant takes the same organization lock, so somebody who joins between the
status check and the delete still blocks it.

Goes:

- The user and everything that cascades from them: vacation rows and their events, quotas,
  `changes` rows about them, group memberships and mirrors, delegated org-admin grants, every
  Employment with its attendance sessions, breaks and events, notifications, calendar sync links,
  report exports, settings, every session (web and Native), provider accounts and two-factor. A
  hard delete, so the team loses that person's leave and attendance from its calendars, balances
  and reports.
- Every group the user manages, live or soft-deleted, with its data.
- Every organization the user owns, with all of its groups, its subscription row, attendance
  settings and whatever cascades from it, including former members' ended Employments and their
  attendance.
- Every attachment row owned by the user or held by an owned organization. Their stored objects are
  collected inside the transaction and removed after the commit through `deleteStoredBytes`, with
  the incoming and processed keys of an upload that never settled. A store failure is logged and the
  request still answers 204, because the account is already gone.
- Every Apple account link, revoked at Apple as well, so the user's Apple settings stop listing the
  app. See "Apple links" below.
- Every calendar connection, after the events it wrote are deleted from the user's calendar and
  its grant is revoked at Google. See "Calendar connections" below.

Stays:

- Main and temp approver slots the user held in someone else's group are cleared. The manager and
  members with approver access still approve, and nothing else about that group changes.
- `changes` rows the user wrote as the acting admin. The actor id is cleared and
  `changing_user_deleted` set in the same statement, so a NULL actor alone still means the quota
  rollover. The member changes report returns such an entry as `actor: null, actorDeleted: true`.
- Actor columns that already set NULL on delete: vacation approver, rejecter, canceller and creator,
  vacation event actor, attachment uploader and deleter, invite inviter, org-admin granter,
  attendance event changer and attendance settings changer. A NULL attendance event changer can mean
  the auto-close sweep or a deleted account; that ambiguity is accepted in the schema.

The response expires the session cookies, and every session row is gone with the user, so the old
web cookie and the old Native session both answer 401. Logs name the deleted account by id, never
by email. There is no grace period, no undo and no email afterwards. RDS backups keep the data for
their 7-day retention.

## Apple links

Apple asks an app that offers Sign in with Apple to revoke the user's tokens when the account goes.
The `account` rows cascade with the user, so the revocation reads them first and calls Apple last:

1. Before the transaction, `collectAppleRevocations` reads each Apple link's refresh token,
   decrypted, and the client it was issued to: the `aud` of the stored id token, decoded but not
   verified, or the Services ID when no id token is stored. A web link names the Services ID, a
   phone link the bundle id.
2. The transaction deletes the account as above.
3. After the commit, next to the attachment clean-up, `revokeAtApple` posts each token to
   `https://appleid.apple.com/auth/revoke` once, with `client_id` that client, a secret minted for
   it and `token_type_hint=refresh_token`.

Disconnecting Apple in Settings runs the same `revokeAtApple` once the unlink succeeds; see
[`social-sign-in.md`](social-sign-in.md#revocation-at-apple). The rules below hold for both. The
revocation is best effort, and never refuses a deletion or an unlink or changes its answer:

- A refused deletion revokes nothing. A wrong password or a stale session is refused before
  anything is collected, and a blocker throws out of the transaction before the revoke step. A
  refused unlink revokes nothing either.
- A link without a refresh token is logged as `apple.revoke.no_token` and skipped. That is a phone
  sign-in whose authorization follow-up never landed, and the user never signed in on the phone
  again to bring a new code. A stored token that does not decrypt is logged as
  `apple.revoke.unreadable_token` and skipped the same way.
- A revoke Apple refuses or that does not reach Apple is logged as `apple.revoke.rejected` or
  `apple.revoke.unreachable`, and the request still answers as it would have. So is a failure to
  read the links at all (`apple.revoke.collect_failed`), which revokes nothing. A revoke Apple
  accepts is logged as `apple.revoke.revoked`. Every line carries the user id and the link's row
  id, never the token.
- Each revoke is awaited inline with a ten-second timeout, so a slow Apple can delay a deletion or
  unlink answer by up to that per link.
- When Apple is not configured on the server, stored Apple tokens are not revoked and nothing is
  logged: there is no key to sign the request with.

Google and Microsoft sign-in links are not revoked.

## Calendar connections

A calendar connection's tokens and its sync ledger cascade with the user, and the ledger is the
only record of which events the app wrote. So this step runs before the transaction, not after the
commit like the Apple one:

1. After the confirmation passes, the handler checks the blockers once without locks. Any blocker
   skips the step, and the transaction then refuses the deletion as usual.
2. `disconnectAllProviders` runs `disconnectProvider` for each live connection, the same code as
   `DELETE /api/calendar-sync/connections/:provider` (see
   [`calendar-direct-sync.md`](calendar-direct-sync.md)). It deletes every written event at the
   provider, revokes the refresh token at Google, and deletes the connection row. Microsoft has no
   revoke endpoint.
3. The transaction deletes the account as above.

The step is best effort and never refuses a deletion or changes its answer:

- A refused deletion touches no calendar. A wrong password or a stale session is refused first,
  and a blocker found in step 1 skips the step. A blocker that appears between step 1 and the
  transaction, such as a member who joins in that window, still refuses the deletion, with the
  calendars already disconnected. The user can connect them again.
- An event whose delete keeps failing, or a purge without a usable token, follows the purge rules
  in `calendar-direct-sync.md`: the event stays in the user's calendar and the backend logs
  `calendar_sync.purge_incomplete` or `calendar_sync.purge_local_only`.
- A revoke Google refuses or that does not reach Google is logged as
  `calendar_connection.revoke_failed` with the connection id.
- A failure to read the connections is logged as `calendar_connection.collect_failed` and skips
  the step. A disconnect that throws is logged as `calendar_connection.disconnect_failed` and the
  next connection still runs. The rows cascade with the user either way.
- With a provider's switch off on the server, its events stay in the calendar and its token stays
  live at Google until it lapses, as with a disconnect.
- The purge and the revoke run inline, so a calendar with many written events delays the deletion
  answer the same way it delays a disconnect.

The `account deleted` log line counts the connections as `calendarConnections`.
