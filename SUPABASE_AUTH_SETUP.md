# SGOA Platform — live backend architecture (Supabase Auth + RBAC + RPC sync)

This replaces the old "ENFORCE_SUPABASE_AUTH flag" document. That approach (a single
shared data row gated by a simple authenticated-only RLS policy) is gone. The app now
runs on a real per-account identity, real roles/permissions, and a real sync protocol.
**This has already been tested working against the live project** — this document
describes what `index.html` now expects to exist on the backend, and how to operate it
day to day. It is not a from-scratch setup guide, since the Edge Functions, tables and
RPC functions already exist; it is a reference for IT/the administrator going forward.

## 1. Logging in

`doLogin()` does **not** call `supa.auth.signInWithPassword()` directly. It POSTs the
username and password to an Edge Function:

```
POST {SUPA_URL}/functions/v1/sgoa-erp-login
headers: content-type: application/json, apikey: {SUPA_KEY}
body: { "username": "...", "password": "..." }
```

That function is expected to return a Supabase session object (the same shape
`supa.auth.setSession()` accepts — access/refresh tokens), which the app then installs
with `supa.auth.setSession(session)`. If the function returns a non-2xx response with
`{ "error": "..." }`, that message is shown on the login screen as-is.

On every page load, `sgoaLiveInit()` tries to restore an existing session via
`supa.auth.getSession()` / `supa.auth.getUser()` before falling back to the login screen.

## 2. Identity, roles and permissions

Once signed in, `loadAuthenticatedIdentity(user)` reads three tables by the authenticated
user's id:

- **`profiles`** — one row per staff member, keyed by Supabase Auth user id. Must have
  `status = 'active'` or login is refused. Fields the app reads: `full_name` (or `name`),
  `username`, `work_email`, `phone`, `department_id`.
- **`user_roles`** — links a profile to one or more **`roles`** rows, each optionally
  bounded by `valid_from`/`valid_until`. If someone holds more than one active role, the
  app picks the highest-priority one from this fixed list: `executive_director`,
  `deputy_director`, `program_deputy_director`, `it_admin`, `meal_head`, `finance_head`,
  `hr_head`, `program_manager` (anything else falls through in whatever order the query
  returned it).
- **`role_permissions`** → **`permissions`** — every permission code attached to any of
  that person's active roles. A permission code of `*` or `all` grants everything.

A role whose `code` is literally `department_head` is special-cased: the app looks up
that profile's `departments.code` and maps it to a department key (`procurement`→`supply`,
`administration`→`admin`, `supply_chain`→`supply`, anything else passed through as-is).
Every other role code is mapped to an internal page-group key via the `ROLE_KEYS` table
near the top of `index.html` — if a new role code is added on the backend with no entry
there, that account will fail to log in with "Your role needs a department mapping."

**No active role or no permissions at all = login refused.** There is no fallback role.

## 3. Page and feature gating

`permissionAllowsPage(pg, perms)` is checked both on navigation (`go()`) and is the only
thing standing between a signed-in account and a page — the old `ACCESS` arrays still
exist but are now a secondary, coarser check. Two pages (`my-work`, `my-settings`) are
always reachable by anyone signed in, regardless of permissions. Five pages are
"shared self-service" — reachable by *either* the page's normal department permission
*or* a separate self-service permission, so any staff member can submit their own
request even without their department's management permission:

| Page | Self-service permission |
|---|---|
| `raise-pr` | `procurement.pr.create` |
| `leave-request` | `hr.leave.request` |
| `tar-request` | `access.requests.create` |
| `it-tickets` | `it.tickets.create` |
| `timesheet` | `timesheets.submit` |

Every other page is gated by the specific permission code(s) listed in the `map` object
inside `permissionAllowsPage` — that map is the single source of truth for what each
permission code actually unlocks in this app.

## 4. Data sync (replaces the old shared `sgoa_store` row)

There is no more single JSON blob. Data loads and saves go through two RPC functions:

- **`sgoa_erp_load()`** — takes no arguments beyond the authenticated session; returns
  `{ DB: {...}, PROJ: {...}, hashes: {...} }`. `DB`/`PROJ` are scoped to whatever
  collections this account's role has permission to see — a collection this account has
  no hash for is one it was never granted. `hashes` is a per-collection version stamp used
  for conflict detection (see below).
