// Live-10 replay at $0 (no model, no network): the brain (agentTurn) with the model scripted to give the answers live-9 gave on the
// same turns (live-10 did not record its drafts), the persona's confirmed record, and stub tools. The judge is the deterministic test
// judge (the mirror suite's stub, tests/architect/helpers/mirror_stub_judge.ts). Prints each turn's reply.
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/live10/replay.ts
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { FAIL_CLOSED } from "../../supabase/functions/_shared/agent/research/market.ts";
import { mirrorJudgeAnswer } from "../../tests/architect/helpers/mirror_stub_judge.ts";
// The mirror suite's stub judge: words of the claim in the passage it is shown (the joint guide and record passage read whole, a role
// never joined to another line's employer), instruction words aside.
const testSupportJudge = async (cs: any[]) => JSON.parse(mirrorJudgeAnswer(JSON.stringify(cs)));
FAIL_CLOSED.support = true;
const L9 = Object.fromEntries(Deno.readTextFileSync(new URL("./live9-replies.jsonl", import.meta.url)).split("\n").filter(Boolean).map((l) => { const d = JSON.parse(l); return [d.id, d.reply]; }));
const say = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "t1", name, input }], stop_reason: "tool_use" });
const scripted = (steps: any[]) => { let n = 0; return async (p: any) => p.tools?.length ? steps[Math.min(n++, steps.length - 1)] : say(""); };
const NOW = Date.parse("2026-11-10T23:10:00Z");
const FACTS = [
  { id: "F-1", kind: "education", text: "Lakeshore University, BS Computer Science and Finance, Expected June 2029", status: "confirmed" },
  ...["Python", "TypeScript/JavaScript", "React", "SQL"].map((n, k) => ({ id: `S-${k}`, kind: "skill", name: n, text: `Skill: ${n}`, status: "confirmed", unproven: true })),
  { id: "F-7", kind: "experience", text: "Pixelforge, Founder (2023-2025): hand-coded 70+ React websites for clients; peak $9k monthly recurring revenue.", status: "confirmed" },
  { id: "F-8", kind: "experience", text: "Rallyup, Co-founder: youth-sports management software; customer discovery with coaches and trainers; paying teams.", status: "confirmed" },
  { id: "F-9", kind: "experience", text: "Waypoint, Solo founder (part-time): building a career agent covering applications, resumes, research and networking.", status: "confirmed" },
  { id: "F-2", kind: "other", name: "GPA", gpa: "3.9", text: "GPA: 3.9", status: "draft", needs_confirmation: true },
];
const PAYPAL = { job_id: "pp1", company: "PayPal", title: "Software Engineer Intern - Summer 2027", location: "Chicago, IL", url: "https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586",
  description: "Pay: Chicago, Illinois: $28- $49 Hourly. Software engineering internship for summer 2027.", pay: "$28-$49 hourly" };
const GUIDE = "https://careers.umd.edu/sites/default/files/2021-12/Resume%20Writng%20with%20Samples%202021.pdf";
const guideText = "Put your name, email and a GitHub or portfolio link at the very top. Most college resumes do not need an objective statement. Education comes next and leads with the expected graduation date. Then list your skills and your strongest experience first.";
const advSearch = async () => ({ status: "ok", facts: [{ id: "", kind: "program", text: guideText, quote: guideText, url: GUIDE, label: "University career center guide" }], urls: [GUIDE], cost_usd: 0 });
const base = { history: [], userId: "u", threadId: "t", now: NOW, knowledge: true, market: { judge: testSupportJudge } };
const turns: [string, string, any][] = [
  ["C1", "i need to lock in for recruiting, what should i actually be doing rn to land a swe internship for next summer", { model: scripted([use("search_jobs", { query: "software engineer intern summer 2027 Chicago remote" }), say(L9.C1)]), postings: async () => [PAYPAL] }],
  ["C4", "what should i put at the very top of my resume for swe roles, be specific", { model: scripted([use("research_career_question", { question: "what should i put at the very top of my resume for swe roles, be specific", kind: "advice", query: "student software engineer resume header" }), say(L9.C4)]), research: { search: advSearch } }],
];
for (const [id, message, extra] of turns) {
  const t: any = await agentTurn({ ...base, message, stores: { profile: { facts: structuredClone(FACTS) } }, ...extra } as any);
  console.log(`===== ${id}\n${t.reply}\n`);
}
