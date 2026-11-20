// D-072 (files reachable), through the REAL agent-chat handler on Postgres 16 (handler-career.ts handleChat on tests/flow: real
// supabase-js over the PostgREST double, every migration), the staged brain served, and a scripted $0 model on the Anthropic wire.
// One synthetic TEST person whose records are in the real tables the File server reads (career_watch_kv, career_apply_questions,
// career_interviews, career_digest_prefs, career_events, agent_flow_state offers, career_search_plans, career_material_versions,
// career_outreach_drafts). For each record-backed family, the person asks for it in their own words; the turn must route to the
// brain, make the File with open_record_file, and carry its link (minted by code); the link is then opened through the deployed
// File server's own dependencies (trainee-file/deps.ts buildFileDeps over the same database) with a signed-in session, and the
// page must hold the records the reply names. A second person with no records gets no File for a family with nothing on record.
// Prints: FILES REACHABLE PG: families F, routed R/F, made M/F, link opens O/M, records held H/H. Nothing is sent: fetch to any
// host but the database double and the model wire throws.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/files-reachable-d072-pg.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { familyAskOf, FAMILY_BY_NAME, type MadeFamily } from "../../supabase/functions/_shared/file_family_make.ts";
import { FAMILY_FILE_TOOL } from "../../supabase/functions/_shared/agent/file_family_tool.ts";
import { messageOf, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { fakePhone, sessionFor } from "./file-session-fakes.ts";

const CI = Deno.env.get("CI") === "true";
const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };
const BASE = "https://trainee.example/file", SECRET = "TEST-d072-files-reachable-link-secret-0123456789";
const ENVK: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeTestBot" };
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0721", EMPTY = "7b0f8f8e-6a43-4a49-9d2c-0000000d0722";

