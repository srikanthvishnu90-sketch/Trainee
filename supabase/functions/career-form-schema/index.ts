// career-form-schema (WO-121): the scheduled form-capture lane. Logic and its tests: ./handler.ts,
// tests/architect/wo-121-form-lane.test.ts; the table and its functions: supabase/migrations/20261107100000_career_posting_forms.sql.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { type FormRow, handleFormSchema, type TodoRow } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleFormSchema(req, {
    env: Deno.env, now: Date.now, fetch,
    db: () => ({
      async todo(since: string, limit: number): Promise<TodoRow[]> {
        const { data, error } = await admin.rpc("career_posting_forms_todo", { p_since: since, p_limit: limit });
        if (error) throw new Error(`career_posting_forms_todo: ${error.message}`);
        return (data ?? []) as TodoRow[];
      },
      async put(rows: FormRow[]): Promise<number> {
        const { data, error } = await admin.rpc("career_posting_forms_put", { p_rows: rows });
        if (error) throw new Error(`career_posting_forms_put: ${error.message}`);
        return Number(data ?? 0);
      },
    }),
  });
});
