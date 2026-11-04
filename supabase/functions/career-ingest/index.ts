// career-ingest (WO-006): the scheduled job-ingestion run. Logic and its tests: ./handler.ts, tests/edge/career-ingest.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { boardFetchFeed, supabasePostingsDb } from "../_shared/career_ingest.ts";
import { supabaseBoardState } from "../_shared/career_shards.ts";
import { handleIngest } from "./handler.ts";
import boards from "./boards.json" with { type: "json" };

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleIngest(req, {
    env: Deno.env, boards, now: Date.now,
    db: () => supabasePostingsDb(admin),
    state: () => supabaseBoardState(admin), // WO-037: sharded, every board within 6 hours
    // Feature 6: a body equal to the board's last full read is not parsed again (most of a read's CPU).
    fetchFeed: (userAgent) => boardFetchFeed(fetch, { userAgent, bodyHash: true }),
  });
});
