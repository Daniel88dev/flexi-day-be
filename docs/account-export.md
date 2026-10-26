# Account export

The rules behind the **Account export** row in [`GLOSSARY.md`](../GLOSSARY.md). Flexi Day is the
controller of account data, so it answers a person's access request for that data itself, through
`GET /api/users/me/export` in `src/routes/usersRouter.ts`. The work is in
`src/services/accountExport/`.

- One request builds the file and answers it as a JSON attachment named
  `flexi-day-account-YYYY-MM-DD.json`. There is no background build, no stored copy and no email.
- It works on every plan, with a web cookie or a Native session. The web offers it as "Download my
  account data" in the "Your data" card in Settings.
- The reads run in one read-only repeatable-read transaction, so the sections agree.

## What it holds

| Section               | Contents                                                                       |
| --------------------- | ------------------------------------------------------------------------------ |
| `account`             | Name, email, verified flag, Account picture URL, two-factor flag, dates        |
| `signInMethods`       | One per Account link: provider, the id at the provider, dates                  |
| `sessions`            | Dates, IP, user agent, Device id, platform, app version, which one asked       |
| `pushRegistrations`   | Environment, the session's Device id and platform, dates                       |
| `settings`            | Every preference, the defaults when none was saved                             |
| `birthday`            | Month, day, year, shared, dates; null when never set                           |
| `notifications`       | Every Notification, read or unread                                             |
| `calendarConnections` | Provider, status, capability, granted scopes, dates, revoked ones included     |
| `calendarFeeds`       | Each feed and Sync target's settings and the provider it writes to, with dates |

## What it never holds

Access, refresh and id tokens, password hashes, two-factor secrets and backup codes, session ids and
tokens, calendar connection tokens, feed links and APNs device tokens. Every query names its
columns, so these are never read. `src/tests/e2e/accountExport.e2e.test.ts` seeds each one and
checks the response does not contain it.

Organization data (Employments, bookings, attendance, quotas) is not account data and stays out.
The organization's own exports cover it.
