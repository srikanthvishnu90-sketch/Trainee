// Release item 9 (profile and memory) loop: docs/architect/VERIFICATION-15.md item 9, D-007 (facts only from what the
// person confirmed), spec APP-LAYER-15-FIXES E.3 28-29 (sensitive answers are the person's own, asked per application).
// Multi-session transcripts replayed through the REAL handler (handler-career.ts handleChat on tests/flow: real supabase-js
// over the PostgREST double, Postgres 16 with every migration), CAREER_ACCOUNT_MEMORY on, the staged brain released and a
// scripted model on the Anthropic wire ($0). Each persona states facts in one thread, corrects some in a LATER thread, and is
// then asked "what do you know about me?" in a NEW thread:
//
//   invented           a fact value in the readback that the person never said                        bar: 0
//   unevidenced        a stated fact on the account without its fact_confirmed event                   bar: 0
//   corrections_kept   corrected facts whose NEW value is read back and whose OLD value is not        bar: 100%
//   recalled           stated (latest) facts read back in the new thread                              reported
//   searched_a_fact    a statement about the person (no search word) answered with a job search          bar: 0
//   sensitive_defaulted  an application review answering a sensitive question (sponsorship, work
//                      authorization, graduation date ...) the person never answered                  bar: 0
//
// Run: deno test -A --no-check tests/architect/loop-09-memory.test.ts (Postgres 16; LOOP_OUT=<dir> keeps the transcripts).
// Nothing is applied for, queued or sent.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { type LoopCase, reportLoop } from "./helpers/loop_report.ts";
import { reviewOf } from "../../supabase/functions/_shared/application_review.ts";

const CI = Deno.env.get("CI") === "true";

// One fact the readback must hold: `now` its latest words, `old` a value it replaced (never read back after the correction).
interface Expect { label: string; now: RegExp; old?: RegExp }
// A persona: sessions (each a NEW thread), each a list of the person's messages; then what must be known.
interface Persona { id: string; sessions: string[][]; expect: Expect[]; never?: RegExp[] }
const PERSONAS: Persona[] = [
  { id: "year-major-school", sessions: [["I'm a junior majoring in statistics"], ["I go to Northwestern University"], ["Actually I'm a senior now, not a junior"]],
    expect: [{ label: "year", now: /\bsenior\b/i, old: /\bjunior\b/i }, { label: "major", now: /statistics/i }, { label: "school", now: /Northwestern/i }] },
  { id: "graduation", sessions: [["I graduate in May 2027"], ["Correction: I graduate in December 2026, not May 2027"]],
    expect: [{ label: "graduation", now: /December 2026|Dec(?:ember)? 2026/i, old: /May 2027/i }] },
  { id: "sponsorship", sessions: [["I will need visa sponsorship"], ["Actually I don't need visa sponsorship. I'm a US citizen."]],
    expect: [{ label: "sponsorship", now: /(?:no|not|don['’]t)[^.\n]{0,30}sponsorship|sponsorship[^.\n]{0,20}\bno\b|citizen/i, old: /(?<!don['’]t |not |no )need(?:s)? (?:visa )?sponsorship(?![^.\n]{0,10}\bno\b)/i }] },
  { id: "city", sessions: [["I live in Chicago"], ["I moved, I live in Austin now"]],
    expect: [{ label: "city", now: /Austin/i, old: /Chicago/i }] },
  // A role or firm said to the model (not the router) is the model's to record; the scripted model here records nothing,
  // so those turns measure the script, not the product. The router-held facts are corrected here.
  { id: "school-transfer", sessions: [["I go to Northwestern University"], ["Actually I transferred, I go to Purdue University now"]],
    expect: [{ label: "school", now: /Purdue/i, old: /Northwestern/i }] },
  { id: "city-says-no-search", sessions: [["I'm based in Seattle"]], expect: [{ label: "city", now: /Seattle/i }] },
  // A search request is not a statement about the person: nothing about them is recorded from it.
  { id: "search-is-not-a-fact", sessions: [["Find data analyst internships in Seattle"]], expect: [], never: [/\b(junior|senior|sophomore|freshman)\b/i, /you live in|based in Seattle/i, /sponsorship/i] },
  { id: "major-switch", sessions: [["I'm a sophomore majoring in economics"], ["I switched my major to computer science"]],
    expect: [{ label: "major", now: /computer science/i, old: /economics/i }, { label: "year", now: /sophomore/i }] },
  { id: "no-facts", sessions: [["hi"]], expect: [], never: [/\b(junior|senior|sophomore|freshman)\b/i, /majoring|major in/i, /sponsorship/i, /graduat\w+ (?:in|on) \w+ \d{4}/i] },
  { id: "stable", sessions: [["I'm a senior majoring in finance"], ["what does my tracker look like"], ["thanks"]],
    expect: [{ label: "year", now: /\bsenior\b/i }, { label: "major", now: /finance/i }] },
];

