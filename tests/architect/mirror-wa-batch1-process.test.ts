// MIRROR PROCESS, batch 1 (architect, 2026-11-11). The owner: "don't deploy until everything has matched. Trainee verifies all 26
// convos and the process for every convo being similar is the same." Beyond the reply text, Trainee follows the PROCESS Instinct
// visibly followed on each of the 26 turns of the WhatsApp benchmark (evals/mirror/instinct-wa-batch1/): the steps, the tools, the
// artifacts and the boundary line, per docs/architect/specs/MIRROR-PROCESS.md.
//
// At $0, through the real career handler (tests/architect/helpers/mirror_process.ts): every migration on a throwaway Postgres 16, a
// scripted model that records which tools code OFFERED the brain on each turn, what code put in its prompt, and the tool calls the
// process names (the script makes them; code decides what each returns and what the person sees). Every host but the database
// double is refused and recorded with its full address.
//
// EXISTS turns: their process is asserted here. Turns blocked on a capability that is OFF or MISSING are listed in BLOCKED with
// the named blocker; tests/architect/pending/mirror-process-blocked.test.ts asserts their full process and fails until each lands.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/mirror-wa-batch1-process.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "./helpers/response_world.ts";
import { type Call, effectRows, PAYPAL, runConversation, type Step, TURNS } from "./helpers/mirror_process.ts";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { POSTING_PAGE } from "./helpers/posting_checks.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

export const EXISTS = ["C2", "C3", "C5", "C5f1", "C5f2", "C7", "C8", "C12", "C13", "C14", "C15", "C17", "C18", "C21", "C21f", "C23"];
// The turns whose process needs a capability Trainee does not serve today. OFF: the code exists and a release switch keeps it off
// (`flags`, none of which release_config.ts serves on). MISSING: what has to be built or provided.
export const BLOCKED: Record<string, { status: "OFF" | "MISSING"; blocker: string; flags?: string[] }> = {
  C1: { status: "OFF", flags: ["CAREER_REPLY_WRITER"], blocker: "the plan File (plan_review kind) is made only by create_file, which the brain is offered only with the reply writer on Telegram (career_brain.ts o.shape); WhatsApp gets no File for a plan" },
  C4: { status: "OFF", flags: ["CAREER_KNOWLEDGE"], blocker: "a cited source for advice: research_career_question is offered only with CAREER_KNOWLEDGE on and the gateway's web search (model_gateway.ts WEB_SEARCH_AVAILABLE = false); research_market is market research, not resume advice" },
  C6: { status: "MISSING", blocker: "evidence from the person's email confirmations in the record reply: CAREER_MAIL_TRACKING reads one connected Gmail, the record reply (tracking_status) does not read it or separate researched roles from applications, and the benchmark persona has no Gmail" },
  C9: { status: "MISSING", blocker: "general web search for official, press and anecdotal pages with each source labelled official or anecdotal: research_market's free sources do not search forums or press, Brave runs only with the owner's BRAVE_SEARCH_API_KEY" },
  C10: { status: "MISSING", blocker: "the email at the top of the resume: Instinct used the linked account's email; tailor_resume refuses until the person types one (set_resume_contact never uses the account email), and the benchmark persona never typed one" },
  C11: { status: "MISSING", blocker: "a read-only reader of a posting's application entry flow and questions (Workday behind sign-in): questions are known only after a preparation run (career_apply_questions)" },
  C16: { status: "MISSING", blocker: "a tracker artifact (no tracker File kind in file_kinds.ts, no Sheets export) built from email confirmations; the record reply says the tracker is empty" },
  C19: { status: "OFF", flags: ["CAREER_PEOPLE_SEARCH", "CAREER_CONTACT_OUTREACH"], blocker: "public people search (D-043 not accepted; both in RELEASE_NEVER_ON): code's people-list reply plans a list and finds no one" },
  C20: { status: "MISSING", blocker: "edits to a tailored resume (condense one role to one line, expand another): tailor_resume takes no edit instructions; save_resume_persona only orders or hides facts" },
  C22: { status: "MISSING", blocker: "self-reported intern pay (levels.fyi) needs general web search; research_market's free sources give BLS figures, not intern hourly pay" },
};

