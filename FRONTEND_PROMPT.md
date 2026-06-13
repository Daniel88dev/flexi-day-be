# Frontend Integration Prompt — flexi-day-be

You are building the frontend for **flexi-day**, a vacation management system. The backend (`flexi-day-be`) is an Express + TypeScript + Drizzle + Better Auth service. This document describes everything you need to consume the API.

---

## 1. Stack & ground rules

- API base URL: `BETTER_AUTH_URL` host (defaults to `http://localhost:<PORT>` in dev). All endpoints are JSON.
- CORS: in dev, any `http://localhost:<port>` origin is allowed. `credentials: true` — you **must** send credentials (cookies) on every request.
- Auth: cookie-based sessions from **Better Auth**. Use the official client SDK (`better-auth/client`) — do not roll your own login.
- All non-auth endpoints require an authenticated session. Without it, you get `401 Unauthorized`.
- All IDs are UUID strings.
- Dates from the API:
  - `requestedDay` is an ISO date string (`YYYY-MM-DD`).
  - `startTime` / `endTime` are time strings (`HH:mm:ss`) or `null`.
  - `createdAt`, `updatedAt`, `approvedAt`, `rejectedAt`, `deletedAt` are ISO datetime strings (timestamps). Parse with `new Date(...)`.
  - `relatedYear` (quotas) is a string (e.g. `"2026"`).

---

## 2. Authentication (Better Auth)

Mount path on the backend: `/api/auth/*`. Use the Better Auth client:

```ts
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL, // e.g. http://localhost:3000
  fetchOptions: { credentials: "include" },
});
```

Supported flows (configured server-side):
- **Email + password sign-up** with **email verification required** (verification email is sent on sign-up; auto-signin after verification).
- **Sign-in** with email + password (requires verified email).
- **Password reset** via email link.
- Have-I-Been-Pwned password check on sign-up / reset.
- Rate limit: **5 requests per 10 s** window on auth endpoints.

The session shape exposed to the rest of the app (server side, `AuthSession`):

```ts
type AuthSession = {
  sessionId: string;
  userId: string;     // UUID
  userName: string;
  userEmail: string;
  emailVerified: boolean;
};
```

`getSession()` on the client returns the matching user/session payload.

---

## 3. Shared types

Mirror these TypeScript types on the frontend (copy them into a `src/api/types.ts`).

```ts
export type Iso = string;          // ISO datetime
export type IsoDate = string;      // YYYY-MM-DD
export type IsoTime = string;      // HH:mm:ss
export type UUID = string;

export enum VacationKind {
  Vacation = "VACATION",
  HomeOffice = "HOME_OFFICE",
  Sick = "SICK",
  BankHoliday = "BANK_HOLIDAY",
  NonPaidLeave = "NON_PAID_LEAVE",
  PaidTimeOff = "PAID_TIME_OFF",
  SickLeave = "SICK_LEAVE",
  StudyLeave = "STUDY_LEAVE",
  Other = "OTHER",
}

export type Vacation = {
  id: UUID;
  userId: UUID;
  groupId: UUID;
  requestedDay: IsoDate;
  startTime: IsoTime | null;
  endTime: IsoTime | null;
  vacationType: VacationKind;
  approvedAt: Iso | null;
  approvedBy: UUID | null;
  rejectedAt: Iso | null;
  rejectedBy: UUID | null;
  deletedAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
};

export type Group = {
  id: UUID;
  groupName: string;
  defaultVacationDays: number;
  defaultHomeOfficeDays: number;
  managerUserId: UUID;
  mainApprovalUser: UUID | null;
  tempApprovalUser: UUID | null;
  deletedAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
};

export type GroupUser = {
  id: UUID;
  groupId: UUID;
  userId: UUID;
  viewAccess: boolean;     // can read group data (quotas, members)
  adminAccess: boolean;    // can manage members + permissions
  controlledUser: boolean; // is a vacation-tracked member (can create vacations)
  deletedAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
};

export type UserYearQuota = {
  id: UUID;
  userId: UUID;
  groupId: UUID;
  relatedYear: string;     // "2026"
  vacationDays: number;
  homeOfficeDays: number;
  createdAt: Iso;
  updatedAt: Iso;
};
```

