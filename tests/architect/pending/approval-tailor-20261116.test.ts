// The 10/10 rubric's gap #8 (2026-11-16; evals/mirror/instinct-wa-batch1/, live-12 C10 and C12), at $0 with a scripted model through
// the real brain turn (agentTurn) and the real tailor_resume tool.
//   CU-1  the approval rules the brain reads come from the approval code: built from APPROVAL_RULES, the yes window read from
//         career_apply_cards.ts, a batch yes, never "one by one"; the capacity note (C12) points at them
//   CU-2  C10 (architect ruling 2026-11-16): a resume tailored to a software posting splits its experience into Relevant Experience
//         (entries showing the posting's skills or its kind of work) then Additional Experience, each newest first, so a
//         go-to-market role never leads; entries are never reordered inside a section (E5); without the split, with fewer than
//         four entries, or on an edited version, one section stays
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

Deno.test("CU-2 C10: a tailored resume splits experience into Relevant then Additional Experience, each newest first", async () => {
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
  ok(/RELEVANT EXPERIENCE/i.test(preview) && !/^Elmstead/m.test(preview.slice(preview.search(/RELEVANT EXPERIENCE/i)).split("\n").slice(1, 2).join("")), `the tool's resume does not split, or a go-to-market role leads: ${preview.slice(0, 500)}`);
  ok(/Split your experience for this posting: \d+ under Relevant Experience/.test(String(out.changelog ?? "")), `the changelog says what moved: ${out.changelog}`);
  // The whole document: the two sections in place of Experience, every entry once, each section newest first (E5).
  const base = { userId: "00000000-0000-4000-8000-000000001612", profile: personaProfile(), posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true };
  const v: any = await tailorForPosting({ ...base, split: "relevance" } as any);
  ok(v.ok, JSON.stringify(v).slice(0, 300));
  const of = (sec: string) => v.detail.doc.lines.filter((l: any) => l.section === sec && l.type === "entry").map((l: any) => String(l.text).split(",")[0]);
  const rel = of("Relevant Experience"), add = of("Additional Experience");
  ok(rel.includes("Pixelforge") && rel.includes("Crestline Partners") && !rel.includes("Elmstead"), rel.join(" | "));
  ok(add.includes("Elmstead") && add.indexOf("Elmstead") < add.indexOf("Mindgrove AI Research"), add.join(" | "));
  ok(rel.indexOf("Crestline Partners") < rel.indexOf("Pixelforge"), `newest first inside Relevant Experience: ${rel.join(" | ")}`);
  eq(rel.length + add.length, 9, "every entry prints once");
  eq(of("Experience"), [], "no third section");
  // Without the split, the single newest-first section stays (D-071).
  const plain: any = await tailorForPosting(base as any);
  eq(plain.detail.doc.lines.filter((l: any) => l.section === "Relevant Experience").length, 0);
  const edited: any = await tailorForPosting({ ...base, split: "relevance", edits: [{ role: "pixelforge", lines: 1 }] } as any);
  eq(edited.detail.doc.lines.filter((l: any) => l.section === "Relevant Experience").length, 0, "an edited version keeps the order its edits set");
  const short = personaProfile();
  short.facts = short.facts.filter((f: any) => f.kind !== "experience" || /Pixelforge|Elmstead|Mindgrove/.test(String(f.text)));
  const few: any = await tailorForPosting({ ...base, profile: short, split: "relevance" } as any);
  eq(few.detail.doc.lines.filter((l: any) => l.section === "Relevant Experience").length, 0, "three entries stay in one section");
});
