// Step 1 of the open-question pipeline: understand. From the Person Context Pack (confirmed facts first) and the message, decide
// the field, the stage, the place, the kind of question, and whether ONE question is worth asking. Everything the pack does not
// say becomes a stated assumption in the brief; nothing is inferred by a model.
import type { ContextPack } from "../knowledge/context_pack.ts";
import { FIELDS, genericField, OVERLAYS, type Field, type Overlay } from "./fields.ts";
import type { Derived } from "./derive.ts";

export type StageGroup = "early_student" | "late_student" | "new_grad" | "grad_student" | "switcher" | "displaced" | "experienced" | "unknown";
export type QType = "get_hired" | "switch" | "pay" | "credential" | "timeline" | "open";
export interface Understanding {
  field: Field | null; stage: StageGroup; stageLabel: string; year: string | null; geo: string; geoKey: string; qtype: QType;
  overlays: Overlay[]; assumptions: string[]; ask: string | null;
  confirmed: string[]; said: string[];      // facts about the person, by status; only `confirmed` may be stated as fact
}
const STAGE_LABEL: Record<StageGroup, string> = { early_student: "an early-stage student", late_student: "a student near graduation", new_grad: "a new graduate", grad_student: "a graduate student", switcher: "a career changer", displaced: "someone between jobs after a layoff", experienced: "an experienced professional", unknown: "someone early in their career" };
const NON_US = /\b(uk|united kingdom|england|scotland|canada|ontario|india|australia|germany|ireland|singapore|nigeria|mexico|brazil|france|netherlands)\b/i;

// After "I want to / looking to", the field is what they are heading for, not what they do now.
function targetClause(m: string): string {
  const i = m.search(/\b(?:want(?:ed)? to|trying to|looking to|hoping to|would like to|plan(?:ning)? to|how (?:do|can|should) i)\b/i);
  return i >= 0 ? m.slice(i) : m;
}
export function detectField(message: string, extra: string[] = []): Field | null {
  const score = (text: string) => FIELDS.map((f) => ({ f, n: (text.match(new RegExp(f.detect.source, "gi")) ?? []).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n)[0]?.f ?? null;
  return score(targetClause(message)) ?? score(message) ?? score(extra.join(" . "));
}
function stageOf(pack: ContextPack, message: string): StageGroup {
  const tags = new Set(pack.overlays.map((o) => o.tag));
  if (tags.has("stage:career_changer")) return "switcher";
  if (tags.has("stage:laid_off") || /laid off|layoff|let go|redundan|downsiz/i.test(message)) return "displaced";
  if (/\bmba\b/i.test(message)) return "grad_student";
  if (/\bapprentice\b|\bveteran\b/i.test(message)) return "experienced";
  switch (pack.stage.value) {
    case "freshman": case "sophomore": return "early_student";
    case "junior": case "senior": return "late_student";
    case "new grad": return "new_grad";
    case "grad student": return "grad_student";
    case "mid career": return "experienced";
  }
  if (/\b(?:new grad(?:uate)?|just graduated|recent grad|bootcamp grad)\b|\bgrad(?:uated)? (?:in|this|last)\b/i.test(message) || tags.has("stage:bootcamp")) return "new_grad";
  if (/\bmba\b/i.test(message)) return "grad_student";
  if (/\bapprentice\b|\bveteran\b/i.test(message)) return "experienced";
  if (/\b(?:community college|transfer)\b/i.test(message)) return "early_student";
  return "unknown";
}
function qtypeOf(m: string): QType {
  if (/\b(?:switch|change careers?|career change|pivot|transition|move (?:out of|into))\b/i.test(m)) return "switch";
  if (/\b(?:salary|pay|earn|make per|compensation)\b/i.test(m)) return "pay";
  if (/\b(?:certif|licen[sc]e|degree|do i need|prerequisite|requirements?)\b/i.test(m)) return "credential";
  if (/\b(?:timeline|when (?:do|should|does)|how long|deadline|recruiting (?:season|cycle))\b/i.test(m)) return "timeline";
  if (/\bhow (?:do|can|should|to) i\b|\bget (?:hired|a job|into)\b|\bbreak into\b|\bbecome\b/i.test(m)) return "get_hired";
  return "open";
}
const strs = (k: { value: string[] | string | null; status: string }, st: string): string[] => k.status === st && k.value ? (Array.isArray(k.value) ? k.value : [k.value]) : [];

const dedupe = (xs: string[]) => [...new Set(xs)].filter((x, i, a) => !a.some((y, j) => j !== i && y.length > x.length && y.toLowerCase().includes(x.toLowerCase())));
export function understand(o: { pack: ContextPack; message: string; derived?: Derived | null }): Understanding {
  const { pack, message, derived } = o;
  const all = [pack.education, pack.experience, pack.skills, pack.projects, pack.goals];
  const catalog = detectField(message, [...strs(pack.goals, "confirmed"), ...strs(pack.goals, "said"), ...strs(pack.major, "confirmed"), ...strs(pack.major, "said")]);
  const field = catalog ?? (derived ? genericField(derived.label, derived.local) : null);
  const stage = stageOf(pack, message) === "unknown" && derived?.stage ? derived.stage : stageOf(pack, message);
  const hay = [message, ...pack.said_in_chat, ...all.flatMap((k) => k.value ?? [])].join(" . ");
  const tag = (t: string) => pack.overlays.some((x) => x.tag === t);
  const overlays = OVERLAYS.filter((v) => v.detect.test(hay) || (v.id === "intl" && tag("ctx:international")) || (v.id === "first_gen" && tag("ctx:first_gen")) || (v.id === "veteran" && tag("stage:military")) || (v.id === "displaced" && stage === "displaced"));
  const place = strs(pack.places, "confirmed")[0] ?? strs(pack.places, "said")[0] ?? derived?.place ?? /\b(?:in|near|around|from) ((?:[A-Z][a-z]+)(?: [A-Z][a-z]+)?)\b(?=[ ,.?!]|$)/.exec(message)?.[1] ?? null;
  const assumptions: string[] = [];
  const geo = place ?? "the US", geoKey = place ? place.toLowerCase().replace(/[^a-z ]/g, "").trim() : "us";
  if (!place) assumptions.push("Assuming you're in the US; if not, the places and rules below change.");
  else if (NON_US.test(place)) assumptions.push(`The sources I can retrieve are mostly US sources; treat any figure as a US figure and check ${place} sources.`);
  if (stage === "unknown") assumptions.push("I don't know your stage, so this is written for someone early in their career.");
  const confirmed = [...all.flatMap((k) => strs(k, "confirmed")), ...strs(pack.major, "confirmed"), ...strs(pack.places, "confirmed")];
  const said = [...all.flatMap((k) => strs(k, "said")), ...strs(pack.major, "said")];
  // At most ONE question, and only when its answer changes the advice.
  let ask: string | null = null;
  if (!field) ask = "Which role or field are you aiming for?";
  else if (field.local && !place) ask = `Which state are you in? ${field.label[0].toUpperCase() + field.label.slice(1)} licensing and hiring rules are set by each state.`;
  const yr = String(pack.stage.value ?? "").toLowerCase(), year = /^(?:freshman|sophomore|junior|senior)$/.test(yr) ? yr : null;
  return { field, stage, stageLabel: STAGE_LABEL[stage], year, geo, geoKey, qtype: qtypeOf(message), overlays, assumptions, ask, confirmed: dedupe(confirmed), said: dedupe(said) };
}
