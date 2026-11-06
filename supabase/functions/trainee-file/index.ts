// trainee-file: hosted job match file / application proof file pages. Logic and tests: ./handler.ts, tests/architect/file-page.test.ts.
// Deployed with verify_jwt = false: the handler signs people in itself (phone code or Telegram), never by the link alone. Supabase serves an
// edge function's HTML as text/plain on its own domain, so people open it through the site's /file rewrite (api/file.js). The gateway also
// puts its own `default-src 'none'; sandbox` policy on the answer, so the page's policy rides x-trainee-csp to the proxy (../_shared/page_csp.ts).
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { buildFileDeps } from "./deps.ts";
import { handleFile } from "./handler.ts";
import { relayPageCsp } from "../_shared/page_csp.ts";

serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("not configured", { status: 503, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return relayPageCsp(await handleFile(req, buildFileDeps(admin, Deno.env, Date.now)));
});
