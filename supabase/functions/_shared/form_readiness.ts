// WO-121 (D-042 M4, D-007): a captured form (posting_schema.ts) mapped to what each field asks, once per posting, and then,
// per person, which fields their CONFIRMED facts answer. Pure: no I/O and no model. Code decides, never a guess:
//   - a value comes only from a fact with confirmed: true; anything else is no fact;
//   - a select, radio or multiselect takes only one of the form's own options (career_apply.ts matchOption), else it is
//     asked (option_not_matched), never the nearest option;
//   - an essay, an attestation (or consent the form requires) and a question the map does not place are asked, never drafted;
//   - an identity number, bank or card number or secret is typed by the person on the form (NEVER_BY_TEXT);
//   - a work-rights question about another country, or one that asks beyond what the fact says, is asked (WO-052/WO-055);
//   - a self-identification (EEO) answer is never carried from one generic fact (question_map.ts answerKey, round 4);
//   - an optional field with no confirmed fact is sent empty (left_blank), never guessed.
import { beyondFact, matchOption, otherCountry } from "./career_apply.ts";
import { type Kind, mapQuestion, NEVER_BY_TEXT } from "./question_map.ts";
import type { FormSchema } from "./posting_schema.ts";

export interface MappedField { id: string; label: string; required: boolean; fact: string | null; kind: Kind }
export interface ConfirmedFact { id: string; key: string; value: string; confirmed: true }
export type NeedsWhy = "no_confirmed_fact" | "essay" | "attestation" | "unknown_question" | "option_not_matched";
export interface Readiness {
  ready: boolean;
  answered: { id: string; fact: string; value: string; fact_id: string }[];
  needs_answer: { id: string; label: string; why: NeedsWhy }[];
  never_by_text: { id: string; label: string }[];
  left_blank: string[];
}

// Person-independent: what each field asks (stored with the schema). Holds no value.
export function mapForm(s: FormSchema): MappedField[] {
  return s.fields.map((f) => {
    const m = mapQuestion({ label: f.label, type: f.type, options: f.options.map((o) => ({ label: o.label })) });
    return { id: f.id, label: f.label, required: f.required, fact: m.fact === "unknown" ? null : m.fact, kind: m.kind };
  });
}

export function formReadiness(mapped: MappedField[], schema: FormSchema, facts: ConfirmedFact[]): Readiness {
  const r: Readiness = { ready: false, answered: [], needs_answer: [], never_by_text: [], left_blank: [] };
  // Only confirmed facts; a key with two different confirmed values is no single fact.
  const byKey = new Map<string, ConfirmedFact | null>();
  for (const f of facts) {
    if (f?.confirmed !== true || typeof f.value !== "string" || !f.value.trim()) continue;
    const had = byKey.get(f.key);
    byKey.set(f.key, had === undefined ? f : had && had.value === f.value ? had : null);
  }
  const fields = new Map(schema.fields.map((f) => [f.id, f]));
  for (const m of mapped) {
    const field = fields.get(m.id);
    if (!field) continue;
    const ask = (why: NeedsWhy) => r.needs_answer.push({ id: m.id, label: m.label, why });
    const noFact = () => (m.required ? ask("no_confirmed_fact") : r.left_blank.push(m.id));
    if (field.type === "hidden") { r.left_blank.push(m.id); continue; }
    if (NEVER_BY_TEXT.test(m.label)) { r.never_by_text.push({ id: m.id, label: m.label }); continue; }
    if (m.kind === "essay") { ask("essay"); continue; }
    if (m.kind === "attestation") { ask("attestation"); continue; }
    if (m.kind === "consent") { m.required ? ask("attestation") : r.left_blank.push(m.id); continue; }
    if (m.kind === "unknown" || !m.fact) { ask("unknown_question"); continue; }
    if (m.fact === "eeo") { noFact(); continue; }
    if (otherCountry(m.fact, m.label) || beyondFact(m.fact, field)) { noFact(); continue; }
    const fact = byKey.get(m.fact);
    if (!fact) { noFact(); continue; }
    let value = fact.value;
    if (field.options.length) {
      const v = matchOption(fact.value, field.options);
      const opt = v === null ? undefined : field.options.find((o) => o.value === v);
      if (!opt) { ask("option_not_matched"); continue; }
      value = opt.label;
    }
    r.answered.push({ id: m.id, fact: m.fact, value, fact_id: fact.id });
  }
  r.ready = r.needs_answer.length === 0 && r.never_by_text.length === 0;
  return r;
}