- **`sgoa_erp_save({ changes })`** — `changes` is an array of
  `{ collection, base_hash, value }`, one entry per collection that actually changed
  locally since the last load/save (compared against `sgoaBaseline`, with computed
  fields like `PROJ.spent` stripped out first so they don't trigger false diffs). Returns
  the same `{ DB, PROJ, hashes }` shape the load RPC does. If `base_hash` is stale (someone
  else saved that collection first), the call is expected to fail with error code `40001`
  — the app surfaces this as "Someone else saved changes" and stops autosaving until the
  page is reloaded, rather than silently overwriting their change.

`queueCloudSave()` debounces local edits (700ms) before calling `saveToCloud()`, which
does the diffing and the actual RPC call. A collection with local data that was never
granted a hash at all (meaning this account loaded it with permission it doesn't
actually have) is refused outright rather than saved — that would mean saving data this
account was never allowed to see.

## 5. Notifications

Marking a notification read is server-synced, not purely local: `openNotif()` and
`markAllNotifsRead()` both call `supa.rpc('sgoa_mark_notices', { ids: [...] })` before
updating the local read flag, so another of this person's own open tabs/sessions sees
the same read state.

## 6. File attachments — private, not public

Uploads go to a bucket named `sgoa-files`, at a path of
`{authUserId}/{folder}/{uuid}-{filename}`, and require the `documents.upload`
permission. **There is no public URL anymore.** The record stores a marker
(`sgoa-private://sgoa-files/{path}`), and opening a file calls `sgoaOpenFile(docId)`,
which exchanges that marker for a short-lived (60-second) signed URL via
`supa.storage.from('sgoa-files').createSignedUrl(path, 60)` at the moment someone with
access actually clicks it. The bucket itself must be **private**, not public, in its own
Supabase settings — a public bucket would make the signed-URL step pointless.

## 7. The public complaints form (no login at all)

This is a separate, deliberately isolated path — it cannot use `sgoa_erp_save` at all,
since there is no authenticated session on that page. It POSTs to its own Edge Function:

```
POST {SUPA_URL}/functions/v1/sgoa-public-concern
body: { name, contact, location, project, type, description, honeypot, requestId }
```

`requestId` (a `crypto.randomUUID()` generated once per report attempt, reused on any
retry of the *same* report) is the idempotency key — a flaky connection or a double
click must not create two tickets for one real submission. A successful response is
`{ received: true, receipt: "..." }`; the receipt is shown to the visitor as their
reference number.

## 8. Password changes — self-service only now

`saveMyPassword()` / `doChangePassword()` both go through `supa.auth.updateUser()`
directly. **There is no admin-reset path from inside the app anymore.** If someone is
locked out, an administrator has to reset their password directly in the Supabase
dashboard (Authentication → Users → that user → reset password) — there is nothing in
User Management that can do this for them now, by design: the anon key has no privilege
to change another account's Auth password.

## 9. Provisioning a new staff account

**User Management → "+ Add New User" (and a department head's "+ Add Staff Account")
can no longer create a working login.** Both forms now just explain that real accounts
must be created through the trusted administrator workflow, because creating one needs
all of the following, which the anon key cannot do on its own:

1. A Supabase Auth user (Authentication → Users → Add user, in the dashboard).
2. A matching `profiles` row for that Auth user's id, with `status = 'active'`, their
   `full_name`, `username`, `work_email`, `phone`, and `department_id`.
3. A `user_roles` row linking that profile to the correct `roles` row (so it resolves
   through `ROLE_KEYS`/the `department_head` special case above).
4. Whatever `role_permissions` that role already carries — nothing extra to do here
   unless a brand-new role is being introduced.

Until that admin-side tooling exists, each new hire's account has to be created by
whoever has dashboard/service-role access, not by the app itself.

## 10. Record deletion — disabled

Every "Delete" action in the app (`confirmDelete()`) now shows a message that record
removal is disabled, instead of deleting anything. There is no `sgoa_erp_save`-equivalent
RPC for destroying a row yet, and permanently discarding real organizational data needs
an approved process, not a client-side splice that could silently race against someone
else's unsaved edit. If genuine deletion is needed later, it needs its own RPC (with its
own authorization/audit story) before this can be re-enabled.

## 11. The legacy `CRED` object

`CRED` (the original 13 hardcoded department-head username/password pairs) is **no
longer used for authentication at all** — real login only ever goes through the Edge
Function above. It is kept only as a harmless fallback for a couple of display/labeling
spots (the Staff Login Activity list, and username-uniqueness error messages) so an old
CRED username doesn't silently collide with a real one. It carries no security weight
either way now and can be removed in a future cleanup without affecting login.

## What this document does *not* cover

I have not seen and cannot verify the actual SQL behind `sgoa_erp_load`, `sgoa_erp_save`,
`sgoa_mark_notices`, the two Edge Functions, or the RLS policies on `profiles` /
`user_roles` / `role_permissions` / `departments` / `sgoa-files` — only the *client-side
contract* `index.html` now depends on, listed above. The backend itself was already
built and confirmed working by direct testing against the live project, not by me in
this sandbox (no outbound network access here reaches supabase.co). Anyone maintaining
the Supabase side should treat sections 1–10 above as the interface that must keep
working, not as instructions to (re)create it from scratch.
