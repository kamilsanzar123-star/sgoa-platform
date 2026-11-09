// supabase/functions/sgoa-admin-create-staff/index.ts
//
// Admin-only: creates a real staff login (a Supabase Auth user, a profiles row, and a
// user_roles row) in one step. This needs the SERVICE ROLE key, which the browser app
// never has and must never be given -- that is exactly why "+ Add New User" in the app
// can no longer create a working login on its own, and calls this function instead.
//
// NOT YET DEPLOYED. Writing this file into the repo does not put it live -- see
// SUPABASE_AUTH_SETUP.md, section "Deploying this function", for how to deploy it from
// the Supabase dashboard (no command line needed), and what to check before trusting it
// with real accounts. It has not been tested against the live project from this session
// (no network access to supabase.co from here) -- test it once with a throwaway account
// before relying on it for real staff.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Only a caller whose own resolved role is one of these may create a new account. Adjust
// this list if a different role should also be allowed to add staff.
const ALLOWED_CALLER_ROLE_CODES = new Set(["executive_director", "it_admin"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const name = String(body.name || "").trim();
  const username = String(body.username || "").trim();
  const workEmail = String(body.workEmail || "").trim();
  const phone = String(body.phone || "").trim();
  const password = String(body.password || "");
  const roleCode = String(body.roleCode || "").trim();

  if (!name || !username || !workEmail || !password || !roleCode) {
    return json({ error: "name, username, workEmail, password and roleCode are all required." }, 400);
  }
  if (password.length < 12) {
    return json({ error: "Password must be at least 12 characters." }, 400);
  }

  const authHeader = req.headers.get("authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) return json({ error: "Missing authorization." }, 401);

  // Verify the CALLER using their own token -- never trust anything the request body
  // itself claims about who is calling.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });
  const { data: callerAuth, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerAuth?.user) {
    return json({ error: "Your session is invalid or expired. Sign in again." }, 401);
  }

  // Everything below uses the SERVICE ROLE client, which bypasses RLS entirely -- every
  // authorization check that matters has to happen explicitly in this function's own code.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Re-derive the caller's own role server-side (mirrors loadAuthenticatedIdentity in
  // index.html) instead of trusting anything the client sent about itself.
  const { data: callerProfile } = await admin
    .from("profiles")
    .select("status")
    .eq("id", callerAuth.user.id)
    .single();
  if (!callerProfile || callerProfile.status !== "active") {
    return json({ error: "Your account is not active." }, 403);
  }
  const { data: callerRoleRows } = await admin
    .from("user_roles")
    .select("roles(code)")
    .eq("user_id", callerAuth.user.id);
  const callerRoleCodes = (callerRoleRows || [])
    .map((r: { roles?: { code?: string } }) => r.roles?.code)
    .filter(Boolean) as string[];
  const authorized = callerRoleCodes.some((c) => ALLOWED_CALLER_ROLE_CODES.has(c));
  if (!authorized) {
    return json({ error: "You do not have permission to create staff accounts." }, 403);
  }

  // Look up the requested role BEFORE creating anything, so an unknown role code fails
  // cleanly instead of leaving a half-created account with no role at all.
  const { data: role, error: roleErr } = await admin
    .from("roles")
    .select("id")
    .eq("code", roleCode)
    .single();
  if (roleErr || !role) {
    return json(
      { error: `Unknown role code "${roleCode}". Check the "roles" table in Supabase for the exact code to use.` },
      400
    );
  }

  // Create the Auth user.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: workEmail,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message || "Could not create the login (the email may already be in use)." }, 400);
  }
  const newUserId = created.user.id;

  // Create the profile row. If this fails, remove the Auth user just created so there is
  // no orphaned login attached to nothing.
  const { error: profileErr } = await admin.from("profiles").insert({
    id: newUserId,
    username,
    full_name: name,
    work_email: workEmail,
    phone: phone || null,
    status: "active",
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(newUserId);
    return json({ error: "Could not create the staff profile: " + profileErr.message }, 400);
  }

  // Link the role. If this one step fails, the login and profile already exist -- report
  // that plainly rather than pretending the whole thing failed and needs retrying from
  // scratch (retrying would then fail on a duplicate email/username).
  const { error: roleLinkErr } = await admin.from("user_roles").insert({
    user_id: newUserId,
    role_id: role.id,
  });
  if (roleLinkErr) {
    return json(
      {
        error:
          "Account and profile were created, but the role could not be linked (" +
          roleLinkErr.message +
          "). Add it manually in the user_roles table for user id " +
          newUserId +
          ".",
      },
      500
    );
  }

  return json({ ok: true, userId: newUserId });
});
