# Push registrations belong to the Native session, not to a device table

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
launch while it is signed in and has notification permission. Only Native sessions may register;
a web session has no token to give.

A registration ends when:

- its session ends, for any reason (sign-out, password reset, a sign-in on the same phone), by
  cascade;
- APNs answers `410 Unregistered` or `BadDeviceToken` for its token;
- the phone finds notification permission revoked and deletes it.

What this costs: the server cannot push to a phone that has no live session, and a phone that
stays signed in keeps its registration until one of the above. A 401 needs no server-side cleanup.
There is no server-side push preference; the phone's iOS notification switch turns push off per
phone.

Reversing this means a migration to a device-keyed table plus an unregister path, and it reopens
the risk of pushing one user's notices to another user on a shared phone.