---

## 4. Endpoints

All paths below are prefixed with the API base URL. Every request **must** include `credentials: "include"` (or use the Better Auth client / `fetch` wrapper that does).

### 4.1 Health

| Method | Path     | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET    | `/health` | none | Returns `{ ok: true, environment: "dev" \| "production" \| "test" }`. |

### 4.2 Auth — `/api/auth/*`

Handled by Better Auth. Use the client SDK rather than hand-rolling these. Notable endpoints (default Better Auth surface):
- `POST /api/auth/sign-up/email` `{ name, email, password }` → triggers verification email.
- `POST /api/auth/sign-in/email` `{ email, password }` → sets session cookie.
- `POST /api/auth/sign-out`
- `POST /api/auth/forget-password` `{ email }`
- `POST /api/auth/reset-password` `{ newPassword, token }`
- `GET /api/auth/get-session` → current session or `null`.

The Better Auth `openAPI` plugin exposes a full schema at `/api/auth/reference` if you want to introspect.

### 4.3 Vacations — `/api/vacation` (auth required)

#### GET `/api/vacation`
List the **authenticated user's** vacations for a given month.

Query params (both optional, default to current year/month):
- `year` — integer, 2023–2050
- `month` — integer, 1–12

Response `200`: `Vacation[]` (only the caller's, excluding soft-deleted).

Errors: `401` (no session), `422` (bad query).

#### POST `/api/vacation/create-vacation`
Create a vacation for the authenticated user.

Body:
```ts
{
  groupId: UUID;
  requestedDay: IsoDate;       // server coerces to date
  startTime?: IsoTime | null;  // defaults to null
  endTime?: IsoTime | null;    // defaults to null
}
```

Response `201`: the created `Vacation`. `vacationType` is set to `VACATION` server-side (other kinds aren't user-creatable yet).

Errors:
- `401` — no session.
- `403` — the user is not a `controlledUser` of `groupId`.
- `422` — validation error (Zod). Body is `{ error: "Invalid data", details: [...] }`.
- `500` — insert failed (e.g., unique conflict on `(userId, requestedDay)` returns no row).

#### POST `/api/vacation/approve/:id`
Approve a vacation. `:id` is the vacation UUID.

Response `200`: `{ message: "Vacation approved" }`.

Errors:
- `401` — no session.
- `403` — caller is not the group's `mainApprovalUser` or `tempApprovalUser`.
- `404` — vacation not found (or approvers can't be loaded).
- `422` — bad UUID.

> **Note:** there is no rejection or deletion endpoint exposed yet (services exist but no route is wired). Don't expect them.

### 4.4 Groups — `/api/group` (auth required)

#### GET `/api/group`
List groups the authenticated user belongs to (via `groupUsers`).

Response `200`: `Group[]`.

#### POST `/api/group`
Create a new group. The caller becomes the manager **and** is auto-added as a `groupUser` with `viewAccess: true, adminAccess: true`.

Body (Zod):
```ts
{
  groupName: string;                 // min 1 char
  defaultVacation?: number;          // 0..99
  defaultHomeOffice?: number;        // 0..99
  mainApprovalUser?: UUID;
}
```

Response `201`: the created `Group`.

Errors: `401`, `422` (Zod throws), `500`.

> No update / delete group endpoints are exposed yet — the services exist but no routes.

### 4.5 Group users — `/api/group-user` (auth required)

#### GET `/api/group-user/:groupId`
List all (non-deleted) members of a group.

Authorization: the caller must have **any** `groupUser` record on `groupId` (view access is implied by membership for this endpoint).

Response `200`: `GroupUser[]`.

Errors: `400` (bad UUID), `403` (no access for this group), `401`.

#### POST `/api/group-user/code/:validationCode`
Join a group via an invite link code. Atomically creates a `groupUser` (with `viewAccess: true, adminAccess: false, controlledUser: true`) and marks the invite link as used.

Response `201`: the new `GroupUser`.

Errors:
- `400` — missing/invalid code param.
- `404` — code unknown, already used, or expired.
- `401`, `500`.

> **Note:** there is currently **no public endpoint to generate invite links**. The `inviteLink` service exists but no route mounts it; links would need to be created out-of-band (admin tool / DB) for now. Flag this with the backend owner if the UI needs to issue codes.

#### PUT `/api/group-user`
Bulk-update permissions for users in a group. Caller must have `adminAccess` on `groupId`.

Body (validated by Zod):
```ts
{
  groupId: UUID;
  data: Array<{
    userId: UUID;
    viewAccess: boolean;
    adminAccess: boolean;
    controlledUser: boolean;
  }>;
}
```

Response `200`: `{ message: "Group users updated successfully" }`.

Errors:
- `401` — no session.
- `403` — caller lacks `adminAccess`.
- `400` — at least one user couldn't be updated (transaction rolls back).
- `422` — Zod validation error.

### 4.6 Quotas — `/api/quotas` (auth required)

#### GET `/api/quotas/:groupId`
Get yearly vacation/home-office quotas for users in a group.

Path param: `groupId` (UUID).

Query params:
- `year` — integer, 2023–2050, defaults to current year.
- `userId` — optional UUID. If provided, returns just that user's quota; otherwise returns all users in the group for the year.

Authorization: caller must have `viewAccess` on `groupId`.

Response `200`: `UserYearQuota[]` (may be empty if no rows yet for that year).

Errors: `400` (bad query), `403` (no view access), `422` (bad path UUID), `401`.

---

## 5. Error contract

Errors come from a central error middleware. Two shapes you'll see:

1. **AppError JSON** — most common:
   ```ts
   { message: string }
   ```
   with the relevant HTTP status code.
2. **Zod body validation error** (from `bodyValidationMiddleware`):
   ```ts
   { error: "Invalid data"; details: Array<{ message: string }> }
   ```
   status `422`.

Be defensive: also handle generic `5xx` HTML/empty responses (CORS preflight or proxy errors).

Suggested client helper:

```ts
export async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.message ?? body?.error ?? res.statusText, body);
  }
  return res.json() as Promise<T>;
}
```

---

## 6. Domain rules to keep in mind in the UI

- A user can only **create** a vacation for a group where they are a `controlledUser`.
- A user can only **approve** vacations in groups where they are `mainApprovalUser` or `tempApprovalUser` of that group (these are stored on the `Group` record itself, not on `GroupUser`).
- Listing members and bulk-updating permissions are gated by `viewAccess` / `adminAccess` on `GroupUser`.
- Vacations have a hard unique constraint on `(userId, requestedDay)` — the UI should disambiguate the "you already have a request for that day" case (currently surfaces as a generic `500 Failed to create vacation`).
- All "deletes" are soft (`deletedAt`); deleted records are filtered out of list endpoints.
- The audit `changes` table is not exposed via any route yet.

---

## 7. Suggested FE architecture

- One `apiClient.ts` with a thin `fetch` wrapper that always sets `credentials: "include"` and parses errors per §5.
- One module per domain (`vacations.ts`, `groups.ts`, `groupUsers.ts`, `quotas.ts`) exposing typed functions matching §4.
- Use TanStack Query (or similar) and key queries by `[domain, ...params]`:
  - `["vacations", year, month]`
  - `["groups"]`, `["group-users", groupId]`
  - `["quotas", groupId, year, userId ?? "all"]`
- Invalidate `["vacations", ...]` after `create-vacation` / `approve/:id`.
- Invalidate `["group-users", groupId]` after the PUT bulk update.
- Use the Better Auth client for session — wrap protected routes with a guard that redirects unauthenticated users to the login screen.

---

## 8. What is **not** yet available (don't design around them)

These services exist on the backend but have no exposed HTTP route — confirm with the backend owner before the UI depends on them:

- Vacation **rejection** and **deletion**.
- Group **update / delete / change manager / change approvers / update quotas**.
- **Generating invite-link codes** (joining via a known code works; creating one does not).
- **Audit log / changes** querying.
- **Quota mutation** (insert / decrease / per-record update).

If the UI needs any of these, raise it as a backend task first.