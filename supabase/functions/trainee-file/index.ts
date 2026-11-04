// trainee-file: hosted job match file / application proof file pages. Logic and tests: ./handler.ts, tests/architect/file-page.test.ts.
// Deployed with verify_jwt = false: the handler signs people in itself (phone code or Telegram), never by the link alone. Supabase serves an
// edge function's HTML as text/plain on its own domain, so people open it through the site's /file rewrite (api/file.js).
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { buildFileDeps } from "./deps.ts";
import { handleFile } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("not configured", { status: 503 });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleFile(req, buildFileDeps(admin, Deno.env, Date.now));
});
