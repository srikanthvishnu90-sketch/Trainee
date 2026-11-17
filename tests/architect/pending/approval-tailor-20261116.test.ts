// The 10/10 rubric's gap #8 (2026-11-16; evals/mirror/instinct-wa-batch1/, live-12 C10 and C12), at $0 with a scripted model through
// the real brain turn (agentTurn) and the real tailor_resume tool.
//   CU-1  the approval rules the brain reads come from the approval code: built from APPROVAL_RULES, the yes window read from
//         career_apply_cards.ts, a batch yes, never "one by one"; the capacity note (C12) points at them
//   CU-2  C10: a tailored resume for a software posting leads with an entry that shows the posting's skills, never with a newest
//         role that shows none; within each tier the order stays newest first
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/approval-tailor-20261116.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter } from "../../../supabase/functions/_shared/router_core.career.js";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { careerSystemPrompt, MIRROR_RULES } from "../../../supabase/functions/_shared/agent/prompt.ts";
import { capacityNote } from "../../../supabase/functions/_shared/agent/turn_notes.ts";
import { APPROVAL_RULES, approvalRulesText, PER_ITEM_APPROVAL } from "../../../supabase/functions/_shared/agent/approval_rules.ts";
import { YES_WINDOW_MS } from "../../../supabase/functions/_shared/career_apply_cards.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../../../supabase/functions/_shared/career_tailor.ts";
import { POSTINGS } from "../../../evals/mirror/instinct-wa-batch1/world.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DIR = new URL("../../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const TURNS: { id: string; prompt: string }[] = Deno.readTextFileSync(new URL("prompts.jsonl", DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const PERSONA: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
const NOW = Date.parse("2026-11-16T15:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}

Deno.test("CU-1 the approval rules the brain reads are built from the approval code: one yes approves exactly the batch shown", async () => {
  const t = approvalRulesText();
  eq(APPROVAL_RULES.yesWindowMinutes, YES_WINDOW_MS / 60_000, "the window is the card code's");
  ok(t.includes(`${YES_WINDOW_MS / 60_000} minutes`), t);
  ok(/one yes approves exactly the applications that card shows/.test(t) && /one yes approves exactly the batch of messages shown/.test(t), t);
  ok(!PER_ITEM_APPROVAL.test(t), "the rules themselves never say one by one");
  // Every fixed piece of the brain's prompt, and the capacity note C12 gets, agree with them.
  for (const [name, piece] of [["system prompt", careerSystemPrompt("2026-11-16")], ["mirror rules", MIRROR_RULES], ["capacity note", capacityNote()]] as const) ok(!PER_ITEM_APPROVAL.test(piece), `${name}: ${PER_ITEM_APPROVAL.exec(piece)?.[0]}`);
  ok(/HOW APPROVAL WORKS/.test(capacityNote()), "the capacity note points at the rules");
  // The brain sees them on every turn, exactly.
  const seen: any[] = [];
  await agentTurn({ message: TURNS.find((x) => x.id === "C12")!.prompt, history: [], stores: { profile: personaProfile() }, userId: "u-cu1", threadId: "th", now: NOW,
    model: async (p: any) => { seen.push(p); return text("I haven't verified that pace."); } } as any);
  ok(String(seen[0].system).includes(t), "HOW APPROVAL WORKS is in the system prompt as built");
});

Deno.test("CU-2 C10: the tailored resume for a software posting leads with what shows the posting's skills, not the newest role", async () => {
  const p = POSTINGS[0];
  const tailor = { posting: async () => ({ job_id: p.id, title: p.title, company: p.company, description: p.description }), personas: { get: async () => ({ items: [], active: null }), put: async () => {} } as any, resumes: memoryResumeStore(), render: edgeRenderer(), deliver: () => {} };
  const results: string[] = [];
  const model = async (q: any) => {
    const last = q.messages.at(-1);
    if (Array.isArray(last?.content)) for (const b of last.content) if (b.type === "tool_result") results.push(String(b.content));
    return results.length ? text("Here is the review draft. Nothing was submitted.") : use("tailor_resume", { job_id: p.id });
  };
  const r: any = await agentTurn({ message: TURNS.find((x) => x.id === "C10")!.prompt, history: [], stores: { profile: personaProfile() }, userId: "00000000-0000-4000-8000-000000001611", threadId: "th", now: NOW, model, tailor } as any);
  eq(r.tool_calls.map((c: any) => [c.name, c.ok]), [["tailor_resume", true]], results[0]?.slice(0, 300));
  const out = JSON.parse(results[0]);
  const preview = String(out.preview ?? "");
  const exp = preview.slice(preview.indexOf("EXPERIENCE")).split("\n").slice(1, 3).join(" | ");
  ok(/^Crestline/.test(exp) && /\| Pixelforge/.test(exp), `the first entries show the posting's skills (Python; React for JavaScript): ${exp}`);
  ok(/led with/i.test(String(out.changelog ?? "")) && /from the posting/.test(String(out.changelog ?? "")), `the changelog says what moved up and why: ${out.changelog}`);
  // The whole order: skills first, then entries sharing the title's words ("software"), then the rest, each tier newest first.
  const profile = personaProfile();
  const base = { userId: "00000000-0000-4000-8000-000000001612", profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true };
  const v: any = await tailorForPosting({ ...base, order: "relevance" } as any);
  const heads = v.detail.doc.lines.filter((l: any) => l.section === "Experience" && l.type === "entry").map((l: any) => String(l.text).split(",")[0]);
  const i = (w: string) => heads.indexOf(w);
  ok(i("Crestline Partners") < i("Pixelforge") && i("Pixelforge") < i("Rallyup") && i("Rallyup") < i("Elmstead") && i("Elmstead") < i("Mindgrove AI Research"), heads.join(" | "));
  eq(heads.length, 9, "every entry still prints");
});
