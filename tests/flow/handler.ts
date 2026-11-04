// The production agent-chat career handler (supabase/functions/agent-chat/handler-career.ts handleChat), run unchanged
// on the flow harness's real Postgres, with the real supabase-js client: the only seam is the HTTP hop to the Supabase
// project, answered by tests/flow/postgrest.ts over the same database. A person's turn is the request their app makes
// (POST with their bearer token); every read and write the handler makes goes to the database as that person or as the
// service role, exactly as in production.
//
// Supabase parity (setup, not the person acting): the chat tables the stubs create before their default grants
// (profiles, agent_threads, agent_messages) get the platform's grants and owner-only row security.
//
// supabase-js is imported by the handler from esm.sh. Where esm.sh is unreachable (this sandbox), run with
// --import-map=tests/flow/supabase-npm.json: the same library and version from npm.
import type { Pg } from "./pg.ts";
import { type Double, postgrestDouble } from "./postgrest.ts";

export const SUPABASE_URL = "http://supabase.test";
export const SERVICE_KEY = "service-test-key", ANON_KEY = "anon-test-key";

export async function supabaseParity(pg: Pg) {
  await pg.sql(`grant select, insert, update on public.profiles, public.agent_threads, public.agent_messages to authenticated, service_role;
    grant usage, select on all sequences in schema public to authenticated, service_role;
    alter table public.profiles enable row level security;
    alter table public.agent_threads enable row level security;
    alter table public.agent_messages enable row level security;
    create policy parity_own_profile on public.profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());
    create policy parity_own_threads on public.agent_threads for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
    create policy parity_own_messages on public.agent_messages for all to authenticated
      using (exists (select from public.agent_threads t where t.id = thread_id and t.user_id = auth.uid()))
      with check (exists (select from public.agent_threads t where t.id = thread_id and t.user_id = auth.uid()));`);
}

export interface Turn { status: number; reply: string; intent: string | null; resultStatus: string | null; body: any }
export interface Chat { say(message: string, extra?: Record<string, unknown>): Promise<Turn>; thread(): string | null; double: Double }

// The handler, loaded once per process with fetch pointed at the double.
let loaded: Promise<(req: Request) => Promise<Response>> | null = null;
let envCleanupArmed = false;
export async function careerHandler(pg: Pg, people: Record<string, string>) {
  const users: Record<string, { id: string; email: string }> = {};
  for (const [token, id] of Object.entries(people)) users[token] = { id, email: `${id}@example.test` };
  const double = postgrestDouble(pg, { url: SUPABASE_URL, serviceKey: SERVICE_KEY, users });
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  // The environment is shared by every test file in the run. A project URL and key left behind point the model budget's gate
  // at a double that is gone, and the gate then (rightly) refuses every paid call in a later file. Clear them when this file ends.
  if (!envCleanupArmed) {
    envCleanupArmed = true;
    globalThis.addEventListener("unload", () => { for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) Deno.env.delete(k); });
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = double.fetch as typeof fetch;
  loaded ??= import("../../supabase/functions/agent-chat/handler-career.ts").then((m) => m.handleChat);
  const handleChat = await loaded;
  return {
    double,
    restore: () => { globalThis.fetch = realFetch; },
    // One person's conversation in one thread, as their app sends it.
    chat(token: string): Chat {
      let thread: string | null = null;
      return {
        double,
        thread: () => thread,
        async say(message: string, extra: Record<string, unknown> = {}) {
          const res = await handleChat(new Request(`${SUPABASE_URL}/functions/v1/agent-chat`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://localhost" },
            body: JSON.stringify({ message, ...(thread ? { thread_id: thread } : {}), ...extra }),
          }));
          const body = await res.json().catch(() => ({}));
          if (body?.thread_id) thread = body.thread_id;
          return { status: res.status, reply: String(body?.reply ?? ""), intent: body?.meta?.intent ?? null, resultStatus: body?.meta?.result_status ?? null, body };
        },
      };
    },
  };
}
