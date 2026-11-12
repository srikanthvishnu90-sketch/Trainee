// D-061 mirror rulings, applied to product code (docs/architect/specs/MIRROR-RULINGS.md, G1 to G14; P3, P4, P6). $0: the readers
// and the routing are pure, and the handler half runs every migration on a throwaway Postgres 16 with a SCRIPTED model under
// production's release flags (P4: every release flag at its release value, every never-on switch off). Each check names its
// ruling; no check is keyed to a benchmark or held-out prompt's wording (P3): the messages below are this file's own.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d061-mirror-rulings-20261111.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { g1CodeAnswers, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { BOUNDARY_LINE, boundaryOf, correctionOf, hypotheticalOf } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { multiAsk, severalAsks } from "../../supabase/functions/_shared/ask_language.ts";
import { MIRROR_RULES } from "../../supabase/functions/_shared/agent/prompt.ts";
import { RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-d061", threadId: "t-d061", now: Date.UTC(2026, 10, 11, 5), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
// P4: production's configuration, as release_config.ts serves it (nothing set: each release flag at its release value).
const PROD = { get: (_k: string) => undefined };
const decide = (m: string, ctx = fresh()) => stagedDecision({ env: PROD, message: m, ctx, host, structured: false });

Deno.test("D061-G1 code answers alone only payloads, controls, bare answers, its own session, asked-for actions and own-record reads", () => {
  // Code's (a) and (b), and the actions the person asked for in their own words.
  for (const m of ["yes", "pause everything", "find me data analyst internships in Chicago", "apply to the Backend Software Engineer role at Ironstack Payments", "what's my GPA?", "show my applications"]) {
    eq(decide(m).brain, false, `${m}: ${decide(m).intent}/${decide(m).reason}`);
  }
  // The brain's, with the router's reading as data: a practice start (G12), a plan the router read as a search, a question about volume
  // the router read as the tracker.
  for (const m of ["run a mock interview with me for a product analyst role", "put together a week by week plan for consulting internships", "how many applications per week is sane during finals?"]) {
    const d = decide(m);
    eq(d.brain, true, `${m}: ${d.intent}/${d.reason}`);
  }
  // The rule by intent alone: controls and payloads always code's; a running practice session's next ask code's.
  ok(g1CodeAnswers("ok", "conversation_bare_reply", {}));
  ok(g1CodeAnswers("hypothetically, stop", "career_paused", {}), "a control is code's even inside a hypothetical");
  ok(!g1CodeAnswers("give me a practice question", "prep_mock_start", {}, fresh()), "a practice start is the brain's");
  const inSession = fresh();
  host.runTurn("quiz me on a sql question, one at a time", inSession);
  ok(g1CodeAnswers("another one", "prep_mock_start", {}, inSession), "the next ask in code's own session is code's");
  // A posting link with a question or a boundary beside it is the brain's to read; a bare "apply here <link>" stays code's.
  const WD = "https://example.wd5.myworkdayjobs.com/en-US/Careers/job/US-Remote/Data-Analyst-Intern_R0001";
  for (const m of [`is this one still taking applications? ${WD}`, `don't apply yet, just tell me what it needs ${WD}`]) eq(decide(m).brain, true, `${m}: ${decide(m).intent}/${decide(m).reason}`);
  eq(decide("apply here https://boards.greenhouse.io/example/jobs/1").brain, false, "a bare apply-here link is code's intake");
  // An action the message forbids is not asked for.
  ok(!g1CodeAnswers("what would applying to Ironstack take? don't apply", "named_role_apply", {}));
});

Deno.test("D061-G8 a hypothetical is read by its grammar, for someone else, in texting spellings and other languages; a real statement is not", () => {
  for (const [m, k] of [
    ["say im a sophomore with no projects, where do i start", "persona"], ["my roommate is a chem major with no internships, what should she do", "persona"],
    ["what would you tell someone with a 2.6 gpa who wants consulting", "persona"], ["imagine two offers, one remote and one in Denver", "situation"],
    ["what if i only applied to startups", "situation"], ["it's not real, but if i got 140k would that be low", "situation"],
    ["hipotéticamente, si me ofrecen 90k, ¿es poco?", "situation"], ["rein hypothetisch: zwei Angebote, wie wähle ich", "situation"],
    ["假如我有两个offer怎么选", "situation"],
  ] as const) eq(hypotheticalOf(m), k, m);
  for (const m of ["i'm a new grad with zero internships, how do i get interviews", "I got an offer from Acme for $120k", "find me analyst jobs in Denver"]) eq(hypotheticalOf(m), null, m);
  // G8 + G1: a hypothetical never reaches code's offer and record flows: it is the brain's, and the router's probe wrote nothing.
  const ctx = fresh();
  const d = decide("purely hypothetical: Acme offers me 133k base for a data role in Austin, should i counter", ctx);
  eq(d.brain, true, `${d.intent}/${d.reason}`);
  ok(!/133/.test(JSON.stringify(ctx)), "the probe wrote nothing to the real turn");
});

Deno.test("D061-G6 the boundary: one reader, one line", () => {
  for (const [m, b] of [["draft a note to my old manager, don't send it", "send"], ["write it up, i'll send it myself", "send"], ["draft only please", "send"],
    ["find 4 roles in Austin, don't apply to any", "submit"], ["show me the application, preview only", "submit"], ["no lo envíes todavía", "send"]] as const) eq(boundaryOf(m), b, m);
  for (const m of ["why not apply to Ramp?", "send it", "apply to the Ramp role"]) eq(boundaryOf(m), null, m);
  eq(BOUNDARY_LINE, { send: "Nothing was sent.", submit: "Nothing was submitted." });
});

Deno.test("D061-G9, G13 a correction and several asks are read; D-058's one-ask cases stay one ask", () => {
  eq(correctionOf("you said the deadline was in March but the page says April"), "trainee");
  eq(correctionOf("actually my graduation is May 2027"), "person");
  eq(correctionOf("what's the deadline?"), null);
  for (const m of ["two things: what should i fix on my resume first; and how many places have i applied to", "is it too late for fall recruiting? how long does it usually take?",
    "draft a note to my professor and also what should i ask her?"]) ok(severalAsks(m) && !multiAsk(m), m);
  for (const m of ["Two things: it has to be remote, and nothing under $35 an hour.", "find data analyst internships in Chicago, also give me exactly 3. Don't apply.", "can you help? i'm lost?"]) ok(!severalAsks(m), m);
  eq(decide("is it too late for fall recruiting? how long does it usually take?").brain, true);
});

Deno.test("D061-G2..G14 the brain's instructions name every ruling", () => {
  for (const g of ["G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14"]) ok(MIRROR_RULES.includes(`(${g})`), g);
});

Deno.test({ name: "D061-H through the real handler under production's flags: the file tool, the boundary line, the brain's notes, nothing sent", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("D061-H needs Postgres 16 in CI");
  const seen: { tools: string[]; system: string }[] = [];
  const scripted = (chat: any) => Response.json({ id: "d061", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : "scripted" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const model = async (req: Request) => {
    const body = await req.clone().json().catch(() => ({}));
    if (!body.output_config?.format) seen.push({ tools: (body.tools ?? []).map((t: any) => String(t.name)), system: JSON.stringify(body.system ?? "") });
    return await anthropicWire(req, scripted);
  };
  const w = await openWorld(3, { model });
  // Architect amendment (D-072): every variable this test changes is put back as it found it (the gate's explicit release-flag
  // "off"s included); it deleted them and never restored them, so CAREER_TEXTING_NATIVE fell to its release default (on) for every
  // later file in the same shard (flow-telegram-e2e: parse_mode HTML). The test itself still runs under production's flags.
  const touched = [...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON, "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "ANTHROPIC_API_KEY"];
  const envBefore = new Map(touched.map((k) => [k, Deno.env.get(k)]));
  try {
    // P4: no test-only switch; production serves File links (a non-routable stand-in and a TEST secret).
    for (const k of [...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON]) Deno.env.delete(k);
    Deno.env.set("TRAINEE_FILE_BASE_URL", "https://file.example.test");
    Deno.env.set("TRAINEE_FILE_LINK_SECRET", "TEST-not-real-file-link-secret-0000000000");
    Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
    const person = await w.person({ resume: true });
    // G11: a file ask reaches the brain with create_file, the reply writer still off.
    let n = seen.length;
    await person.say("make me a one-page comparison of consulting vs product analyst roles as a file I can keep");
    ok(seen.length > n, "the brain answered the file ask");
    ok(seen.slice(n).some((s) => s.tools.includes("create_file")), `create_file offered: ${seen.slice(n).map((s) => s.tools.join(",")).join(" | ")}`);
    // G6 on a brain turn: the boundary note is in the system prompt.
    n = seen.length;
    await person.say("write a short thank-you note to my interviewer Dana, don't send it");
    ok(seen.slice(n).some((s) => /THE PERSON SET A BOUNDARY/.test(s.system)), "the brain is told the boundary");
    // G6 on a code turn: a search the person asked for under "don't apply" says what was not done.
    n = seen.length;
    const r = await person.say("find me data analyst internships in Chicago, don't apply to any");
    eq(seen.length, n, "a search the person asked for is code's");
    ok(/Nothing was (?:submitted|applied)|not (?:submitted|applied)|didn'?t apply|haven'?t applied|Nothing was applied/i.test(String(r.reply)), `the boundary line: ${String(r.reply).slice(-200)}`);
    for (const t of ["career_apply_receipts", "career_apply_jobs", "career_apply_prepared", "career_outbox", "career_contact_sends"]) {
      if (!(await w.pg.sql(`select to_regclass('public.${t}') is not null`)).includes("t")) continue;
      eq((await w.pg.sql(`select count(*) from public.${t} where user_id = '${person.id}'`)).replace(/\D+/g, " ").trim().split(" ")[0], "0", `${t} has rows`);
    }
    eq(w.outbound, [], "a request left the machine");
  } finally {
    for (const [k, v] of envBefore) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    await w.close();
  }
} });