const NOTHING_SENT = /\b(?:nothing|not)\b[^.!?\n]{0,40}\b(?:sent|submitted|applied|queued|contacted)\b/i;
const SPEC = new URL("../../docs/architect/specs/MIRROR-PROCESS.md", import.meta.url);

Deno.test("MP-0 every turn of the benchmark is EXISTS or BLOCKED with a named blocker, and the spec says the same", () => {
  const ids = TURNS.map((t) => t.id);
  eq(ids.length, 26);
  eq([...EXISTS, ...Object.keys(BLOCKED)].sort(), [...ids].sort(), "each turn exactly once");
  for (const [id, b] of Object.entries(BLOCKED)) {
    ok(b.blocker.length > 40, `${id}: a named blocker`);
    if (b.status === "OFF") {
      ok(b.flags?.length, `${id}: OFF names its flag`);
      for (const f of b.flags!) ok(!(f in RELEASE_FLAGS) && RELEASE_NEVER_ON.includes(f), `${id}: ${f} is off in this release (RELEASE_NEVER_ON)`);
    }
  }
  // The spec's summary table: one row per turn, the same status.
  const rows = Object.fromEntries([...Deno.readTextFileSync(SPEC).matchAll(/^\| (C\d+f?\d?) \| (EXISTS|OFF|MISSING)\b/gm)].map((m) => [m[1], m[2]]));
  for (const id of ids) eq(rows[id], EXISTS.includes(id) ? "EXISTS" : BLOCKED[id].status, `spec row for ${id}`);
});

// What the brain does on each EXISTS turn (the process's tool calls) and its final words; code decides what each call returns.
const C2_BODY = "Hi [Name], I'm Sam, a Computer Science and Finance student at Lakeshore looking for a summer 2027 SWE internship at Google: [job link]. I'm building Waypoint, a career agent, and previously built 70+ React websites for clients through Pixelforge. Would you be open to taking a look at my resume and considering a referral if you think I'd be a fit? Best, Sam";
const C14_BODY = "Hey [Name], I'm a Lakeshore CS student interested in this Google SWE internship: [job link]. Would you be open to referring me if you think I'd be a fit? Happy to send my resume.";
const C13_BODY = "Hey, quick question: is there any flexibility in the listed comp range for this role, or is it fixed? Thanks!";
const C5_Q = "Given a list of integers, write a Python function that returns the first number that appears only once, or None if there isn't one. Talk me through your approach before writing code, including its time and space complexity.";
const C21_Q = "Tell me about a time you failed: what were you responsible for, what went wrong, and what did you do afterward?";
const SCRIPT: Record<string, Step[]> = {
  C2: [{ tool: "draft_followup", input: { kind: "note", recipient: "", body: C2_BODY } }, { text: "Here it is." }],
  C5: [{ text: C5_Q }],
  C5f1: [{ text: "That's the right approach: count first, then scan the original list. Can you write the function now, including what it returns for an empty list?" }],
  C5f2: [{ text: "An empty list or one with no unique number raises StopIteration instead of returning None; use next(..., None). Follow-up: what if the input is a generator you can only read once?" }],
  C7: [{ tool: "add_profile_fact", input: { kind: "offer", text: "Offer: $120,000 in Chicago" } }, { text: "I'd compare what you keep after taxes and rent, not the headline salaries." }],
  C8: [{ tool: "get_profile", input: {} }, { text: "From your resume and what you've told me: Pixelforge, Rallyup, Waypoint, Harbor Global, Crestline. The gaps: Harbor's dates and Crestline's exact name." }],
  C12: [{ text: "I couldn't responsibly promise 50 completed applications overnight. I'd measure a small approved batch first; nothing is being applied to now." }],
  C13: [{ tool: "draft_followup", input: { kind: "note", recipient: "", tone: "casual", body: C13_BODY } }, { text: "Here it is." }],
  C14: [{ tool: "draft_followup", input: { kind: "note", recipient: "", tone: "way shorter, less formal", body: C14_BODY } }, { text: "Here it is." }],
  C15: [{ tool: "add_profile_fact", input: { kind: "education", text: "new grad, zero internships, mid GPA" } }, { text: "In that situation, I'd build the resume around one or two projects you can demo." }],
  C17: [{ tool: "get_profile", input: {} }, { text: "I'm studying computer science and finance at Lakeshore; I started Pixelforge and built over 70 React websites, and now I'm building Waypoint." }],
  C18: [{ tool: "get_posting", input: { job_id: PAYPAL.id, recheck: true } }, { text: `I couldn't re-check PayPal's posting just now, so I can't call it open. ${PAYPAL.url} Nothing was submitted.` }],
  C21: [{ text: `${C21_Q} Give me the answer you'd actually say, and I'll be blunt.` }],
  C21f: [{ text: "Right now that's a plot summary, not an answer: what did YOU get wrong, and what did redoing it cost?" }],
  C23: [{ text: "Roughly eight weeks end to end, per Citadel's engineering interview guide; not a guaranteed timeline." }],
};
const result = (calls: Call[], name: string) => { const c = calls.find((x) => x.name === name); return c ? c.result : ""; };

