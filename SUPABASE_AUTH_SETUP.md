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

## 8. Password changes

`saveMyPassword()` / `doChangePassword()` (while already signed in) both go through
`supa.auth.updateUser()` directly — self-service, no admin needed.

**Forgotten password** now has a real self-service path too: a "Forgot your password?"
link on the sign-in screen asks for the account's work email and calls
`supa.auth.resetPasswordForEmail(email, { redirectTo })`. Clicking the emailed link
brings the person back to the app with a one-time recovery session; the app detects this
(`type=recovery` in the URL, or Supabase's `PASSWORD_RECOVERY` auth event) and shows a
"Set a new password" form instead of silently logging them in with no password change.

**This depends on one Supabase setting being correct: Authentication → URL
Configuration → Site URL** (and, if present, the Redirect URLs allow-list) must point at
the app's real address — not the `localhost:3000` default. We hit exactly this in
testing: a reset link landed on a blank `localhost` page until Site URL was changed to
the deploy preview/production address. If reset links stop working again after the
production domain changes, check this setting first.

An administrator can still force-reset anyone's password directly from Authentication →
Users → that account → "Send password recovery" (or, if available in that project's
dashboard version, a direct password field) — useful when someone can't access their own
email, or for the very first login on a brand-new account.

## 9. Provisioning a new staff account

**User Management → "+ Add New User" now works again** — it calls a dedicated Edge
Function, `sgoa-admin-create-staff` (source: `supabase/functions/sgoa-admin-create-staff/
index.ts` in this repo), because creating a real account needs privileges the anon key
intentionally doesn't have: creating a Supabase Auth user, plus matching `profiles` and
`user_roles` rows, in one step. The function independently re-checks that whoever is
calling it is actually allowed to (currently: an `executive_director` or `it_admin`
role, checked server-side from their own session token — never trusted from the request
itself), so this isn't something a lower-permission account can abuse even by calling the
function directly.

A department head's own "+ Add Staff Account" button is **not** wired to this function
(still shows the admin-workflow message) — only full User Management can create accounts,
since ordinary department heads won't hold the required role.

### Deploying this function (needed once, not yet live)

This function exists in the repo but has not been deployed, and could not be tested from
this session (no network access to supabase.co from this sandbox). Before relying on it:

1. In the Supabase dashboard, left sidebar → **Edge Functions**.
2. Click **"Create a new function"** (or "Deploy a new function").
3. Name it exactly `sgoa-admin-create-staff` — the app calls this exact name.
4. Open `supabase/functions/sgoa-admin-create-staff/index.ts` from this repo, copy its
   full contents, and paste them into the function's code editor, replacing anything
   that's there by default.
5. Click **Deploy**. No extra secrets need setting — `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically to
   every Edge Function in a project.
6. **Test it once with a throwaway account** before trusting it with a real hire: sign
   in as the Executive Director, use "+ Add New User" with a role you can verify
   (e.g. `staff`), confirm the new account actually appears in Authentication → Users,
   the `profiles` table, and the `user_roles` table, and that it can actually sign in.
   The role codes in the "+ Add New User" dropdown (`meal_head`, `finance_head`, etc.)
   are this app's best inference of what's in the `roles` table's `code` column — check
   Table Editor → `roles` and adjust the dropdown in `index.html` if any don't match.
7. If a role code doesn't match, the function fails cleanly with "Unknown role code
   ..." rather than creating a half-finished account with no role — safe to retry once
   the dropdown (or the `roles` table) is corrected.

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
