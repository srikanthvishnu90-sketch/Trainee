// Any field: the model reads the question and the person's CONFIRMED facts and names the occupation they are asking about (and,
// when the pack could not tell, the stage and the place). Code validates the answer; a bad or missing answer means "ask the one
// question", never a guess. The catalog in fields.ts is only a hint for fields it happens to know.
import type { StageGroup } from "./understand.ts";

export interface Derived { label: string; local: boolean; stage?: StageGroup; place?: string }
export type DeriveFn = (input: { question: string; confirmed: string[] }) => Promise<Derived | null>;
const STAGES = new Set(["early_student", "late_student", "new_grad", "grad_student", "switcher", "displaced", "experienced"]);
const LOCAL = /\b(licen[sc]|certif|board|registered|credential)/i;

export function validateDerived(j: any): Derived | null {
  const label = String(j?.field ?? j?.label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (label.length < 3 || label.length > 60 || !/^[a-z][a-z &/'-]*$/.test(label)) return null;
  if (/\b(unknown|unclear|none|n\/a|career|job|work|anything)\b/.test(label) && label.split(" ").length < 3) return null;
  const place = typeof j?.place === "string" && /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(j.place.trim()) ? j.place.trim() : undefined;
  return { label, local: j?.licensed === true || (j?.licensed === undefined && LOCAL.test(String(j?.note ?? ""))), stage: STAGES.has(j?.stage) ? j.stage : undefined, place };
}
export function modelDerive(call: (system: string, user: string) => Promise<string>): DeriveFn {
  return async ({ question, confirmed }) => {
    try {
      const text = await call(
        "You name the occupation a person is asking about. Reply with JSON only: {\"field\":\"the occupation or field in 1 to 4 plain words, lower case, e.g. dental hygienist\",\"licensed\":true|false (does entry usually need a state or national license),\"stage\":\"early_student|late_student|new_grad|grad_student|switcher|displaced|experienced|unknown\",\"place\":\"city, state or country the person said, or empty\"}. Use only the question and the confirmed facts. If you cannot tell the occupation, set field to \"unknown\".",
        `Question: ${question.slice(0, 600)}\nConfirmed facts: ${confirmed.slice(0, 8).join("; ").slice(0, 600) || "none"}`);
      return validateDerived(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    } catch { return null; }
  };
}
