// trainee-report: the stable link to a research report. Logic and tests: ./handler.ts, tests/edge/research-reply.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { artifactReportStore } from "../_shared/research_report_store.ts";
import { handleReport } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("Not found", { status: 404 });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleReport(req, { env: Deno.env, store: () => artifactReportStore(admin) });
});
