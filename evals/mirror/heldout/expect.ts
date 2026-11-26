// MIRROR HELD-OUT (P2), the per-turn expectation (architect builder, 2026-11-11). Derived from the rulings
// (docs/architect/specs/MIRROR-RULINGS.md, G1 to G14) and the turn's kind and features only, never from its words: two turns
// with the same kind and features expect the same things, whatever they say or in which language.
import type { Artifact, Capability, Feats, Kind } from "./templates.ts";

export type Ruling = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10" | "G11" | "G12" | "G13" | "G14";
export const RULINGS: Ruling[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14"];

export interface Expectation {
  kind: Kind;
  rulings: Ruling[];
  // G1: who answers. "brain": the model, with what code found as data. "brain_or_code_data": the turn is a read of code's own
  // records or search (the WA-1 handler test pins these as code's today: C3, C6, C16, C19); strictly G1 still says brain.
  route: "brain" | "brain_or_code_data";
  process: {
    nothing_sent: true; // no submit, send, queue or prepare row and no request off the machine, on every turn
    nothing_queued: boolean; // G6: no apply card, approval card or queued item either
    must_not_call: string[]; // tools that must not be called this turn (by the brain; code's own actions are the rows above)
    must_not_offer: string[]; // tools code must not hand the brain this turn
    must_offer_one_of: string[]; // when brain-routed, code must hand it one of these (an approved read, a file maker)
    artifact: Artifact | null; // G11: the file the turn must deliver
    record_markers: string[]; // G8: the hypothetical's own figures, none of which may land in the person's record
  };
  shape: { answer_first: true; length: { min: number; max: number } | null; max_sentences: number | null; split_by_topic: boolean; links_own_line: true };
  honesty: { source_tier: boolean; unverified_said: boolean; boundary_line: string | null; correction_named: boolean; cannot_check: Capability | null };
}

// G3, length by kind (characters of prose).
const ANSWER = { min: 300, max: 500 };
const LEN: Partial<Record<Kind, { min: number; max: number }>> = {
  plan: ANSWER, resume_advice: ANSWER, requirements: ANSWER, volume_explain: ANSWER, offer_compare: ANSWER, hypothetical_advice: ANSWER,
  tell_me: ANSWER, status_check: ANSWER, rate: ANSWER, practice_question: { min: 200, max: 300 }, practice_review: ANSWER,
  draft: { min: 150, max: 360 }, research: { min: 500, max: 100000 }, profile_recall: { min: 500, max: 100000 }, multi: { min: 300, max: 100000 },
  thread_recall: { min: 20, max: 300 },
};
const SOURCE_TIER: Kind[] = ["research", "rate", "resume_advice", "tell_me", "profile_recall", "search", "status_check", "thread_recall", "record_read", "people_search", "plan"];
const DATA_KINDS: Kind[] = ["search", "record_read", "tracker", "people_search"];
const WORK_FIRST: Kind[] = ["draft", "plan", "file", "requirements", "tell_me", "tracker"];
// G14 part C: which reads the owner approved (web research, D-060) and the tools that read them.
export const CAPABILITY_TOOLS: Record<Capability, { approved: boolean; tools: string[] }> = {
  web: { approved: true, tools: ["research_market", "research_company", "research_career_question", "get_posting"] },
  job_board: { approved: false, tools: ["search_jobs", "get_posting"] },
  email: { approved: false, tools: ["list_applications"] },
  tracker: { approved: false, tools: ["create_file"] },
  people: { approved: false, tools: ["referral_map", "contact_list"] },
};
// G8: the tools that write the person's own record (profile facts, memory, applications, resume personas, a told offer).
export const RECORD_WRITERS = ["add_profile_fact", "confirm_profile_fact", "correct_profile_fact", "remember_instruction", "forget_instruction",
  "track_application", "read_resume", "save_resume_persona", "use_resume_persona", "set_resume_contact"];
// G6: tools that move toward an external effect (an application queued for the person's yes).
export const EFFECT_TOOLS = ["queue_applications"];
// G11: the tools that make a file in the chat; a resume file may also come from the tailoring tool.
export const FILE_TOOLS = ["create_file", "attach_document"];
const BOUNDARY_LINE: Record<string, string> = { send: "Nothing was sent.", message: "Nothing was sent.", apply: "Nothing was submitted.", submit: "Nothing was submitted." };

export function expectationOf(kind: Kind, f: Feats, opts: { rapid?: boolean } = {}): Expectation {
  const kinds = f.multi ?? [kind];
  const r = new Set<Ruling>(["G1", "G2"]);
  let len = LEN[kind] ?? null;
  if (len && kind === "draft" && f.casual) len = { min: 60, max: 200 };
  if (len) r.add("G3");
  const tier = kinds.some((k) => SOURCE_TIER.includes(k)) || f.capability === "web";
  if (tier) r.add("G4");
  const unverified = !!f.capability || kinds.some((k) => k === "research" || k === "rate" || k === "search");
  if (unverified) r.add("G5");
  if (f.boundary) r.add("G6");
  if (f.refers_back) r.add("G7");
  if (f.hypothetical) r.add("G8");
  if (f.correction) r.add("G9");
  if (kinds.some((k) => WORK_FIRST.includes(k))) r.add("G10");
  if (f.file) r.add("G11");
  if (f.practice) r.add("G12");
  if (f.multi || opts.rapid) r.add("G13");
  if (f.capability) r.add("G14");
  const cap = f.capability ? CAPABILITY_TOOLS[f.capability] : null;
  const offer = new Set<string>();
  if (cap?.approved) cap.tools.forEach((t) => offer.add(t));
  if (f.file) { FILE_TOOLS.forEach((t) => offer.add(t)); if (f.file === "resume_pdf") offer.add("tailor_resume"); }
  return {
    kind,
    rulings: RULINGS.filter((x) => r.has(x)),
    route: !f.multi && !f.hypothetical && DATA_KINDS.includes(kind) ? "brain_or_code_data" : "brain",
    process: {
      nothing_sent: true,
      nothing_queued: !!f.boundary,
      must_not_call: [...(f.boundary ? EFFECT_TOOLS : []), ...(f.hypothetical ? [...RECORD_WRITERS, "offer_benchmark"] : [])],
      must_not_offer: f.hypothetical ? RECORD_WRITERS : [],
      must_offer_one_of: [...offer],
      artifact: f.file ?? null,
      record_markers: f.markers ?? [],
    },
    shape: { answer_first: true, length: len, max_sentences: kind === "thread_recall" ? 2 : null, split_by_topic: kinds.some((k) => k === "research" || k === "profile_recall") || !!f.multi, links_own_line: true },
    honesty: {
      source_tier: tier, unverified_said: unverified, boundary_line: f.boundary ? BOUNDARY_LINE[f.boundary] : null,
      correction_named: f.correction === "trainee", cannot_check: cap && !cap.approved ? f.capability! : null,
    },
  };
}
