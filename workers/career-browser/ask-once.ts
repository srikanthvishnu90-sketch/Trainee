// Ask once, on the person's own computer: the pure half shared by the desktop runner (approve-first.ts) and the browser
// extension (extension/lib/trainee-core.js). No Deno, no Node: it runs in a page. Moved unchanged from approve-first.ts
// (WO-031), which re-exports every name, so both paths store and read answers the same way.
import { answerKey, mapQuestion, NEVER_BY_TEXT } from "../../supabase/functions/_shared/question_map.ts";
import { aiPolicyStatements } from "../../supabase/functions/_shared/ai_policy.ts";
import { factStaysHere } from "../../supabase/functions/_shared/career_apply.ts";
import { decodeRowQuestionType } from "../../supabase/functions/_shared/row_answer.ts";

// Ask once: the answers the person texted, as the engine's confirmed facts for the next preparation. A fact for every
// employer goes under the fact's name (their own facts file wins when it states the same fact); an answer for one wording
// or one posting goes under its key, which planBatch reads for that question only. Each is marked as a texted answer.
export interface TextAnswer { id: string; key: string; kind: string; answer: string }
export function factsWithTextAnswers(facts: any, rows: TextAnswer[]) {
  const answers = { ...(facts?.answers || {}) }, saved = { ...(facts?.saved || {}) };
  for (const r of rows || []) {
    if (!r || typeof r.answer !== "string" || !r.answer.trim() || typeof r.key !== "string") continue;
    const a = { value: r.answer, factId: `text-answer:${r.id}`, confirmed: true };
    if (r.key.startsWith("fact:")) {
      const f = r.key.slice(5);
      if (!Object.hasOwn(answers, f)) answers[f] = a;
    } else if (/^(label|job):[0-9a-f]{16}$/.test(r.key)) saved[r.key] = a;
  }
  return { ...facts, answers, saved };
}

// The questions that stopped one preparation, as rows to ask by text: keyed by how far an answer may travel (a stated fact
// that did not fit this form is asked for this posting only), never one asking for an identity, bank or card number or a
// password, and marked misfit when a question already answered came back because this form's options do not fit.
export function questionsToStore(result: any, o: { facts: Record<string, unknown>; answered: Set<string> }) {
  const posting = String(result?.posting || "");
  const out = new Map<string, Record<string, unknown>>();
  if (!posting) return { posting, questions: [] as Record<string, unknown>[] };
  // The form's own words about AI help go with each written answer of this posting (WO-030): Trainee reads them before it
  // drafts one, even when a standing consent already answered that statement on the form.
  const aiPolicy = aiPolicyStatements(Array.isArray(result?.ai_policy) ? result.ai_policy : []).join("\n").slice(0, 1200);
  for (const q of Array.isArray(result?.questions) ? result.questions : []) {
    // a-sensitive: the key is the full label's (the planner reads it so); only the stored text is cut. A cut label's key
    // was one the planner never reads (Lever's 1,165-character "Race" question was asked again after every answer).
    const full = String(q?.label ?? "").replace(/\s+/g, " ").trim(), label = full.slice(0, 600);
    if (!label || NEVER_BY_TEXT.test(full)) continue;
    const options = (Array.isArray(q.options) ? q.options : []).map((x: unknown) => String(x).slice(0, 300)).slice(0, 60);
    const rawType = String(q.type || "input_text"), row = decodeRowQuestionType(rawType);
    if (rawType.startsWith("row:") && !row) continue; // malformed/unbound rows never become generic label answers
    const type = rawType.slice(0, 40);
    const shape = { label: full, type, options: options.map((l: string) => ({ label: l })) };
    const m = row ? { kind: "unknown", fact: "unknown" } : mapQuestion(shape);
    // WO-055: the posting's location (as its page shows it) decides whether an answer may become the person's fact.
    const here = factStaysHere(shape, result?.location ? String(result.location) : undefined, o.facts);
    const key = row?.key ?? answerKey(shape, posting, { haveFact: m.kind === "fact" && Object.hasOwn(o.facts, m.fact), here });
    if (out.has(key)) continue;
    out.set(key, {
      key, kind: m.kind, label, type, options, company: result?.company ? String(result.company).slice(0, 200) : null, misfit: o.answered.has(key),
      ...(m.kind === "essay" && aiPolicy ? { ai_policy: aiPolicy } : {}),
    });
  }
  return { posting, questions: [...out.values()] };
}

// The role a Supabase key or session token claims, read from its payload without verifying it: used only to refuse a
// service key on a person's computer. Anything unreadable has no role.
export function jwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4))).role ?? null;
  } catch {
    return null;
  }
}
