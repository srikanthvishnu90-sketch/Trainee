// career-email-code (WO-096): the code an employer's application form just emailed the person, read from their own Gmail
// (the career grant's gmail.readonly) for an application they approved on its card, while it is being sent. The person's
// own session only (verify_jwt = true in supabase/config.toml; Supabase Auth reads the person from it). One look per
// request: the extension and the worker poll (career_email_code_poll.ts). The code is in the response body only, never
// logged or stored. Logic and tests: ../_shared/career_email_code.ts, tests/architect/wo-096-email-code.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { corsFor } from "../agent-chat/_shared/chat_cors.ts";
import { careerCodeMailbox, fetchVerificationCode, handleEmailCode } from "../_shared/career_email_code.ts";
import type { TokenDeps } from "../_shared/career_mail_gmail.ts";
import { vaultRefreshWrite } from "../_shared/oauth_vault_refresh.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cors = corsFor(req);
  if (!url || !anon || !key) {
    return new Response(
      JSON.stringify({ status: "no_google_connection", stop: "Reading the code from your email isn't on yet. Type the code on the page yourself." }),
      { status: 200, headers: { ...cors, "content-type": "application/json" } },
    );
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  // The career Google grant (vault oauth_google_career_<uid>), read as career-proactive reads it.
  const grant: TokenDeps = {
    env: Deno.env,
    fetch,
    now: Date.now,
    connection: async (u) => {
      const { data, error } = await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career")
        .maybeSingle();
      if (error) throw new Error("read the career grant");
      return data ?? null;
    },
    readVault: async (name) => {
      const { data, error } = await admin.rpc("oauth_vault_read", { p_name: name });
      if (error) throw new Error("read the career grant's vault entry");
      return data ? String(data) : null;
    },
    writeVault: (name, secret) => vaultRefreshWrite(admin, name, secret, "save the refreshed career grant"),
  };
  return handleEmailCode(req, {
    cors,
    user: async (token) => {
      const client = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
      const { data } = await client.auth.getUser(token);
      return data?.user ? { id: data.user.id } : null;
    },
    job: async (userId, id) => {
      const { data, error } = await admin.from("career_apply_jobs").select("user_id,state,lease_token,url,claimed_at").eq("id", id)
        .eq("user_id", userId).maybeSingle();
      if (error) return null;
      return data ?? null;
    },
    look: (i) => fetchVerificationCode(i, { mailbox: careerCodeMailbox(grant), now: Date.now }),
    now: Date.now,
  });
});
