// PENDING (architect, 2026-11-11): the process Instinct followed on the benchmark turns Trainee cannot follow yet
// (docs/architect/specs/MIRROR-PROCESS.md; the BLOCKED table in tests/architect/mirror-wa-batch1-process.test.ts names each
// blocker). Each assertion is the full process of one turn, through the real handler at $0 with the scripted model of
// tests/architect/helpers/mirror_process.ts. It FAILS until the capability lands; when a turn passes here, move it to EXISTS in
// mirror-wa-batch1-process.test.ts and the spec in the same PR. Never ignored, never weakened.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/mirror-process-blocked.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { effectRows, PAYPAL, runConversation, type Step } from "../helpers/mirror_process.ts";

const SCRIPT: Record<string, Step[]> = {
  // C10, C20: the tailored PDF for the posting the conversation listed, then a v2 with both edits.
  // Architect amendment (D-063): C4 is a specific advice question, so the brain asks research_career_question for kind "advice"
  // (one cited guide) rather than the career-entry plan; the answer names the outdated GPA the person corrected in setup.
  C4: [{ tool: "research_career_question", input: { question: "what should i put at the very top of my resume for swe roles, be specific", kind: "advice", query: "student software engineer resume header what to put at the top" } }, { text: "For the top of your SWE resume: your name and contact links, then your school, degree and expected graduation date on one line, then a compact skills line led by Python, TypeScript/JavaScript, React and SQL. Leave the outdated 3.9 GPA off." }],
  C10: [{ tool: "tailor_resume", input: { job_id: PAYPAL.id } }, { text: "Your tailored PDF is attached. Treat it as a review draft. Nothing was submitted." }],
  C20: [{ tool: "tailor_resume", input: { job_id: PAYPAL.id, edits: [{ role: "Pixelforge", lines: 1 }, { role: "Waypoint", lines: 3 }] } }, { text: "Updated: Pixelforge is one line, Waypoint three. Still a review draft; nothing was submitted." }],
};