// Values that could be invented: any of these in a readback is checked against what the person said.
const VOCAB = ["freshman", "sophomore", "junior", "senior", "statistics", "economics", "finance", "computer science", "Northwestern", "Stanford", "Harvard",
  "Chicago", "Austin", "Seattle", "New York", "data analyst", "product manager", "software engineer", "Purdue", "May 2027", "December 2026", "sponsorship", "citizen"];

function scorePersona(p: Persona, said: string[], reply: string) {
  const faults: string[] = [];
  const n = { facts: p.expect.length, recalled: 0, corrections: 0, corrections_kept: 0, invented: 0 };
  const all = said.join("\n").toLowerCase();
  for (const v of VOCAB) if (new RegExp(`\\b${v}\\b`, "i").test(reply) && !all.includes(v.toLowerCase())) { n.invented++; faults.push(`invented: "${v}" was never said`); }
  for (const never of p.never ?? []) if (never.test(reply)) { n.invented++; faults.push(`invented: ${never} with nothing said`); }
  for (const e of p.expect) {
    const has = e.now.test(reply);
    if (has) n.recalled++; else faults.push(`not recalled: ${e.label}`);
    if (e.old) {
      n.corrections++;
      // The old value may appear only as what it replaced ("not junior", "was May 2027").
      const stale = e.old.test(reply.replace(/\b(?:not|no longer|was|previously|instead of|replaced)\s+(?:an?\s+|a\s+)?[\w ]{0,20}/gi, ""));
      if (has && !stale) n.corrections_kept++; else faults.push(`correction not kept: ${e.label}${stale ? " (old value still read back)" : ""}`);
    }
  }
  return { n, faults };
}

Deno.test("loop 9 scorer: inventions and lost corrections are caught", () => {
  const p = PERSONAS[1];
  assertNode.equal(scorePersona(p, ["I graduate in May 2027", "Correction: I graduate in December 2026"], "You graduate in December 2026.").n.corrections_kept, 1);
  const bad = scorePersona(p, ["I graduate in May 2027", "Correction: I graduate in December 2026"], "You graduate in May 2027. You're a junior.");
  assertNode.equal(bad.n.corrections_kept, 0); assertNode.equal(bad.n.invented, 1);
});

Deno.test("loop 9 sensitive: an application review never answers a sensitive question the person did not answer", () => {
  // The same employer form, the person's answers: none, then their own. A blank sensitive answer stays a question for that
  // employer; the person's own answer is shown as theirs; one employer's answer is never another's.
  const form = (vals: Record<string, unknown>) => ({ id: "a1", payload_hash: "h".repeat(64), payload: { company: "TEST Acme", job_id: "greenhouse:acme:1", url: "https://boards.greenhouse.io/acme/jobs/1",
    fields: [{ label: "Will you now or in the future require visa sponsorship?", value: vals.sp ?? null, required: true }, { label: "Are you legally authorized to work in the United States?", value: vals.wa ?? null, required: true },
      { label: "What is your expected graduation date?", value: vals.gd ?? null, required: true }] } });
  const blank = reviewOf(form({}) as any);
  assertNode.equal(blank.approvable, false, "never approvable with a sensitive answer missing");
  assertNode.equal(blank.answers.filter((a) => a.sensitive).length, 0, "no sensitive answer was filled in");
  assertNode.ok(blank.unresolved.length === 3 && blank.unresolved.every((u) => /For TEST Acme, the form asks/.test(u.ask)), JSON.stringify(blank.unresolved));
  const own = reviewOf(form({ sp: "No", wa: "Yes", gd: "December 2026" }) as any);
  assertNode.ok(own.answers.filter((a) => a.sensitive).length === 3, "the person's own answers are marked as theirs");
});

