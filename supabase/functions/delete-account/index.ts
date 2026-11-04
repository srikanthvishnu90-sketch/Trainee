// delete-account: real auth-account deletion (beta 2026-09-24).
// Verifies the caller's JWT, then deletes their auth user via the GoTrue
// admin API. App-table rows cascade from auth.users (verified 2026-09-24).
// The client wipes app data first for immediacy; this removes the account
// itself so the user cannot sign back in.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return new Response("missing auth", { status: 401 });

  // Verify the JWT and resolve the user id
  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!meRes.ok) return new Response("invalid session", { status: 401 });
  const me = await meRes.json();
  const uid = me.id;
  if (!uid) return new Response("no user", { status: 401 });

  // Optional explicit confirmation body { confirm: "DELETE" }
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  if (body.confirm && String(body.confirm).toUpperCase() !== "DELETE") {
    return new Response("confirmation mismatch", { status: 400 });
  }

  // FIX (QA-B 2026-09-27): delete the user's vaulted SimpleFIN Access URL so
  // the bank credential does not linger after account deletion. Connection
  // rows cascade from profiles; the vault has no cascade, so this is the
  // only cleanup path. service_role may pass an explicit name to the RPC.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/simplefin_vault_delete`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_name: `simplefin_access_url_${uid}` }),
    });
  } catch { /* best-effort: account deletion proceeds regardless */ }

  // FIX (QA-D 2026-09-27): also purge the user's vaulted merchant credentials
  // (exec_cred_{uid}_{merchant_key}). exec_credential_refs rows cascade from
  // auth.users, but the vault secrets have no cascade — without this they
  // would linger after account deletion, contradicting the privacy policy.
  try {
    const refsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/exec_credential_refs?user_id=eq.${uid}&select=vault_name`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (refsRes.ok) {
      const refs = await refsRes.json();
      for (const r of refs || []) {
        if (!r.vault_name) continue;
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_vault_delete`, {
            method: "POST",
            headers: {
              apikey: SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ p_name: r.vault_name }),
          });
        } catch { /* per-secret best effort */ }
      }
    }
  } catch { /* best-effort: account deletion proceeds regardless */ }

  // FIX (QA-D2 2026-09-27): purge the vaulted Plaid access token.
  // The plaid edge function stores it as exec_cred_{uid}_plaid WITHOUT an
  // exec_credential_refs row, so the refs-iteration above would miss it —
  // the token would survive account deletion. Name it explicitly.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_vault_delete`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_name: `exec_cred_${uid}_plaid` }),
    });
  } catch { /* best-effort: account deletion proceeds regardless */ }

  // FIX (2026-10-12): purge the Gmail OAuth token (oauth_gmail_{uid}). Its
  // user_oauth_connections row cascades, but the vault has no cascade, so the
  // refresh token outlived the account. 20261012060000_oauth_vault_cascade.sql
  // also removes it by trigger on any row delete; this covers a project where
  // that migration is not applied yet.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/oauth_vault_delete`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_name: `oauth_gmail_${uid}` }),
    });
  } catch { /* best-effort: account deletion proceeds regardless */ }

  // WO-028 (2026-10-20): tailored resumes live in the private Storage bucket career-resumes at <uid>/<sha256>.pdf and
  // carry the person's name and email. Storage objects have no cascade from auth.users, so list the folder and remove
  // every file before the auth user goes (Storage REST API, service key; best-effort like the Vault calls above).
  try {
    for (let round = 0; round < 50; round++) {
      const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/career-resumes`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefix: `${uid}/`, limit: 1000, offset: 0 }),
      });
      if (!listRes.ok) break;
      const objects = await listRes.json();
      const prefixes = (objects || []).filter((o: any) => o && o.name).map((o: any) => `${uid}/${o.name}`);
      if (!prefixes.length) break;
      const rmRes = await fetch(`${SUPABASE_URL}/storage/v1/object/career-resumes`, {
        method: "DELETE",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes }),
      });
      if (!rmRes.ok) break;
    }
  } catch { /* best-effort: account deletion proceeds regardless */ }

  // FIX (QA-D2 2026-09-27): plaid_requests has no FK to profiles/auth.users,
  // so its rows do NOT cascade — delete them explicitly or they orphan.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/plaid_requests?user_id=eq.${uid}`, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
  } catch { /* best-effort: account deletion proceeds regardless */ }

  // FIX (QA-B2 2026-09-28): purge the user's action_ledger rows before deleting
  // the auth user. The ledger's append-only trigger blocks ON DELETE CASCADE,
  // so any user with ledger entries could never delete their account —
  // contradicting the app's "export or delete everything anytime" promise.
  // purge_user_action_ledger is SECURITY DEFINER, service_role only.
  const purgeRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/purge_user_action_ledger`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_uid: uid }),
  });
  if (!purgeRes.ok) {
    const t = await purgeRes.text().catch(() => "");
    return new Response(`ledger purge failed: ${t.slice(0, 200)}`, { status: 502 });
  }

  // Delete the auth user (cascades to profiles, threads, messages, etc.)
  const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!delRes.ok) {
    const t = await delRes.text().catch(() => "");
    return new Response(`delete failed: ${t.slice(0, 200)}`, { status: 502 });
  }
  return new Response(JSON.stringify({ deleted: true, user_id: uid }), {
    headers: { "Content-Type": "application/json" },
  });
});
