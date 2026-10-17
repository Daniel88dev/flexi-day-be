# Push registrations belong to the Native session, not to a device table

Status: accepted. Amended 2026-10-17: a changed Better Auth secret, another session taking the
token, and `BadDeviceToken` from both hosts end a registration, and a rolling deploy can leave a
registration the boot check misses.

The iPhone app is getting push notifications, sent straight to APNs from this backend (researched
on fenro T-24, decided on T-30). The backend has to know, for each user, which phones to push to.
A phone hands over an APNs token and whether it is a sandbox or production token, and the question
is what that registration hangs off.

The obvious shape is a device table: one row per Device id and user, holding the token, with the
phone calling an unregister endpoint on sign-out. It fails in the cases that matter. A sign-out made
offline never reaches the server. A session can also end without the phone taking part at all: a
password reset, or another sign-in on the same phone evicting it. In each case the row outlives the
session, and the next person signed in on that phone could receive the previous user's notices,
which name people and leave dates.

We key the registration on the Native session instead. It lives in its own table, keyed by session
id with a cascading delete, and holds the token and its environment. The phone upserts it on every
foreground while it is signed in and has notification permission, which also re-registers it after
a password change or two-factor toggle swaps its session. Only Native sessions may register;
a web session has no token to give.

A registration ends when:

- its session ends, for any reason (sign-out, password reset, a sign-in on the same phone), by
  cascade;
- the Better Auth secret changes: on boot, before it listens, the backend compares a fingerprint of
  its secret with the one it stored, and a different one deletes every session row, so every
  registration cascades with it;
- another session registers the same token, which only happens when the phone has moved on to it;
- APNs answers `410` for its token, or `BadDeviceToken` from both hosts. A token sent to the wrong
  host also gets `BadDeviceToken`, so one refusal is retried on the other host, and the stored
  environment follows the host that accepts it;
- the phone finds notification permission revoked and deletes it.

What this costs: the server cannot push to a phone that has no live session, and a phone that
stays signed in keeps its registration until one of the above. A 401 needs no server-side cleanup,
because the phone unregisters from APNs on its Signed-out wipe. That covers the gap a rolling
deploy leaves in the secret check. Instances still on the old secret go on creating sessions after
the first new instance has checked, and the check never sees those rows. Their cookies fail on the
new secret, so the phone gets a 401 on its next call and unregisters from APNs. The registration
row lingers, but the phone receives nothing. There is no server-side push preference; the phone's
iOS notification switch turns push off per phone.

Reversing this means a migration to a device-keyed table plus an unregister path, and it reopens
the risk of pushing one user's notices to another user on a shared phone.
