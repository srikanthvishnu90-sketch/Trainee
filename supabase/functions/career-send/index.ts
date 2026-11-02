// career-send (mass networking, lane M1): logic in ./handler.ts and _shared/career_send_rail.ts; tests in
// tests/architect/send-rail*.test.ts and tests/db/career_send_queue.test.sql.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { careerTokenFor, type TokenDeps } from "../_shared/career_mail_gmail.ts";
import { supabaseOutreachStore } from "../_shared/career_outreach.ts";
import { handleSend } from "./handler.ts";
import { vaultRefreshWrite } from "../_shared/oauth_vault_refresh.ts";

// The career Google grant (vault oauth_google_career_<uid>), read the same way as mail tracking and outreach.
const grant = (admin: any): TokenDeps => ({
  env: Deno.env, fetch, now: Date.now,
  connection: async (u) => {
    const { data, error } = await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career").maybeSingle();
    if (error) throw new Error(`read the career grant: ${error.message}`);
    return data ?? null;
  },
  readVault: async (name) => {
    const { data, error } = await admin.rpc("oauth_vault_read", { p_name: name });
    if (error) throw new Error("read the career grant's vault entry");
    return data ? String(data) : null;
  },
  writeVault: (name, secret) => vaultRefreshWrite(admin, name, secret, "save the refreshed career grant"),
});

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const deps = grant(admin);
  const outreach = supabaseOutreachStore(admin);
  return handleSend(req, {
    env: Deno.env, now: Date.now,
    rail: () => ({
      rpc: (name, args) => admin.rpc(name, args),
      fetch,
      token: (u, scope) => careerTokenFor(deps, scope)(u),
      drafts: (u, ids) => outreach.drafts!(u, ids),
    }),
  });
});