Deno.test({
  name: "loop 9: memory across sessions through the real handler: 0 invented facts, 100% of corrections kept",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS",
      "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL", "CAREER_APPLY_ALL_YES", "CAREER_ACCOUNT_MEMORY"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error;
    const people = Object.fromEntries(PERSONAS.map((_, i) => [`m${i}`, `9e0f8f8e-6a43-4a49-9d2c-${String(900000000000 + i)}`]));
    try {
      await supabaseParity(pg);
      const ids = Object.values(people);
      await pg.sql(`insert into auth.users (id, email) values ${ids.map((id) => `('${id}', '${id}@example.test')`).join(", ")};
        insert into public.profiles (id) values ${ids.map((id) => `('${id}')`).join(", ")};
        insert into public.career_watch_kv (user_id, key, value) values ${ids.map((id) => `('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}')`).join(", ")};`);
      Deno.env.set("CAREER_ACCOUNT_MEMORY", "on");
      h = await careerHandler(pg, people);
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "A model reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4 } }));
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const num = async (sql: string) => Number(await pg.sql(sql));
      const totals: Record<string, number> = { personas: PERSONAS.length, facts: 0, recalled: 0, corrections: 0, corrections_kept: 0, invented: 0, unevidenced: 0, searched_a_fact: 0 };
      const cases: LoopCase[] = [];
      for (const [i, p] of PERSONAS.entries()) {
        const said: string[] = [], log: string[] = [], faults: string[] = [];
        for (const session of p.sessions) {
          const c = h.chat(`m${i}`);
          for (const m of session) {
            await pg.sql(`delete from public.agent_rate_limits`);
            const r = await c.say(m);
            assertNode.equal(r.status, 200, r.reply);
            said.push(m); log.push(`> ${m}\n${r.reply}`);
            if (!/\b(?:find|search|show|jobs?|roles?|internships?)\b/i.test(m) && /^I checked .+ on the live board/m.test(r.reply)) { totals.searched_a_fact++; faults.push(`searched a fact statement: ${m}`); }
          }
        }
        await pg.sql(`delete from public.agent_rate_limits`);
        const probe = await h.chat(`m${i}`).say("what do you know about me?");
        log.push(`> what do you know about me? (new thread)\n${probe.reply}`);
        const s = scorePersona(p, said, probe.reply);
        s.faults.unshift(...faults);
        // Every stated fact on the account carries its fact_confirmed event (D-007 provenance).
        const acct = JSON.parse(await pg.sql(`select coalesce(value, 'null') from public.career_watch_kv where user_id = '${people[`m${i}`]}' and key = 'career:account'`) || "null");
        const stated = (acct?.stated_facts?.facts ?? []) as any[];
        const unev = stated.filter((f) => !f.confirmation_event_id).length;
        const evIds = new Set(JSON.parse(await pg.sql(`select coalesce(json_agg(detail->>'confirmation_event_id'), '[]') from public.career_events where user_id = '${people[`m${i}`]}' and kind = 'fact_confirmed'`)));
        const orphan = stated.filter((f) => f.confirmation_event_id && !evIds.has(f.confirmation_event_id)).length;
        if (unev + orphan) s.faults.push(`${unev + orphan} stated fact(s) without a recorded event: ${JSON.stringify(stated.filter((f) => !f.confirmation_event_id || !evIds.has(f.confirmation_event_id)))}`);
        for (const [k, v] of Object.entries(s.n)) if (k !== "facts") totals[k] += v;
        totals.facts += s.n.facts; totals.unevidenced += unev + orphan;
        cases.push({ id: p.id, asked: said.join(" | "), reply: log.join("\n\n"), intent: probe.intent, faults: s.faults });
      }
      const kept = totals.corrections ? Math.round(100 * totals.corrections_kept / totals.corrections) : 100;
      const recall = totals.facts ? Math.round(100 * totals.recalled / totals.facts) : 100;
      const pass = totals.invented === 0 && totals.unevidenced === 0 && kept === 100 && totals.searched_a_fact === 0;
      await reportLoop({ item: 9, name: "memory", numbers: { ...totals, corrections_kept_pct: kept, recall_pct: recall }, bar: "invented == 0 && unevidenced == 0 && corrections_kept_pct == 100 && searched_a_fact == 0", pass, cases });
      assertNode.equal(await num(`select count(*) from public.career_apply_jobs`), 0, "nothing applied for");
      assertNode.deepStrictEqual(outbound, []);
      assertNode.equal(totals.invented, 0, "0 invented facts");
      assertNode.equal(totals.unevidenced, 0, "every stated fact has its event");
      assertNode.equal(kept, 100, "100% of corrections kept");
      assertNode.equal(totals.searched_a_fact, 0, "a statement about the person is not a job search");
    } finally {
      console.error = realError;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
