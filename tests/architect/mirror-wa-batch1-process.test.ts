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
// the named blocker; tests/architect/mirror-process-blocked.test.ts asserts their full process (architect amendment (D-064): promoted from pending/).
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/mirror-wa-batch1-process.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "./helpers/response_world.ts";
import { type Call, effectRows, PAYPAL, runConversation, type Step, TURNS } from "./helpers/mirror_process.ts";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { POSTING_PAGE } from "./helpers/posting_checks.ts";
import { C16_STEPS, C19_STEPS, C6_STEPS, isPeopleSearch, peopleSearchAnswer } from "./helpers/d062_fixtures.ts"; // Architect amendment (D-062)

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// Architect amendment (D-062; owner, 2026-11-11: "be able to answer emails, find alumni, do all of it. not gmail read, but gmail read
// and send"): C6, C16 and C19 move from BLOCKED to EXISTS (Gmail confirmations and the tracker File, CAREER_MAIL_TRACKING; public
// people search, CAREER_PEOPLE_SEARCH in RELEASE_FLAGS). Their process is asserted in MP-1 below and in
// tests/architect/d062-capabilities-process.test.ts; every other entry and check is unchanged.
// Architect amendment (D-062): C11 moves to EXISTS (inspect_apply_flow, posting_requirements.ts: the posting and its form read
// from public pages only, the questions behind a Workday sign-in named as not known); its blocked step is asserted in MP-1 below.
// Architect amendment (D-063): C4 (a specific advice question, one cited guide), C10 (the tailored PDF, its email a visible placeholder)
// and C20 (the v2 PDF with both edits) moved from BLOCKED to EXISTS; their process is asserted in MP-1.
// Architect amendment (D-061): C1 moved from BLOCKED (OFF, CAREER_REPLY_WRITER) to EXISTS: create_file is offered with the reply writer
// off (D-061 G11), beside search_jobs; asserted in MP-1. The writer stays in RELEASE_NEVER_ON.
export const EXISTS = ["C1", "C2", "C3", "C4", "C5", "C5f1", "C5f2", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C13", "C14", "C15", "C16", "C17", "C18", "C19", "C20", "C21", "C21f", "C22", "C23"];
// The turns whose process needs a capability Trainee does not serve today. OFF: the code exists and a release switch keeps it off
// (`flags`, none of which release_config.ts serves on). MISSING: what has to be built or provided.
export const BLOCKED: Record<string, { status: "OFF" | "MISSING"; blocker: string; flags?: string[] }> = {
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

// Architect amendment (D-066): the script below moved verbatim to tests/architect/helpers/mirror_wa_script.ts (shared with the
// behavior-guide suite); every assertion in this file is unchanged.
import { C2_BODY, C14_BODY, C13_BODY, C5_Q, C21_Q, C4_GUIDE, C4_ANSWER, C9_Q, CITADEL_QUERIES, WEB, WEB_BY_TURN, web, draft, cite, SCRIPT } from "./helpers/mirror_wa_script.ts";
import { isSupportJudgeCall, supportJudgeAnswer } from "./support-test-judge.ts";
const result = (calls: Call[], name: string) => { const c = calls.find((x) => x.name === name); return c ? c.result : ""; };

Deno.test({ name: "MP-1 the EXISTS turns follow Instinct's process: the tools offered and called, the artifact, the boundary, nothing sent", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("MP-1 needs Postgres 16 in CI");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the handler's support judge calls the model
  // with no tools, which the conversation runner hands to `draft`; it is answered as the deterministic test judge would (a JSON array,
  // support-test-judge.ts) and never advances the script.
  const draftOrJudge = (system: string, user: string) => isSupportJudgeCall(system) ? supportJudgeAnswer(user) : draft(system, user);
  // Architect amendment (same): with the switch on, a source is "official" (and a sentence that does not name Citadel speaks for
  // Citadel) only on the employer's own domain on record: the brain's C9 research_market call names it (sites: ["citadel.com"]), as
  // the brain passes a domain it knows. The shared script is left as it is; this file's copy of the C9 step carries the site.
  const script: Record<string, Step[]> = { ...SCRIPT, C9: SCRIPT.C9.map((st: any) => st.tool === "research_market" ? { ...st, input: { ...st.input, sites: ["citadel.com"] } } : st) };
  const { seen, flags, world, person, close } = await runConversation(script, { web: (body, turn) => isPeopleSearch(body) ? peopleSearchAnswer(body) : web(body, turn), draft: draftOrJudge }); // Architect amendment (D-062): the people search stub
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

    // Architect amendment (D-061): C1: the live search and the plan File are both in the brain's hands (search_jobs, create_file).
    const c1 = brain("C1");
    ok(c1.tools.includes("search_jobs"), "C1 offers search_jobs");
    ok(c1.tools.includes("create_file"), "C1 offers create_file (plan_review) with the reply writer off");

    // C2: a draft from the confirmed profile with placeholders, shown, not sent; no question about the recipient (D-059).
    const c2 = brain("C2");
    ok(c2.tools.includes("draft_followup"), "C2 offers draft_followup");
    ok(/"status":"ok"/.test(result(c2.calls, "draft_followup")), `C2 draft passed code's checks: ${result(c2.calls, "draft_followup").slice(0, 300)}`);
    eq(c2.intent, "career_followup_draft");
    // Architect amendment (D-067): the draft comes first and its label after it (G2, answer first); the bar stands: the reply is the tool's checked text and the not-sent label still appears.
    ok(c2.reply.endsWith("Draft, not sent.") && c2.reply.includes(C2_BODY), `C2 shows the checked draft: ${c2.reply.slice(0, 200)}`);
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
      // Architect amendment (D-067): the draft comes first and its label after it (G2, answer first); the bar stands: the reply is the tool's checked text and the not-sent label still appears.
      ok(s.reply.endsWith("\n\nDraft, not sent.") && s.reply.startsWith(body), `${id}: ${s.reply.slice(0, 160)}`);
    }
    ok(seen.C14.history.includes(C2_BODY), "C14: the brain sees the earlier referral draft");
    ok(C14_BODY.length < C2_BODY.length, "C14 is shorter");
    ok(/LENGTH OF THIS REPLY[^\n]*under about 200 characters/.test(seen.C14.system), "C14 is told to keep it short");

    // C18: a live re-check of that one posting on its own board (D-060 check_posting_open, research_web.ts), with its link; never
    // called open when the check could not finish.
    const c18 = brain("C18"), g = result(c18.calls, "check_posting_open");
    ok(/THE POSTING THEY MEAN/.test(c18.system) && c18.system.includes(PAYPAL.url), "C18: the posting the conversation listed");
    ok(c18.tools.includes("check_posting_open"), "C18 offers the live re-check");
    ok(/"state":"unknown"/.test(g) && /Do not guess/.test(g), `C18 re-checked it now: ${g.slice(0, 300)}`);
    eq(c18.outbound, ["GET https://boards-api.greenhouse.io/v1/boards/paypalwa1/jobs/9101"], "C18: one posting-page read, its own");
    ok(c18.reply.includes(PAYPAL.url), "C18 gives the link");
    ok(!/\bstill open\b|\bis open\b/i.test(c18.reply), "C18 never calls an unchecked posting open");

    // C11 (architect amendment, D-062): what applying would need, read only: the posting the conversation listed, read with the
    // apply-flow reader on its own posting page (one GET; refused here, so the questions are said to be not read, never guessed),
    // and the boundary: no account, saved application or submission created; nothing applied for.
    const c11 = brain("C11"), a11 = JSON.parse(result(c11.calls, "inspect_apply_flow") || "{}");
    ok(/THE POSTING THEY MEAN/.test(c11.system) && c11.system.includes(PAYPAL.url), "C11: the posting the conversation listed");
    ok(c11.tools.includes("inspect_apply_flow"), "C11 offers the read-only apply-flow reader");
    eq([a11.board, a11.questions_read, a11.questions], ["Greenhouse", "not_read", null], `C11 read the form or said it could not: ${JSON.stringify(a11).slice(0, 300)}`);
    eq(c11.outbound, ["GET https://boards-api.greenhouse.io/v1/boards/paypalwa1/jobs/9101"], "C11: one read, the posting's own page");
    ok(/no account, saved application or submission was created/.test(a11.note) && /never guess the questions/.test(a11.note), `C11 note: ${a11.note}`);
    ok(/no account, saved application or submission was created/.test(c11.reply), "C11 boundary kept");

    // C9: one web search; official pages first, the forum labelled an anecdote, the two employers kept apart; one topic per message
    // with its link on its own line; nothing sent.
    const c9 = brain("C9"), m9 = JSON.parse(result(c9.calls, "research_market") || "{}");
    eq(c9.searches, 1, "C9: one web search");
    eq(m9.status, "ok", `C9 research: ${JSON.stringify(m9).slice(0, 300)}`);
    ok(!m9.sources.some((x: any) => /citadelsecurities\.com/.test(x.url) && x.kind === "official"), "C9: Citadel Securities is not Citadel's official source");
    ok(m9.sources.some((x: any) => x.kind === "official") && m9.sources.some((x: any) => x.kind === "anecdote"), `C9: official and anecdotal sources told apart: ${JSON.stringify(m9.sources.map((x: any) => [x.url, x.kind]))}`);
    const parts9 = c9.reply.split(/\n\n+/);
    ok(parts9.length >= 3 && parts9.every((p) => /\nhttps:\/\/\S+$/.test(p)), `C9: one topic per message, its link on its own line: ${c9.reply}`);
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the model's own wording ("..., anecdotes
    // rather than proof") does not reach the person; the forum's line is its page's own sentence, quoted, which says itself that it is
    // anonymous accounts, or else code tags it "(anecdote)" (market.ts UNVERIFIED_LABEL). Either way the paragraph that carries the
    // forum's link labels it as an anecdote.
    const forum9 = parts9.find((p) => p.includes("reddit.com"));
    ok(forum9 && (/anecdotes? rather than proof|anecdotes?, not proof|\(anecdote\)/i.test(forum9) || /^(?:From [^:"]+: )?"Anonymous (?:posters|accounts)/.test(forum9)), `C9 labels the anecdote: ${c9.reply}`);
    ok(c9.reply.includes("https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process"), "C9 cites the interview guide");

    // C22: the posting's own pay read, then self-reported figures from one web search, labelled self-reported, each with its link.
    const c22 = brain("C22"), m22 = JSON.parse(result(c22.calls, "research_market") || "{}");
    eq(c22.calls.map((c) => c.name), ["get_posting", "research_market"], "C22: the posting's pay, then the research");
    ok(/\$28 - \$49 per hour/.test(result(c22.calls, "get_posting")), "C22: the posted pay is read");
    eq(c22.searches, 1, "C22: one web search");
    ok(m22.status === "ok" && m22.sources.every((x: any) => x.kind === "self_reported"), `C22 sources: ${JSON.stringify(m22.sources ?? m22)}`);
    ok(/self-reported/i.test(c22.reply) && c22.reply.includes("levels.fyi/internships/Relativity"), `C22: ${c22.reply}`);
    ok(!/\bmedian\b/i.test(c22.reply), "C22 never calls a benchmark a median");

    // Architect amendment (D-063). C4: a specific advice question: the confirmed record and the GPA correction in the brain's view;
    // research_career_question (advice) makes one web search and cites one guide; the answer first, that one link alone on the last
    // line, written by code; no plan file.
    const c4 = brain("C4"), a4 = JSON.parse(result(c4.calls, "research_career_question") || "{}");
    ok(c4.tools.includes("research_career_question") && "kind" in (c4.schemas.research_career_question?.properties ?? {}), "C4 offers the advice kind");
    ok(/Lakeshore University/.test(c4.system) && /outdated/i.test(c4.history), "C4: the confirmed education and the GPA correction are in view");
    eq([a4.status, a4.source?.url, c4.searches], ["advice", C4_GUIDE, 1], `C4 advice: ${JSON.stringify(a4).slice(0, 300)}`);
    eq(c4.reply, `${C4_ANSWER}\n${C4_GUIDE}`, "C4: answer first, then the one source on its own line");
    // C10: the posting the conversation listed, tailored from confirmed facts; one PDF (its Word copy may ride with it,
    // RESUME-TEMPLATES 1.1); no email on the confirmed resume and none typed, so the email is a visible placeholder the tool flags,
    // and the draft is never stored for an application (D-063); nothing submitted.
    const c10 = brain("C10"), t10 = JSON.parse(result(c10.calls, "tailor_resume") || "{}");
    const pdfs = (d: any[]) => d.filter((x) => x?.format === "pdf");
    ok(/THE POSTING THEY MEAN/.test(c10.system) && c10.system.includes(PAYPAL.id), "C10: the posting the conversation listed");
    ok(t10.ok === true && t10.placeholders?.includes("email") && !t10.link, `C10 tailor_resume: ${JSON.stringify(t10).slice(0, 300)}`);
    ok((t10.review_draft?.flags ?? []).some((f: string) => f.includes("[your email]")) && /review draft/.test(t10.review_draft?.note ?? ""), "C10: flagged as a review draft with the placeholder");
    eq([pdfs(c10.documents).length, c10.documents.length <= 2], [1, true], `C10 files: ${JSON.stringify(c10.documents.map((d) => d.filename))}`);
    ok(NOTHING_SENT.test(c10.reply), "C10 boundary");
    // C20: the same posting again with both edits, from confirmed details only: Pixelforge condensed to one line, Waypoint leading
    // with every detail its record holds and the shortfall said; the file is v2, still a review draft.
    const c20 = brain("C20"), t20 = JSON.parse(result(c20.calls, "tailor_resume") || "{}"), ed = (r: string) => (t20.edits_done ?? []).find((e: any) => e.role === r);
    ok("edits" in (c20.schemas.tailor_resume?.properties ?? {}), "C20: tailor_resume takes edits");
    eq([ed("Pixelforge")?.change, ed("Pixelforge")?.now], ["condensed", 1], `C20 Pixelforge: ${JSON.stringify(t20.edits_done ?? t20).slice(0, 300)}`);
    ok(ed("Waypoint")?.led === true && ed("Waypoint")?.now === ed("Waypoint")?.available && ed("Waypoint")?.expand_short === (ed("Waypoint")?.available < 3), "C20 Waypoint: from its confirmed details only, leading");
    ok(pdfs(c20.documents).length === 1 && /_v2\.pdf$/.test(pdfs(c20.documents)[0]?.filename ?? ""), `C20 v2: ${JSON.stringify(c20.documents.map((d) => d.filename))}`);
    ok(!!t20.review_draft && NOTHING_SENT.test(c20.reply), "C20: still a review draft; nothing submitted");

    // C21, C21f: the question first; then the answer is roasted, never a template.
    eq(brain("C21").reply.startsWith(C21_Q), true);
    ok(/THEY ARE ANSWERING THE PRACTICE QUESTION THEY ASKED YOU TO ROAST/.test(brain("C21f").system), "C21f: the roast");

    // C23: recall of the earlier research, short, from the cache (no new search), with the same source as C9.
    const c23 = brain("C23");
    ok(/LENGTH OF THIS REPLY[^\n]*one or two sentences/.test(c23.system), "C23 one or two sentences");
    eq(c23.searches, 0, "C23 is answered from the earlier search, unsearched");
    ok(/eight weeks/.test(c23.reply) && c23.reply.includes("https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process"), `C23 recalls with the same source: ${c23.reply}`);

    // Architect amendment (D-062). C6: the record from Gmail confirmations (this persona has none connected: said, with where to
    // connect it), tonight's PayPal kept apart as research, a tracker offered. C16: the tracker tool (its page needs file links,
    // which this world does not set: d062-capabilities-process.test.ts makes it). C19: one people search from excerpts, three
    // leads not verified, nobody contacted.
    const c6 = brain("C6"), r6 = JSON.parse(result(c6.calls, "read_application_mail") || "{}");
    ok(c6.tools.includes("read_application_mail") && r6.mail?.gmail === "not_connected" && /\/connect\/gmail$/.test(r6.connect_url ?? ""), `C6 record: ${JSON.stringify(r6).slice(0, 300)}`);
    ok((r6.researched ?? []).some((x: any) => x.company === "PayPal") && !(r6.applied ?? []).length, "C6: PayPal is research, not an application");
    ok(/Gmail/.test(c6.reply) && /PayPal[^\n]*research only/.test(c6.reply) && /tracker[^\n]*\?/.test(c6.reply), c6.reply);
    ok(brain("C16").tools.includes("export_tracker") && seen.C16.calls.some((c) => c.name === "export_tracker"), "C16 builds the tracker");
    const c19 = brain("C19"), r19 = JSON.parse(result(c19.calls, "find_people") || "{}");
    eq(c19.searches, 1, "C19: one people search");
    eq((r19.leads ?? []).length, 3, `C19 leads: ${JSON.stringify(r19).slice(0, 300)}`);
    ok((c19.reply.match(/^\s*\d+\. /gm) ?? []).length === 3 && /not verified/.test(c19.reply) && /Nobody was contacted\./.test(c19.reply), c19.reply);
    // The whole conversation: nothing queued, prepared, submitted or sent; off the machine only posting-page reads.
    for (const [t, n] of Object.entries(await effectRows(world, person.id))) eq(n, 0, `${t} has rows`);
    // Off the machine: posting-page reads (C3, C18), and on the research turns (C9, C22, C23) the research reader's GETs of public
    // pages and boards, each refused. Nothing else, and never a write.
    const off = Object.entries(seen).flatMap(([id, s]) => s.outbound.map((o) => `${id} ${o}`));
    ok(off.every((o) => / GET /.test(o) && (POSTING_PAGE.test(o.split(" GET ")[1]) || /^(?:C9|C22|C23) /.test(o))), `only reads left the machine: ${off.join(", ")}`);
    // Every EXISTS brain turn's boundary survives code's shaping where the script stated one.
    for (const id of ["C10", "C12", "C18", "C20"]) ok(NOTHING_SENT.test(seen[id].reply) || /nothing is being applied/i.test(seen[id].reply), `${id} boundary kept`);
  } finally {
    await close();
  }
} });

// C23 without a tool call: when the brain recalls "that citadel process from earlier" from the conversation rather than calling the
// research again, the link Trainee's own earlier reply showed is kept (career_brain.ts shownBefore); a link nobody showed is not.
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