// Architect amendment (D-063): C4's one web search, stubbed on the Anthropic wire as in MP-1 (the shape D-060's live proof
// recorded): one guide page with one quoted passage. Every other turn gets the default empty search.
const GUIDE = { url: "https://student-to-software-engineer.org/docs/find-your-first-internship/resumes/", title: "Resumes | Student to Software Engineer", text: "Start with your name and contact links, then education with your school, degree and expected graduation date, followed by a short technical skills section." };
const web = (body: any, turn: string) => turn !== "C4" ? null : { id: "msg_search", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [
  { type: "server_tool_use", id: "srvtoolu_mp", name: "web_search", input: { query: "q" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_mp", content: [{ type: "web_search_result", url: GUIDE.url, title: GUIDE.title, encrypted_content: "x", page_age: "30 days ago" }] },
  { type: "text", text: GUIDE.text, citations: [{ type: "web_search_result_location", url: GUIDE.url, title: GUIDE.title, cited_text: GUIDE.text, encrypted_index: "x" }] },
], usage: { input_tokens: 9000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } } };

Deno.test({ name: "MP-BLOCKED the turns blocked on a missing or off capability follow Instinct's full process", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("MP-BLOCKED needs Postgres 16 in CI");
  const { seen, world, person, close } = await runConversation(SCRIPT, { web }); // Architect amendment (D-063): C4's stubbed search
  const fails: string[] = [];
  const check = (id: string, cond: boolean, what: string) => { if (!cond) fails.push(`${id}: ${what}`); };
  try {
    // C1: a live search with each posting checked open, and a plan File (links and a weekly plan) on this channel.
    check("C1", seen.C1.tools.includes("search_jobs"), "search_jobs offered");
    check("C1", seen.C1.tools.includes("create_file"), "create_file (plan_review) offered on WhatsApp [CAREER_REPLY_WRITER off]");
    // C4: header advice from the profile, the outdated GPA flagged, one cited source for the advice itself.
    check("C4", /resume/i.test(seen.C4.reply) && /https?:\/\/\S+/.test(seen.C4.reply), "a sourced answer about the resume's header, with its link [research_career_question answers a career-entry plan]");
    // Architect amendment (D-063), stricter: the answer comes first and the ONE link is the cited guide, alone on the last line
    // (not a plan file); the search ran once; the GPA correction was in what the brain saw.
    const c4 = JSON.parse(seen.C4.calls[0]?.result || "{}");
    check("C4", c4.status === "advice" && c4.source?.url === GUIDE.url, `research_career_question (advice) cites the guide: ${seen.C4.calls[0]?.result.slice(0, 200)}`);
    check("C4", seen.C4.reply.trim().split("\n").at(-1) === GUIDE.url && (seen.C4.reply.match(/https?:\/\/\S+/g) ?? []).length === 1 && !/^https?:/.test(seen.C4.reply.trim()), `answer first, then the one source on its own line: ${seen.C4.reply}`);
    check("C4", seen.C4.searches === 1 && /outdated/i.test(seen.C4.history), "one web search; the outdated GPA in the brain's view");
    // C6: email confirmations as evidence, applications separated from researched roles, a tracker offered.
    check("C6", seen.C6.tools.includes("read_application_mail") || /Gmail|email confirmations?/i.test(seen.C6.reply), "evidence from email confirmations");
    check("C6", /PayPal/.test(seen.C6.reply) && /research/i.test(seen.C6.reply), "the researched role separated from applications");
    check("C6", /tracker/i.test(seen.C6.reply) && /\?/.test(seen.C6.reply), "offers a tracker");
    // C10: the PDF delivered, labelled a review draft, nothing submitted.
    // Architect amendment (D-063): exactly one PDF; its Word copy may ride with it (RESUME-TEMPLATES 1.1, "Trainee keeps sending
    // both"). The persona typed no email and its confirmed resume has none, so the PDF carries the visible "[your email]"
    // placeholder, the tool says so (review_draft), and the draft is not stored for an application.
    const pdfs = (d: any[]) => d.filter((x) => x?.format === "pdf");
    check("C10", pdfs(seen.C10.documents).length === 1 && seen.C10.documents.length <= 2, `a tailored PDF delivered (tailor_resume: ${seen.C10.calls[0]?.result.slice(0, 160)})`);
    const c10 = JSON.parse(seen.C10.calls[0]?.result || "{}");
    check("C10", c10.ok === true && c10.placeholders?.includes("email") && /\[your email\]/.test(JSON.stringify(c10.review_draft ?? {})) && !c10.link, "the email placeholder flagged, nothing stored or linked (D-063)");
    // C11: the entry flow inspected read only; requirements and unknown questions listed.
    check("C11", seen.C11.tools.includes("inspect_apply_flow"), "a read-only apply-flow reader offered");
    // C16: a tracker artifact with past applications, researched roles and the unsubmitted draft.
    check("C16", seen.C16.tools.includes("export_tracker") || /https?:\/\/\S+/.test(seen.C16.reply), "a tracker artifact made");
    // C19: three named public leads with a verification caveat; nobody contacted.
    check("C19", (seen.C19.reply.match(/^\s*\d+\. /gm) ?? []).length === 3, "three named leads");
    check("C19", /Nobody was contacted|nobody was contacted/.test(seen.C19.reply), "nobody contacted");
    // C20: a v2 PDF with both edits.
    check("C20", "edits" in (seen.C20.schemas.tailor_resume?.properties ?? {}), "tailor_resume takes edits");
    // Architect amendment (D-063): exactly one PDF (its Word copy may ride with it), named v2, with both edits as made from
    // confirmed details only: Pixelforge condensed to one line, Waypoint leading with every confirmed detail it has and the
    // shortfall said (expand_short), never an invented line.
    check("C20", pdfs(seen.C20.documents).length === 1 && /_v2\.pdf$/.test(pdfs(seen.C20.documents)[0]?.filename ?? ""), `a v2 PDF delivered: ${JSON.stringify(seen.C20.documents.map((d) => d.filename))}`);
    const c20 = JSON.parse(seen.C20.calls[0]?.result || "{}"), ed = (r: string) => (c20.edits_done ?? []).find((e: any) => e.role === r);
    check("C20", ed("Pixelforge")?.change === "condensed" && ed("Pixelforge")?.now === 1, `Pixelforge condensed to one line: ${JSON.stringify(c20.edits_done ?? c20).slice(0, 300)}`);
    check("C20", ed("Waypoint")?.led === true && ed("Waypoint")?.now === ed("Waypoint")?.available && (ed("Waypoint")?.expand_short === (ed("Waypoint")?.available < 3)), "Waypoint expanded from confirmed details only, leading");
    check("C20", !!c20.review_draft && c20.placeholders?.includes("email"), "still a review draft with its open flags");
    for (const [t, n] of Object.entries(await effectRows(world, person.id))) check("all", n === 0, `${t} has rows`);
  } finally {
    await close();
  }
  assertNode.deepEqual(fails, [], `blocked process steps:\n${fails.join("\n")}`);
} });