Deno.test({ name: "MP-1 the EXISTS turns follow Instinct's process: the tools offered and called, the artifact, the boundary, nothing sent", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("MP-1 needs Postgres 16 in CI");
  const { seen, flags, world, person, close } = await runConversation(SCRIPT);
  try {
    // The backtest is production's configuration (owner, 2026-11-11): on every turn the handler's effective switches are
    // RELEASE_FLAGS exactly as release_config.ts ships them, no never-on switch is on, and the brain is PRODUCTION_BRAIN.
    eq(Object.keys(flags).length, 3 + 26, "flags read on every turn");
    for (const [id, f] of Object.entries(flags)) {
      eq(f.release, { ...RELEASE_FLAGS }, `${id}: effective release flags`);
      eq(f.neverOnOn, [], `${id}: a never-on switch is on`);
      eq(f.brain, PRODUCTION_BRAIN, `${id}: the served brain`);
    }
    const brain = (id: string) => { ok(!seen[id].code, `${id} reached the brain (code answered: ${seen[id].reply.slice(0, 120)})`); return seen[id]; };

    // C2: a draft from the confirmed profile with placeholders, shown, not sent; no question about the recipient (D-059).
    const c2 = brain("C2");
    ok(c2.tools.includes("draft_followup"), "C2 offers draft_followup");
    ok(/"status":"ok"/.test(result(c2.calls, "draft_followup")), `C2 draft passed code's checks: ${result(c2.calls, "draft_followup").slice(0, 300)}`);
    eq(c2.intent, "career_followup_draft");
    ok(c2.reply.startsWith("Draft, not sent:") && c2.reply.includes(C2_BODY), `C2 shows the checked draft: ${c2.reply.slice(0, 200)}`);
    ok(c2.reply.includes("[Name]") && c2.reply.includes("[job link]"), "C2 keeps the placeholders");
    ok(!/\?\s*$/.test(c2.reply.split("\n")[0]), "C2 asks no recipient question");

    // C3: code's live search: each posting shown was re-checked on its own page (D-051), the scope and count are honest, nothing applied.
    const c3 = seen.C3;
    ok(c3.code, "C3 is code's search");
    ok(c3.reply.includes("PayPal") && c3.reply.includes(PAYPAL.url), "C3 lists the posting with its link");
    ok(c3.outbound.length >= 1 && c3.outbound.every((o) => o.startsWith("GET ") && POSTING_PAGE.test(o.slice(4))), `C3 re-checks only posting pages: ${c3.outbound}`);
    ok(/not re-checked|checked/i.test(c3.reply), "C3 says what the check found");
    ok(/Nothing was applied for/.test(c3.reply), "C3 boundary");

    // C5, C5f1, C5f2: one question, approach first; the answer and the code are the brain's in the conversation, never a rubric score.
    const c5 = brain("C5");
    eq(c5.calls, [], "C5 serves no bank question and scores nothing");
    eq(c5.reply, C5_Q, "C5 is one question");
    ok(/LENGTH OF THIS REPLY[^\n]*the question/.test(c5.system), "C5 is told to ask the question and how to answer it");
    for (const id of ["C5f1", "C5f2"]) {
      const s = brain(id);
      ok(s.history.includes("first number that appears only once"), `${id}: the brain sees the question it asked`);
      ok(!s.calls.some((c) => c.name === "score_interview_answer"), `${id}: not scored on a rubric`);
      ok(!/Your answer, scored|read against the rubric/.test(s.reply), id);
    }

    // C7, C15: hypotheticals: told so, no tool that writes the record offered; the scripted save is refused; no offer row.
    for (const id of ["C7", "C15"]) {
      const s = brain(id);
      ok(/THIS MESSAGE IS A HYPOTHETICAL/.test(s.system), `${id} is a hypothetical`);
      ok(!s.tools.includes("add_profile_fact") && !s.tools.includes("track_application"), `${id} offers no record write`);
      ok(/ERROR|not offered|unknown tool|not available/i.test(result(s.calls, "add_profile_fact")), `${id}: the save was refused: ${result(s.calls, "add_profile_fact").slice(0, 160)}`);
    }
    ok(!/Pixelforge|Waypoint/.test(seen.C15.system), "C15 (a hypothetical person) is answered without their facts");
    eq((await world.pg.sql(`select count(*) from public.agent_flow_state where user_id = '${person.id}' and state::text ~ '120,?000'`)).replace(/\D+/g, " ").trim().split(" ")[0], "0", "no offer recorded");

    // C8, C17: recall from the confirmed record, each fact with its provenance; the reusable answer from the same record.
    for (const id of ["C8", "C17"]) {
      const s = brain(id), p = result(s.calls, "get_profile");
      ok(s.tools.includes("get_profile"), `${id} offers get_profile`);
      for (const w of ["Pixelforge", "Rallyup", "Waypoint", "Harbor Global", "Crestline"]) ok(p.includes(w), `${id}: ${w} on the record`);
      ok(/"provenance":"owner confirmed/.test(p), `${id}: each fact carries its provenance`);
    }
    ok(/LENGTH OF THIS REPLY[^\n]*900 to 1,200/.test(seen.C8.system), "C8: everything they asked for, long");

    // C12: honest volume: no tool that queues or applies is offered; nothing queued.
    const c12 = brain("C12");
    ok(!c12.tools.includes("queue_applications"), "C12 cannot queue");
    ok(NOTHING_SENT.test(c12.reply) || /nothing is being applied/i.test(c12.reply), "C12 boundary");

    // C13, C14: drafts, not sent; C14 is the earlier referral draft, shorter, from the conversation.
    for (const [id, body] of [["C13", C13_BODY], ["C14", C14_BODY]] as const) {
      const s = brain(id);
      ok(/"status":"ok"/.test(result(s.calls, "draft_followup")), `${id} draft passed: ${result(s.calls, "draft_followup").slice(0, 300)}`);
      eq(s.intent, "career_followup_draft");
      ok(s.reply.startsWith("Draft, not sent:") && s.reply.endsWith(body), `${id}: ${s.reply.slice(0, 160)}`);
    }
    ok(seen.C14.history.includes(C2_BODY), "C14: the brain sees the earlier referral draft");
    ok(C14_BODY.length < C2_BODY.length, "C14 is shorter");
    ok(/LENGTH OF THIS REPLY[^\n]*under about 200 characters/.test(seen.C14.system), "C14 is told to keep it short");

    // C18: a live re-check of that one posting on its own page, with its link; never called open when the check could not finish.
    const c18 = brain("C18"), g = result(c18.calls, "get_posting");
    ok(/THE POSTING THEY MEAN/.test(c18.system) && c18.system.includes(PAYPAL.id), "C18: the posting the conversation listed");
    ok(/"open_check":\{"state":"unknown"/.test(g), `C18 re-checked it now: ${g.slice(0, 300)}`);
    eq(c18.outbound, [`GET https://boards-api.greenhouse.io/v1/boards/paypalwa1/jobs/9101`], "C18: one posting-page read, its own");
    ok(c18.reply.includes(PAYPAL.url), "C18 gives the link");
    ok(!/\bstill open\b|\bis open\b/i.test(c18.reply), "C18 never calls an unchecked posting open");

    // C21, C21f: the question first; then the answer is roasted, never a template.
    eq(brain("C21").reply.startsWith(C21_Q), true);
    ok(/THEY ARE ANSWERING THE PRACTICE QUESTION THEY ASKED YOU TO ROAST/.test(brain("C21f").system), "C21f: the roast");

    // C23: recall of the earlier research, short; the source is allowed again (MP-2 below).
    ok(/LENGTH OF THIS REPLY[^\n]*one or two sentences/.test(brain("C23").system), "C23 one or two sentences");

    // The whole conversation: nothing queued, prepared, submitted or sent; off the machine only posting-page reads.
    for (const [t, n] of Object.entries(await effectRows(world, person.id))) eq(n, 0, `${t} has rows`);
    const off = Object.entries(seen).flatMap(([id, s]) => s.outbound.map((o) => `${id} ${o}`));
    ok(off.every((o) => / GET /.test(o) && POSTING_PAGE.test(o.split(" GET ")[1])), `only posting-page reads left the machine: ${off.join(", ")}`);
    // Every EXISTS brain turn's boundary survives code's shaping where the script stated one.
    for (const id of ["C12", "C18"]) ok(NOTHING_SENT.test(seen[id].reply) || /nothing is being applied/i.test(seen[id].reply), `${id} boundary kept`);
  } finally {
    await close();
  }
} });

// C23 "that citadel process from earlier, how long was it again total?": Instinct recalled the figure with the SAME source it gave in
// C9. The link was shown by Trainee's own earlier reply; recalling it later keeps it (career_brain.ts shownBefore), while a link
// nobody showed is still removed.
Deno.test("MP-2 C23: the earlier reply's source is given again with the recalled figure; an unseen link is still removed", async () => {
  const SRC = "https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process/";
  const history = [
    { role: "user" as const, content: "what's citadel like for new grad swe, culture pay interview process, give me real sources" },
    { role: "assistant" as const, content: `Interviews: Citadel describes a 45-minute first round, a second round with three 45-minute interviews, then team matching, roughly eight weeks overall.\n${SRC}` },
  ];
  const model = async () => ({ content: [{ type: "text", text: `Roughly eight weeks end to end, per Citadel's engineering interview guide, not a guaranteed timeline. ${SRC} (also https://unseen.example.com/x)` }], stop_reason: "end_turn" });
  const t: any = await agentTurn({ message: "that citadel process from earlier, how long was it again total?", history, stores: { profile: { facts: [] } }, userId: "u-mp", threadId: "t-mp", now: Date.parse("2026-11-11T05:45:00Z"), model } as any);
  ok(t.reply.includes(SRC), `the source is kept: ${t.reply}`);
  ok(!t.reply.includes("unseen.example.com"), "a link nobody showed is removed");
  eq(t.tool_calls.length, 0);
});
