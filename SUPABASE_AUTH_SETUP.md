# Enabling real server-side access control (Supabase Auth + RLS)

This is the setup needed to finish fixing the #1 gap from the platform review:
right now, the single data row (`sgoa_store`) and the file storage bucket
(`sgoa-files`) are readable and writable by anyone holding the public anon
key — which is visible to anyone who views the page source. There is no way
for the database to tell a real logged-in staff member apart from anyone
else who copied that key.

The code side is already done and pushed, but it is **switched off by
default** (`ENFORCE_SUPABASE_AUTH = false` near the top of `index.html`,
in the "SUPABASE AUTH GATE" section) on purpose — flipping it on before
finishing the steps below would lock every single person out of the app
immediately, since nobody has a matching Supabase Auth account yet.

## What changes once this is on

- Logging in will require a real Supabase Auth session, not just a locally
  stored password. The app still keeps its own username/password system for
  everything else (roles, department access, the approval chains) — this
  only adds a second, server-enforced gate in front of the one shared data
  row and the file storage bucket.
- Anyone who is not a provisioned staff member (i.e. has no Supabase Auth
  account) can no longer read or write that row or upload/download files,
  even with the anon key.
- **This does not make one department's data invisible to another logged-in
  staff member.** The whole app still reads and writes one shared JSON
  blob — Finance, Safeguarding, HR, everyone's data lives in the same row.
  Stopping one staff member from reading another department's confidential
  records at the database level would require splitting that single blob
  into real per-entity tables with per-row RLS policies, which is a much
  larger rearchitecture, not part of this change. What this *does* fix is
  keeping the general public out entirely.

## Steps, in order

### 1. In the Supabase dashboard → Authentication → Settings
- Turn **off** "Confirm email" (these accounts use a synthetic address
  under `@staff.sgoa.internal` — nothing will ever be delivered there, so
  a confirmation step would permanently lock everyone out).
- Leave "Enable email signups" **ON** for now — the migration step below
  needs it. You can turn it off afterward (see step 4).

### 2. Run the SQL below in the Supabase SQL Editor
This turns on Row Level Security and requires a real authenticated session
for any access to the shared data row and the file bucket.

```sql
-- Require a real Supabase Auth session to touch the app's one data row.
alter table sgoa_store enable row level security;

create policy "authenticated access only"
on sgoa_store
for all
to authenticated
using (true)
with check (true);

-- Same requirement for the file storage bucket used for document uploads.
create policy "authenticated file access only"
on storage.objects
for all
to authenticated
using (bucket_id = 'sgoa-files')
with check (bucket_id = 'sgoa-files');
```

Do this **before** flipping `ENFORCE_SUPABASE_AUTH` to `true` — the app will
still work exactly as it does today in the meantime, since the anon key still
has unrestricted access until this policy is in place and the flag is on.

### 3. Provision a Supabase Auth account for every current staff login
In the app, as the Executive Director: **User Management → "Provision Staff
Logins (Supabase Auth)"**. It will ask, one at a time, for each account's
*current* password (the one they actually log in with today) — it cannot
read this back out of storage, since passwords are hashed, so you need to
know it or leave that account blank to skip it.

- For the 13 built-in department-head accounts, those are the passwords
  already defined in this file's own `CRED` object — you already have them.
- For anyone who changed their password since their account was created, or
  whose original password you don't have a record of, skip them here and
  instead reset their password once via **User Management → Edit User**
  (sets a password you choose), tell them the temporary password, and have
  them change it themselves afterward via **My Settings** — that flow syncs
  both systems automatically for whoever is doing it to their own account.

### 4. Decide how new staff accounts get provisioned going forward
Creating a new account through **User Management → "+ Add New User"** (or a
department head's "+ Add Staff Account") already tries to provision a
matching Supabase Auth login automatically. Whether that keeps working
depends on one choice:

- **Leave "Enable email signups" on** — new accounts keep provisioning
  automatically through the app, same as today. The trade-off: anyone who
  has the anon key can also self-register a Supabase Auth account the same
  way, which doesn't by itself grant them anything in this app (they'd still
  need a role/profile created through User Management to do anything), but
  it does mean an outsider could authenticate against the database row and
  poke at the JSON blob, limited to what calling the app's own JS functions
  against it would reveal — a far smaller hole than today's fully open
  access, but not a fully closed one.
- **Turn "Enable email signups" off** (recommended once initial migration is
  done) — the automatic provisioning in "+ Add New User" will then fail with
  a clear warning in the app, and you provision each new hire's Supabase
  Auth login yourself from the Supabase dashboard (Authentication → Users →
  Add user) using the same `username@staff.sgoa.internal` email pattern,
  before or after creating their app profile in User Management.

Either is defensible; the second is tighter. This is a real policy decision
for SGOA to make, not something the code should decide silently.

### 5. Flip the switch
Once steps 1–3 are done (and you've picked a position on step 4), change
this one line near the top of `index.html`:

```js
var ENFORCE_SUPABASE_AUTH = false;   // change to true
```

Test logging in with one account on the deploy preview before merging to
confirm it works end-to-end, then merge.

## What is still NOT fixed by this

- **Passwords in this app's own storage are hashed (SHA-256 + per-account
  salt), not stored in plain text** — that part of the original review was
  already fixed separately and does not depend on any of the above.
- **File uploads still use permanent public URLs** (`getPublicUrl`), not
  signed/expiring ones. The RLS policy above controls who can *upload to or
  list* the bucket, but a public URL for an already-uploaded file, once
  known, stays fetchable regardless of RLS. If any uploaded documents are
  genuinely confidential, that needs addressing separately (switching to
  `createSignedUrl` with an expiry, which also requires making the bucket
  itself private rather than public in the bucket's own settings).
- **No real backup/disaster-recovery policy** — confirm what Supabase's own
  backup settings are for this project; nothing in the app itself backs up
  the database.
