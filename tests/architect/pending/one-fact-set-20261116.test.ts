// MASS APPLY CONVERSATIONS (2026-11-16): preparation and send read ONE trusted fact set, career_apply_profile_for (its
// confirmed-resume filter included). Before, the send's readers (engine_input.ts restEngineInputSource and the bridge's
// career_apply_message_cloud_sources) read the raw stored profile, so a fact the filter dropped at preparation was used at the
// send and the approved application was refused as changed. Here: the send's reader asks that function and nothing else, and
// a fact it drops never reaches the engine's facts; on a real database the bridge's snapshot profile IS that function's.
import assertNode from "node:assert/strict";
import { readEngineInput, restEngineInputSource } from "../../../workers/career-cloud/engine_input.ts";
import { pgBinDir, startPg } from "../../flow/pg.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const OWNER = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
Deno.test("the send's reader is career_apply_profile_for: a fact it filtered out is never in the engine's facts", async () => {
  const seen: string[] = [];
  const kept = { id: "F-keep", text: "Kept", status: "confirmed", needs_confirmation: false };
  const fetch = (async (input: RequestInfo | URL) => {
    const u = String(input); seen.push(u.replace(/^https:\/\/x\.test\/rest\/v1\//, "").split("?")[0]);
    if (u.includes("/rpc/career_apply_profile_for")) return new Response(JSON.stringify({ user_id: OWNER, facts: [kept] }));
    if (u.includes("/agent_flow_state")) return new Response(JSON.stringify([{ state: { career: { stores: { profile: { facts: [kept, { id: "F-dropped", text: "Dropped by the filter" }] } } } } }]));
    return new Response("[]");
  }) as typeof fetch;
  const r = await readEngineInput(restEngineInputSource({ url: "https://x.test", key: "k", fetch }), OWNER);
  eq(r.facts.facts.map((f: any) => f.id), ["F-keep"]);
  eq(seen.includes("agent_flow_state"), false, "the raw stored profile is never read");
});
Deno.test({ name: "on a database: the bridge's source snapshot profile is career_apply_profile_for's", ignore: !pgBinDir(), fn: async () => {
  const pg = await startPg({ includeBridge: true });
  try {
    const u = "7b0f8f8e-6a43-4a49-9d2c-0000000002b2";
    // The one-resume rule on (CAREER_ONE_RESUME), so career_apply_profile_for's confirmed-record filter applies.
    await pg.sql(`insert into public.career_resume_settings (key, value) values ('CAREER_ONE_RESUME', 'on') on conflict (key) do update set value = 'on'`);
    await pg.sql(`insert into auth.users (id, email) values ('${u}', 'p@example.test'); insert into public.profiles (id) values ('${u}');
      insert into public.agent_threads (id, user_id) values ('aaaaaaaa-0000-4000-8000-000000000001', '${u}');
      insert into public.agent_flow_state (user_id, thread_id, state) values ('${u}', 'aaaaaaaa-0000-4000-8000-000000000001',
        '{"career":{"stores":{"profile":{"facts":[{"id":"F-1","kind":"experience","text":"x","source_ref":{"upload_sha256":"${"b".repeat(64)}"}},{"id":"F-2","kind":"profile","name":"Country","value":"US","text":"Country: US"}]}}}}');`);
    const same = (await pg.sql(`select (public.career_apply_message_cloud_sources('${u}')->'profile') is not distinct from public.career_apply_profile_for('${u}')`)).trim();
    eq(same, "t");
    // The case that matters: the raw stored profile holds F-1 (its upload is not their confirmed resume record), the one
    // fact set drops it, and so must the bridge's snapshot (before 20261116120000 it kept it).
    const ids = (q: string) => pg.sql(`select coalesce(string_agg(f->>'id', ',' order by f->>'id'), '') from jsonb_array_elements(coalesce((${q})->'facts', '[]'::jsonb)) f`).then((x) => x.trim());
    eq(await ids(`public.career_apply_profile_for('${u}')`), "F-2", "the one fact set drops a fact whose upload is not the confirmed record");
    eq(await ids(`public.career_apply_message_cloud_sources('${u}')->'profile'`), "F-2", "the bridge's snapshot drops it too");
  } finally { await pg.stop(); }
} });
