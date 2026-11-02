// delete-account: real auth-account deletion (beta 2026-09-24).
// Verifies the caller's JWT, then deletes their account (_shared/account_delete.ts): every Google grant revoked at Google
// first (ERASE SCENARIOS ROUND 2, 2026-10-30: it never was, so the grant outlived the account at Google), the connection
// rows (cancelling what waited to be sent), the Vault secrets, the saved resume files, the rows with no cascade, the action
// ledger, then the auth user (app-table rows cascade from auth.users), read back. The answer says only what the read-back
// shows: {deleted, google, outlook, failures, message}, with HTTP 200 when the account is gone and 502 when it is not.
// The client wipes app data first for immediacy; this removes the account itself so the user cannot sign back in.
// Not deployed by Trainee's go-live (scripts/launch/trainee-go-live.sh UPMORE_ONLY_FNS): the owner deploys it.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { deleteAccount, deletionWords, restDeps } from "../_shared/account_delete.ts";

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
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  if (body.confirm && String(body.confirm).toUpperCase() !== "DELETE") {
    return new Response("confirmation mismatch", { status: 400 });
  }

  // Billing round 2: a live Trainee plan is cancelled at Stripe first; unconfirmed, nothing is deleted (account_delete.ts).
  const r = await deleteAccount(restDeps(SUPABASE_URL, SERVICE_KEY, fetch, { billing: { stripeKey: Deno.env.get("STRIPE_SECRET_KEY") } }), uid);
  return new Response(JSON.stringify({
    deleted: r.deleted, user_id: uid, google: r.google, outlook: r.outlook, failures: r.failures, message: deletionWords(r),
  }), { status: r.deleted ? 200 : 502, headers: { "Content-Type": "application/json" } });
});
