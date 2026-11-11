// PENDING (architect, 2026-11-11): the process Instinct followed on the benchmark turns Trainee cannot follow yet
// (docs/architect/specs/MIRROR-PROCESS.md; the BLOCKED table in tests/architect/mirror-wa-batch1-process.test.ts names each
// blocker). Each assertion is the full process of one turn, through the real handler at $0 with the scripted model of
// tests/architect/helpers/mirror_process.ts. It FAILS until the capability lands; when a turn passes here, move it to EXISTS in
// mirror-wa-batch1-process.test.ts and the spec in the same PR. Never ignored, never weakened.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/mirror-process-blocked.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { effectRows, runConversation, type Step } from "../helpers/mirror_process.ts";
// Architect amendment (D-062; owner, 2026-11-11: "be able to answer emails, find alumni, do all of it"): C6, C16 and C19 are scripted
// like the other turns (the brain calls the tool the process names and replies from what it returned) and the people search is
// stubbed on the Anthropic wire. Every check below is unchanged; nothing is sent, queued or contacted (effectRows).
import { C16_STEPS, C19_STEPS, C6_STEPS, isPeopleSearch, peopleSearchAnswer } from "../helpers/d062_fixtures.ts";

const SCRIPT: Record<string, Step[]> = {
  // Architect amendment (D-063): C4, C10 and C20 passed here and moved to EXISTS (MP-1, tests/architect/mirror-wa-batch1-process.test.ts).
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
    // C6: email confirmations as evidence, applications separated from researched roles, a tracker offered.
    check("C6", seen.C6.tools.includes("read_application_mail") || /Gmail|email confirmations?/i.test(seen.C6.reply), "evidence from email confirmations");
    check("C6", /PayPal/.test(seen.C6.reply) && /research/i.test(seen.C6.reply), "the researched role separated from applications");
    check("C6", /tracker/i.test(seen.C6.reply) && /\?/.test(seen.C6.reply), "offers a tracker");
    // C11: architect amendment (D-062): passes now (inspect_apply_flow offered); moved to EXISTS and asserted in full in
    // tests/architect/mirror-wa-batch1-process.test.ts MP-1, and on Workday in tests/architect/workday-posting-d062.test.ts.
    // C16: a tracker artifact with past applications, researched roles and the unsubmitted draft.
    check("C16", seen.C16.tools.includes("export_tracker") || /https?:\/\/\S+/.test(seen.C16.reply), "a tracker artifact made");
    // C19: three named public leads with a verification caveat; nobody contacted.
    check("C19", (seen.C19.reply.match(/^\s*\d+\. /gm) ?? []).length === 3, "three named leads");
    check("C19", /Nobody was contacted|nobody was contacted/.test(seen.C19.reply), "nobody contacted");
    for (const [t, n] of Object.entries(await effectRows(world, person.id))) check("all", n === 0, `${t} has rows`);
  } finally {
    await close();
  }
  assertNode.deepEqual(fails, [], `blocked process steps:\n${fails.join("\n")}`);
} });
