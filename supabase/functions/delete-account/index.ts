// delete-account: real auth-account deletion (beta 2026-09-24).
// Verifies the caller's JWT, then deletes their account (_shared/account_delete.ts): every Google grant revoked at Google
// first (ERASE SCENARIOS ROUND 2, 2026-10-30: it never was, so the grant outlived the account at Google), the connection
// rows (cancelling what waited to be sent), the Vault secrets, the saved resume files, the rows with no cascade, the action
// ledger, then the auth user (app-table rows cascade from auth.users), read back. The answer says only what the read-back
// shows: {deleted, google, outlook, failures, message}, with HTTP 200 when the account is gone and 502 when it is not.
// The client wipes app data first for immediacy; this removes the account itself so the user cannot sign back in.
// x-audit (2026-11-10): only on { confirm: "DELETE", user_id } for the signed-in account (handler.ts); else 400, nothing deleted.
// Not deployed by Trainee's go-live (scripts/launch/trainee-go-live.sh UPMORE_ONLY_FNS): the owner deploys it.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { deleteAccount, deletionWords, restDeps } from "../_shared/account_delete.ts";
import { handleDeleteAccount } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The HTTP step (method, JWT, the explicit confirmation for this account, the answer) is handler.ts.
serve((req: Request) => handleDeleteAccount(req, {
  async userOf(jwt) {
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` } });
    if (!meRes.ok) return null;
    const me = await meRes.json();
    return typeof me?.id === "string" && me.id ? me.id : null;
  },
  // Billing round 2: a live Trainee plan is cancelled at Stripe first; unconfirmed, nothing is deleted (account_delete.ts).
  deleteAccount: (uid) => deleteAccount(restDeps(SUPABASE_URL, SERVICE_KEY, fetch, { billing: { stripeKey: Deno.env.get("STRIPE_SECRET_KEY") } }), uid),
  words: deletionWords,
}));