// The asks (the person's words) and the records each page must hold (from the rows seeded below).
const CASES: { family: MadeFamily; ask: string; holds: string[] }[] = [
  { family: "F-01", ask: "show me my career brief", holds: ["Analyst roles at Evercore"] },
  { family: "F-02", ask: "show me my profile facts", holds: ["New York", "No staffing agencies"] },
  { family: "F-04", ask: "show me my search plan", holds: ["Climate operations search", "US remote only"] },
  { family: "F-07", ask: "open my materials page", holds: ["the operations resume, process work first"] },
  { family: "F-08", ask: "what's in my answer library?", holds: ["Mobile", "Why Evercore?"] },
  { family: "F-12", ask: "show me the message review", holds: ["Dana Lee", "Operations roles at Example Grid Co"] },
  { family: "F-13", ask: "pull up my interview hub", holds: ["Evercore", "Dana Park"] },
  { family: "F-14", ask: "send me my weekly brief", holds: ["1 search run", "1 application approved"] },
  { family: "F-14n", ask: "show me my negotiation plan", holds: ["Evercore", "$110,000"] },
  { family: "F-15", ask: "show me my offer comparison", holds: ["$110,000", "$15,000"] },
];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const onPage = (html: string, s: string) => html.includes(s) || html.includes(esc(s)) || html.includes(s.replace(/'/g, "&#39;"));

async function seed(sql: (q: string) => Promise<string>, u: string, full: boolean) {
  const account = { epoch: 0, version: 0, paused: false, ...(full ? { stated_facts: { updated_at: "2026-11-08T12:00:00Z", facts: [
    { kind: "level", value: "Analyst", evidence: "I want analyst roles", at: "2026-11-01T10:00:00Z" },
    { kind: "geography", value: "New York", evidence: "in New York", at: "2026-11-01T10:00:00Z" },
    { kind: "target_firm", value: "Evercore", evidence: "Evercore", at: "2026-11-02T10:00:00Z" }] } } : {}) };
  await sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id) values ('${u}');
    insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', ${lit(JSON.stringify(account))}::jsonb);`);
  if (!full) return;
  const draft = { recipient: { name: "Dana Lee", firm: "Example Grid Co", title: "Operations Manager", school: "", email: "dana.lee@examplegrid.com", source: "https://examplegrid.com/team", address: "published" },
    subject: "Operations roles at Example Grid Co", body: "Hi Dana,\n\nWould you have 15 minutes for a short call about the operations team?", footer: "Ada Park\n\nIf you'd rather not hear from me, reply stop and I won't write again." };
  // deno-lint-ignore no-explicit-any
  const hash = await payloadHash(messageOf(draft as any));
  const offers = [{ offer: { company: "Evercore", role: "Analyst", base: 110000, signing: 15000, bonus: null, bonus_pct: null, city: "New York", deadline: { text: "Friday" } }, equity: null, said: "Evercore offered 110k base, 15k signing", at: Date.now() - 86400_000 }];
  const thread = crypto.randomUUID();
  await sql(`insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:standing', ${lit(JSON.stringify({ items: [{ text: "No staffing agencies", at: "2026-11-03T10:00:00Z" }] }))}::jsonb);
    insert into public.career_apply_questions (user_id, key, kind, label, type, company, state, answer, answered_at) values
      ('${u}', 'fact:phone_type', 'fact', 'Preferred phone type', 'select', null, 'answered', 'Mobile', now() - interval '6 days'),
      ('${u}', 'job:aaaaaaaaaaaaaaaa', 'essay', 'Why Evercore?', 'textarea', 'Evercore', 'answered', 'Because of its advisory focus', now() - interval '5 days');
    insert into public.career_interviews (user_id, invite_key, source, company, role, when_said, interview_date, interview_time, zone, starts_at, format, interviewers, seen_at) values
      ('${u}', encode(sha256('d072-invite'::bytea), 'hex'), 'mail', 'Evercore', 'Analyst first round', '["Thu 2pm"]'::jsonb, (now() + interval '2 days')::date, '14:00', 'America/New_York', now() + interval '2 days', 'video', '[{"name":"Dana Park","title":"Vice President"}]'::jsonb, now() - interval '1 day');
    insert into public.career_digest_prefs (user_id, enabled, day, hour, tz) values ('${u}', true, 0, 18, 'America/Chicago');
    insert into public.career_events (user_id, at, kind, subject) values ('${u}', now() - interval '1 day', 'search', 'analyst'), ('${u}', now() - interval '1 day', 'application_approved', 'Evercore');
    insert into public.agent_threads (id, user_id) values ('${thread}', '${u}');
    insert into public.agent_flow_state (thread_id, user_id, state) values ('${thread}', '${u}', ${lit(JSON.stringify({ career: { stores: { offerBenchmark: { offers } } } }))}::jsonb);
    insert into public.career_search_plans (user_id, version, title, hard, prefs, batch_cap, watch, payload_hash) values
      ('${u}', 1, 'Climate operations search', ${lit(JSON.stringify([{ k: "Work arrangement", v: "US remote only", src: { kind: "you" } }]))}::jsonb, ${lit(JSON.stringify([{ k: "Sector", v: "Grid, solar, carbon", src: { kind: "you" } }]))}::jsonb, 12, null, repeat('0', 64));
    insert into public.career_material_versions (user_id, doc_key, doc_kind, version, label, based_on, role_job_id, rid, changes, payload_hash) values
      ('${u}', 'operations-resume', 'resume', 1, 'the operations resume, process work first', 'master v6', 'job-r07', 'R-07', '[]'::jsonb, repeat('0', 64));
    insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash) values
      ('${u}', gen_random_uuid(), 1, ${lit(JSON.stringify(draft.recipient))}::jsonb, '${draft.recipient.email}', ${lit(draft.subject)}, ${lit(draft.body)}, ${lit(draft.footer)}, '${hash}');`);
}

// The scripted brain on the Anthropic wire (chat-completions shape, as the other handler tests): with tools offered and no tool result
// yet, it calls open_record_file with the family the person's ask names; after the result it says what the File holds, from the
// result's own holds, or that it could not be made. It never writes a link. Any other call (no tools) answers nothing.
// deno-lint-ignore no-explicit-any
function scripted(b: any, seen: { tools: string[] }): Response {
  const done = (content: string) => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
  // deno-lint-ignore no-explicit-any
  const tools: string[] = (b.tools ?? []).map((t: any) => t.function?.name);
  if (!tools.length) return done("");
  seen.tools = tools;
  // deno-lint-ignore no-explicit-any
  const msgs: any[] = b.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const toolMsg = [...msgs].reverse().find((m) => m.role === "tool");
  const fam = familyAskOf(typeof lastUser?.content === "string" ? lastUser.content : "");
  if (!toolMsg && fam && tools.includes(FAMILY_FILE_TOOL)) {
    const name = Object.entries(FAMILY_BY_NAME).find(([, v]) => v === fam)![0];
    return Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: FAMILY_FILE_TOOL, arguments: JSON.stringify({ family: name }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
  }
  if (toolMsg) {
    const c = String(toolMsg.content ?? "");
    if (c.startsWith("ERROR:")) return done(`I couldn't make that File: ${c.replace(/^ERROR:\s*(?:not made:\s*)?/, "")}.`);
    const r = JSON.parse(c);
    return done(`Your ${r.title} holds: ${r.holds.join("; ")}.`);
  }
  return done("I can help with that.");
}

Deno.test({
  name: "FILES REACHABLE PG: each record-backed File family from its ask, through the real agent-chat handler, opened through the deployed File server's deps",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "MODEL_BUDGET_PAUSED",
      "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_SEND_RAIL", "CAREER_MAIL_TRACKING", ...Object.keys(ENVK)];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error, realLog = console.log;
    try {
      await supabaseParity(pg);
      const sql = (q: string) => pg.sql(q);
      await seed(sql, U, true);
      await seed(sql, EMPTY, false);
      h = await careerHandler(pg, { "d072-full": U, "d072-empty": EMPTY });
      const viaDouble = globalThis.fetch, outbound: string[] = [], seen = { tools: [] as string[] };
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as string, init);
        const u = new URL(req.url);
        // deno-lint-ignore no-explicit-any
        if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => scripted(b, seen));
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      console.log = (...a: unknown[]) => { if (typeof a[0] === "string" && a[0].startsWith("{\"evt\"")) return; realLog(...a); };
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      Deno.env.set("CAREER_MAIL_TRACKING", "off");
      for (const [k, v] of Object.entries(ENVK)) Deno.env.set(k, v);
      // deno-lint-ignore no-explicit-any
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
      const env = { get: (k: string) => Deno.env.get(k) };
      // The deployed File server's dependencies over the same database. The one seam: the account's confirmed phone (Supabase Auth's
      // admin API, which the database double does not serve) is the test person's, as a phone sign-in would have bound it.
      const PHONE = "+15125550721";
      const deps = { ...buildFileDeps(admin, env, Date.now), phone: fakePhone({ [U]: PHONE }).auth };
      const sessions = supabaseSessionStore(admin);
      const linkOf = (body: unknown) => (JSON.stringify(body).match(/https:\/\/trainee\.example\/file\?t=[A-Za-z0-9._-]+/g) ?? [])[0] ?? null;
      const sum = { families: 0, routed: 0, made: 0, opens: 0, held: 0, holds: 0 };
      const fails: string[] = [];
      for (const c of CASES) {
        await sql(`delete from public.agent_rate_limits`);
        sum.families++;
        const r = await h.chat("d072-full").say(c.ask, { channel: "imessage" });
        // The brain answered (it is the only path that offers open_record_file), and its call made the File.
        const calls = (r.body?.meta?.tool_calls ?? []) as { name: string; ok: boolean }[];
        const routed = seen.tools.includes(FAMILY_FILE_TOOL) && r.body?.meta?.brain === "staged" && calls.some((x) => x.name === FAMILY_FILE_TOOL && x.ok);
        seen.tools = [];
        if (routed) sum.routed++;
        const link = linkOf(r.body);
        if (!link) { fails.push(`${c.family} "${c.ask}": no File link. [${r.intent}] ${r.reply.slice(0, 300)}`); continue; }
        sum.made++;
        if (/https?:\/\//.test(r.reply.replace(link, ""))) fails.push(`${c.family}: a link in the reply that is not the File's`);
        const t = await verifyFileToken(new URL(link).searchParams.get("t"), SECRET, Date.now());
        if (!t.ok || t.claims.u !== U) { fails.push(`${c.family}: link token ${t.ok ? "for another person" : t.why}`); continue; }
        const signIn = await handleFile(new Request(link, { headers: { origin: new URL(BASE).origin } }), deps);
        const sid = await sessionFor(sessions, { userId: U, list: t.claims.r, now: Date.now(), phone: PHONE });
        const page = await handleFile(new Request(BASE, { headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin } }), deps);
        const html = await page.text();
        if (signIn.status !== 303 || page.status !== 200) { fails.push(`${c.family}: link ${signIn.status}, page ${page.status}: ${html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`); continue; }
        sum.opens++;
        for (const s of c.holds) {
          sum.holds++;
          if (r.reply.includes(s) && onPage(html, s)) sum.held++;
          else fails.push(`${c.family}: "${s}" reply ${r.reply.includes(s)} page ${onPage(html, s)}; reply: ${r.reply.slice(0, 300)}`);
        }
      }
      // A person with nothing on record: no File for a family with nothing to show; the reply says so.
      const none = await h.chat("d072-empty").say("show me my offer comparison", { channel: "imessage" });
      const noneLink = linkOf(none.body);
      const rows = Number((await sql(`select count(*) from public.career_watch_kv where user_id = '${EMPTY}' and key like 'tf:file:%'`)).trim());
      for (const f of fails) realLog(`--- MISMATCH ${f}`);
      const line = `FILES REACHABLE PG: families ${sum.families}, routed ${sum.routed}/${sum.families}, made ${sum.made}/${sum.families}, link opens ${sum.opens}/${sum.made}, records held ${sum.held}/${sum.holds}; no records: ${noneLink ? "a File was made" : "no File made"} (${rows} rows)`;
      realLog(line);
      assertNode.deepEqual(outbound, [], "no request left but the database double and the model wire");
      assertNode.equal(noneLink, null, `no hollow File: ${none.reply}`);
      assertNode.equal(rows, 0, "no File record for the person with nothing on record");
      assertNode.ok(/couldn't make that File/.test(none.reply), `the reply says nothing was made: ${none.reply}`);
      assertNode.equal(Number((await sql(`select count(*) from public.career_outreach_drafts where status <> 'shown'`)).trim()), 0, "nothing approved or sent");
      assertNode.ok(fails.length === 0 && sum.made === sum.families && sum.opens === sum.made && sum.held === sum.holds && sum.routed === sum.families, line);
    } finally {
      console.error = realError;
      console.log = realLog;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
