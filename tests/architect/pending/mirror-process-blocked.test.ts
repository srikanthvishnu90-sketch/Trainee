// PENDING (architect, 2026-11-11): the process Instinct followed on the benchmark turns Trainee cannot follow yet
// (docs/architect/specs/MIRROR-PROCESS.md; the BLOCKED table in tests/architect/mirror-wa-batch1-process.test.ts names each
// blocker). Each assertion is the full process of one turn, through the real handler at $0 with the scripted model of
// tests/architect/helpers/mirror_process.ts. It FAILS until the capability lands; when a turn passes here, move it to EXISTS in
// mirror-wa-batch1-process.test.ts and the spec in the same PR. Never ignored, never weakened.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/mirror-process-blocked.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { effectRows, PAYPAL, runConversation, type Step } from "../helpers/mirror_process.ts";
// Architect amendment (D-062; owner, 2026-11-11: "be able to answer emails, find alumni, do all of it"): C6, C16 and C19 are scripted
// like the other turns (the brain calls the tool the process names and replies from what it returned) and the people search is
// stubbed on the Anthropic wire. Every check below is unchanged; nothing is sent, queued or contacted (effectRows).
import { C16_STEPS, C19_STEPS, C6_STEPS, isPeopleSearch, peopleSearchAnswer } from "../helpers/d062_fixtures.ts";

const SCRIPT: Record<string, Step[]> = {
  // C10, C20: the tailored PDF for the posting the conversation listed, then a v2 with both edits.
  C4: [{ tool: "research_career_question", input: { question: "what should i put at the very top of my resume for swe roles, be specific" } }, { text: "Name and contact links first, then school and graduation date, then a skills line; leave the outdated 3.9 off." }],
  C10: [{ tool: "tailor_resume", input: { job_id: PAYPAL.id } }, { text: "Your tailored PDF is attached. Treat it as a review draft. Nothing was submitted." }],
  C20: [{ tool: "tailor_resume", input: { job_id: PAYPAL.id, edits: [{ role: "Pixelforge", lines: 1 }, { role: "Waypoint", lines: 3 }] } }, { text: "Updated: Pixelforge is one line, Waypoint three. Still a review draft; nothing was submitted." }],
  // Architect amendment (D-062): the capability turns.
  C6: C6_STEPS, C16: C16_STEPS, C19: C19_STEPS,
};

Deno.test({ name: "MP-BLOCKED the turns blocked on a missing or off capability follow Instinct's full process", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("MP-BLOCKED needs Postgres 16 in CI");
  const { seen, world, person, close } = await runConversation(SCRIPT, { web: (body) => isPeopleSearch(body) ? peopleSearchAnswer(body) : null }); // Architect amendment (D-062): the people search stub
  const fails: string[] = [];
  const check = (id: string, cond: boolean, what: string) => { if (!cond) fails.push(`${id}: ${what}`); };
  try {
    // C1: a live search with each posting checked open, and a plan File (links and a weekly plan) on this channel.
    check("C1", seen.C1.tools.includes("search_jobs"), "search_jobs offered");
    check("C1", seen.C1.tools.includes("create_file"), "create_file (plan_review) offered on WhatsApp [CAREER_REPLY_WRITER off]");
    // C4: header advice from the profile, the outdated GPA flagged, one cited source for the advice itself.
    check("C4", /resume/i.test(seen.C4.reply) && /https?:\/\/\S+/.test(seen.C4.reply), "a sourced answer about the resume's header, with its link [research_career_question answers a career-entry plan]");
    // C6: email confirmations as evidence, applications separated from researched roles, a tracker offered.
    check("C6", seen.C6.tools.includes("read_application_mail") || /Gmail|email confirmations?/i.test(seen.C6.reply), "evidence from email confirmations");
    check("C6", /PayPal/.test(seen.C6.reply) && /research/i.test(seen.C6.reply), "the researched role separated from applications");
    check("C6", /tracker/i.test(seen.C6.reply) && /\?/.test(seen.C6.reply), "offers a tracker");
    // C10: the PDF delivered, labelled a review draft, nothing submitted.
    check("C10", seen.C10.documents.length === 1 && seen.C10.documents[0]?.format === "pdf", `a tailored PDF delivered (tailor_resume: ${seen.C10.calls[0]?.result.slice(0, 160)})`);
    // C11: the entry flow inspected read only; requirements and unknown questions listed.
    check("C11", seen.C11.tools.includes("inspect_apply_flow"), "a read-only apply-flow reader offered");
    // C16: a tracker artifact with past applications, researched roles and the unsubmitted draft.
    check("C16", seen.C16.tools.includes("export_tracker") || /https?:\/\/\S+/.test(seen.C16.reply), "a tracker artifact made");
    // C19: three named public leads with a verification caveat; nobody contacted.
    check("C19", (seen.C19.reply.match(/^\s*\d+\. /gm) ?? []).length === 3, "three named leads");
    check("C19", /Nobody was contacted|nobody was contacted/.test(seen.C19.reply), "nobody contacted");
    // C20: a v2 PDF with both edits.
    check("C20", "edits" in (seen.C20.schemas.tailor_resume?.properties ?? {}), "tailor_resume takes edits");
    check("C20", seen.C20.documents.length === 1, "a v2 PDF delivered");
    for (const [t, n] of Object.entries(await effectRows(world, person.id))) check("all", n === 0, `${t} has rows`);
  } finally {
    await close();
  }
  assertNode.deepEqual(fails, [], `blocked process steps:\n${fails.join("\n")}`);
} });
