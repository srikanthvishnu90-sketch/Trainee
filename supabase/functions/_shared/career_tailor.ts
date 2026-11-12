// WO-028: a resume tailored to one posting, in chat. It selects, orders and rewords only from the person's CONFIRMED
// facts (drafts never reach it), passes the truth audit (123's hard gate) twice, renders one PDF (148), passes the ATS
// parse harness before it may be offered, is stored privately at career-resumes/<user_id>/<sha256>.pdf and goes out as
// a link signed for 7 days, with a one-line changelog built only from the diff against the person's base resume.
// Personas ("banking", "data") are saved selections and orders over the same confirmed facts, never other facts.
// callbackRate is the tailored-vs-untailored report the instrumentation feeds.
//
// Where the PDF renders: 148 loads zlib and crypto with CommonJS require, which the Deno bundle does not have, so its
// default instance in Deno refuses ("zlib is unavailable in this runtime"). Deno does ship node:zlib, node:crypto and
// node:buffer; edgeRenderer() loads those on its first render (not at import, so the chat's module graph stays plain)
// and hands them to CareerRender.withRuntime; the bytes are the same as Node's (same code, checked in
// tests/architect/wo-028-tailor.test.ts). If those built-ins are missing where it runs, the renderer says so and the
// tool refuses; nothing is stored or linked.
import { CareerProfile, CareerRender, CareerTailor } from "./router_core.career.js";
import { documentLines, guardMaterials } from "./career_materials_guard.ts";
import { type DesignLayout, type Fit, type FitRecord, fitRecord, newestFirst, type OwnFact, renderDesigned, type Swap } from "./career_resume_design.ts";
import type { TemplateId, TemplateSpec } from "./career_resume_templates.ts";
import { gapAnalysis, type GapReport, previewText } from "./career_resume_gaps.ts";

export const RESUME_BUCKET = "career-resumes";
export const LINK_TTL_SECONDS = 7 * 86400;
export const MIN_PER_ARM = 30;
export const MAX_PERSONAS = 10;
export const PERSONAS_KEY = "career:resume-personas";

// ---------------------------------------------------------------- the confirmed-only record
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
// A fresh profile holding only the person's confirmed facts: a draft is not in it at all, so it cannot support a line,
// vouch for a skill name, or be picked. A skill the person listed and confirmed is its own proof (listedSkillsProven).
export function confirmedOnly(profile: any): any {
  const facts = (CareerProfile.confirmedFacts(profile || {}) as any[]).filter((f) => f.status !== "draft").map(clone);
  return listedSkillsProven(withResumeHeader(CareerProfile.createProfile({ id: profile?.id, basics: clone(profile?.basics || {}), facts }), profile));
}
// Architect ruling 2026-11-10 (resume loop): a skill the person listed in their own confirmed Skills is a confirmed fact
// (D-007), so it is its own proof and is shown; 123's proof rule (skillFactProven, BUG-211) otherwise left every bare listed
// skill off, and the Skills section vanished. Only confirmed skill facts are marked (a draft is not in this profile at all),
// and a skill only the posting names has no fact here, so it stays off.
// deno-lint-ignore no-explicit-any
export function listedSkillsProven(p: any): any {
  for (const f of p?.facts || []) {
    if (f?.kind !== "skill" || f.needs_confirmation || f.status === "draft" || !String(f.name || f.title || "").trim()) continue;
    if (!(f.evidence || []).length) f.evidence = [String(f.id)];
    f.unproven = false;
    // D-063 (C10): one listed entry naming two skills with a slash ("TypeScript/JavaScript") is both of the person's own listed
    // skills, so each part is its own proof as the whole is; the line still prints what they wrote. Without this the truth check
    // refused the person's own Skills line ('skill "JavaScript" is not evidenced').
    const parts = String(f.name || f.title).split("/").map((x) => x.trim()).filter((x) => x.length > 0);
    if (parts.length > 1 && parts.every((x) => /^[\p{L}\p{N}+#. -]{1,30}$/u.test(x))) f.skills = [...new Set([...(f.skills || []), ...parts])];
  }
  return p;
}
// The same ruling on the printed page: 123 scopes the Skills line to the posting's family (BUG-273), which dropped the
// person's own listed skills and, with none in scope, the whole section. The posting's skills keep leading; every other
// confirmed listed skill follows on the same line, each cited to its own fact; a Skills section is added when the tailor
// left none. Nothing but the person's confirmed skill facts is ever added.
// deno-lint-ignore no-explicit-any
export function withListedSkills(resume: any, p: any): any {
  const own = (p?.facts || []).filter((f: any) => f?.kind === "skill" && !f.needs_confirmation && f.status !== "draft" && String(f.name || f.title || "").trim());
  if (!own.length) return resume;
  const out = clone(resume);
  out.sections = out.sections || [];
  let line = out.sections.flatMap((s: any) => s.lines || []).find((l: any) => l?.type === "skills");
  if (!line) {
    line = { text: "", factIds: [], type: "skills" };
    out.sections.push({ heading: "Skills", lines: [line] });
  }
  const norm = (s: string) => ` ${String(s).toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim()} `;
  const named = String(line.text || "");
  const add: string[] = [];
  for (const f of own) {
    const name = String(f.name || f.title).trim();
    if (norm(named).includes(norm(name)) || add.some((a) => norm(a) === norm(name))) continue;
    add.push(name);
    line.factIds = [...new Set([...(line.factIds || []), String(f.id)])];
  }
  if (add.length) line.text = named.trim() ? `${named.trim()}, ${add.join(", ")}` : add.join(", ");
  if (Array.isArray(out.lines)) out.lines = out.sections.flatMap((s: any) => (s.lines || []).map((l: any) => ({ ...l, section: s.heading })));
  return out;
}
// RELEASE 9: the header the person confirmed with their resume (142 confirmResumeHeader: shown word for word with the
// entries, recorded only at their yes, with its time) travels with the confirmed record; one never confirmed does not.
// 123 prints it only where no name was typed for the resume (set_resume_contact wins).
// deno-lint-ignore no-explicit-any
function withResumeHeader(p: any, from: any): any {
  const h = from?.resume_header;
  if (h && typeof h === "object" && typeof h.name === "string" && h.name.trim() && typeof h.confirmed_at === "string" && h.confirmed_at) p.resume_header = clone(h);
  return p;
}
// The name and email at the top of the file: the ones typed for the resume, else the header the person confirmed with it,
// piece by piece (H2H leftovers 1: a confirmed header with a name and no email kept its name, and only the email was asked).
// 123's headerOf rule, so what is checked here is what prints. A header counts only once confirmed (its confirmed_at).
// contact "typed" takes only the typed ones (prepare-ahead: the form needs the first name, last name and email as answers,
// and asks for them once).
// deno-lint-ignore no-explicit-any
export function resumeContact(p: any, contact: "typed" | "confirmed" = "confirmed"): { name: string | null; email: string | null } {
  const b = p?.basics || {}, rh = contact === "confirmed" ? p?.resume_header : null;
  const h = rh && typeof rh === "object" && rh.confirmed_at ? rh : null;
  const name = b.name || h?.name || null, email = b.email || h?.email || null;
  return { name: name ? String(name) : null, email: email ? String(email) : null };
}
// The question for exactly what is missing at the top of the resume: both, or the one piece.
export function contactQuestion(top: { name: string | null; email: string | null }): string {
  return !top.name && !top.email ? CONTACT_QUESTION : !top.email ? EMAIL_QUESTION : NAME_QUESTION;
}

const HEADING: Record<string, string> = { experience: "Experience", project: "Projects", education: "Education", leadership: "Leadership", certification: "Certifications" };
// The base resume: every confirmed fact in the order the person gave them, as entries and bullets, and their skills.
// It is what the changelog compares against.
export function baseResume(profile: any): { sections: { heading: string; lines: any[] }[]; lines: any[] } {
  const facts = CareerProfile.confirmedFacts(profile) as any[];
  const sections: { heading: string; lines: any[] }[] = [];
  const at = (h: string) => sections.find((s) => s.heading === h) ?? (sections.push({ heading: h, lines: [] }), sections[sections.length - 1]);
  for (const f of facts) {
    const h = HEADING[f.kind];
    if (!h) continue;
    const s = at(h);
    s.lines.push({ text: f.title || f.text, factIds: [f.id], type: "entry" });
    for (const b of (f.bullets?.length ? f.bullets : (f.text && f.text !== f.title ? [f.text] : []))) s.lines.push({ text: b, factIds: [f.id], type: "bullet" });
  }
  const skills = facts.filter((f) => f.kind === "skill" && (f.name || f.title));
  if (skills.length) at("Skills").lines.push({ text: skills.map((f) => f.name || f.title).join(", "), factIds: skills.map((f) => f.id), type: "skills" });
  return { sections, lines: sections.flatMap((s) => s.lines.map((l) => ({ ...l, section: s.heading }))) };
}

// ---------------------------------------------------------------- the name and email at the top
// Only what the person typed this turn (D-007): never the account email, never a guess. The email must appear exactly
// (any case) and the name as typed (any case, spaces normalized).
export const CONTACT_QUESTION = "What name and email should go at the top of your resume?";
export const EMAIL_QUESTION = "What email should go at the top of your resume?";
export const NAME_QUESTION = "What name should go at the top of your resume?";
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
const NAME = /^[\p{L}][\p{L}' -]*[\p{L}]$/u;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const tokenIn = (hay: string, needle: string, edge: RegExp) => {
  const h = hay.toLowerCase(), n = needle.toLowerCase();
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) {
    if (!edge.test(h[i - 1] ?? " ") && !edge.test(h[i + n.length] ?? " ")) return true;
  }
  return false;
};
// o.only: the one piece typed this message (H2H leftovers 1: the other is already on the confirmed record and is not asked).
export function contactFromMessage(message: string, name: unknown, email: unknown, o: { only?: "name" | "email" } = {}): { ok: true; name: string; email: string } | { ok: false; error: string } {
  const n = squash(String(name ?? "")), e = String(email ?? "").trim(), m = squash(String(message ?? ""));
  if (o.only !== "email" && (n.length < 2 || n.length > 80 || !NAME.test(n))) return { ok: false, error: "the name must be 2 to 80 letters, spaces, hyphens or apostrophes" };
  if (o.only !== "name" && !EMAIL.test(e)) return { ok: false, error: "that is not a valid email address" };
  if (o.only !== "name" && !tokenIn(m, e, /[A-Za-z0-9._%+@-]/)) return { ok: false, error: "the person did not type that email in this message; they must type it themselves" };
  if (o.only !== "email" && !tokenIn(m, n, /\p{L}/u)) return { ok: false, error: "the person did not type that name in this message; they must type it themselves" };
  return { ok: true, name: n, email: e };
}

// ---------------------------------------------------------------- personas
export interface Persona { name: string; lead: string[]; hide: string[]; at: string }
export interface PersonaState { items: Persona[]; active: string | null }
export interface PersonaStore { get(userId: string): Promise<PersonaState>; save(userId: string, s: PersonaState): Promise<void> }
export const personaName = (s: unknown) => String(s ?? "").toLowerCase().replace(/\b(resume|persona|version|cv)\b/g, " ").replace(/[^a-z0-9 -]/g, " ").replace(/\s+/g, " ").trim();
export function validPersonaName(s: unknown): string | null {
  const n = personaName(s);
  return n && n.length <= 24 && !["base", "default", "regular", "normal", "main", "usual"].includes(n) ? n : null;
}
// The name is the person's: it must be in their message this turn ("save my banking resume", "apply as my banking resume").
export const namedIn = (message: string, name: string) => ` ${personaName(message)} `.includes(` ${name} `);
const titleOf = (f: any) => String(f?.title || f?.text || f?.id || "").replace(/,\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{4}.*$/i, "").trim();
export function restatePersona(p: Persona, profile: any): string {
  const name = (id: string) => `${titleOf(CareerProfile.getFact(profile, id))} (${id})`;
  const lead = p.lead.length ? `leads with ${p.lead.map(name).join(", then ")}` : "keeps the order each posting needs";
  const hide = p.hide.length ? `leaves out ${p.hide.map(name).join(", ")}` : "leaves nothing out";
  return `${p.name}: ${lead}; ${hide}. Same confirmed facts, nothing added.`;
}
export function savePersona(state: PersonaState, profile: any, o: { name: string; lead: string[]; hide: string[]; now: number }): { ok: true; persona: Persona; state: PersonaState } | { ok: false; error: string } {
  const name = validPersonaName(o.name);
  if (!name) return { ok: false, error: "name the persona in 1 to 24 letters or numbers (not 'base')" };
  const ok = new Set((CareerProfile.confirmedFacts(profile) as any[]).filter((f) => f.status !== "draft").map((f) => f.id));
  const ids = (xs: string[]) => [...new Set((xs || []).map(String))];
  const lead = ids(o.lead), hide = ids(o.hide);
  const bad = [...lead, ...hide].filter((id) => !ok.has(id));
  if (bad.length) return { ok: false, error: `${bad.join(", ")} ${bad.length > 1 ? "are not confirmed facts" : "is not a confirmed fact"}; a persona only orders and picks from confirmed facts` };
  const both = lead.filter((id) => hide.includes(id));
  if (both.length) return { ok: false, error: `${both.join(", ")} cannot both lead and be left out` };
  const others = state.items.filter((p) => p.name !== name);
  if (others.length >= MAX_PERSONAS) return { ok: false, error: `${MAX_PERSONAS} personas are saved already; ask which one to drop first` };
  const persona = { name, lead, hide, at: new Date(o.now).toISOString() };
  return { ok: true, persona, state: { items: [...others, persona], active: state.active } };
}
export function memoryPersonaStore(initial: Record<string, PersonaState> = {}): PersonaStore & { dump(): Record<string, PersonaState> } {
  const st: Record<string, PersonaState> = clone(initial);
  return {
    async get(u) { return clone(st[u] ?? { items: [], active: null }); },
    async save(u, s) { st[u] = clone(s); },
    dump() { return clone(st); },
  };
}
// Kept on the account in career_watch_kv, so the erase that wipes the account wipes these too.
export function supabasePersonaStore(admin: any): PersonaStore {
  return {
    async get(u) {
      const r = await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", PERSONAS_KEY).maybeSingle();
      if (r.error) throw new Error(`read resume personas: ${r.error.message}`);
      const v = r.data?.value ?? {};
      const items = Array.isArray(v.items) ? v.items.filter((p: any) => p && typeof p.name === "string" && Array.isArray(p.lead) && Array.isArray(p.hide)) : [];
      return { items, active: typeof v.active === "string" && items.some((p: Persona) => p.name === v.active) ? v.active : null };
    },
    async save(u, s) {
      const r = await admin.from("career_watch_kv").upsert({ user_id: u, key: PERSONAS_KEY, value: { ...s, updated_at: new Date().toISOString() } }, { onConflict: "user_id,key" });
      if (r.error) throw new Error(`save resume personas: ${r.error.message}`);
    },
  };
}

// A persona picks (hide) before tailoring and orders (lead) after it. Leading moves whole entries (the entry and its
// own bullets) and the sections that hold them; it never changes a line. Entries start newest first (newestFirst, RESUME-
// TEMPLATES E5); a lead the person chose still goes first.
export function applyPersonaOrder(resume0: any, lead: string[]): any {
  const resume = newestFirst(resume0);
  if (!lead.length) return resume;
  const rank = (ids: string[]) => Math.min(...(ids || []).map((id) => { const i = lead.indexOf(id); return i < 0 ? Infinity : i; }));
  const sections = resume.sections.map((s: any) => {
    const blocks: any[][] = [];
    for (const l of s.lines) { if (l.type === "entry" || !blocks.length) blocks.push([l]); else blocks[blocks.length - 1].push(l); }
    const keyed = blocks.map((b, i) => ({ b, i, r: b[0].type === "entry" ? rank(b[0].factIds) : Infinity }));
    keyed.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r - y.r));
    return { ...s, lines: keyed.flatMap((k) => k.b) };
  });
  const sRank = (s: any) => s.heading === "Skills" ? Infinity : Math.min(...s.lines.filter((l: any) => l.type === "entry").map((l: any) => rank(l.factIds)), Infinity);
  const ordered = sections.map((s: any, i: number) => ({ s, i, r: sRank(s) })).sort((a: any, b: any) => {
    if (a.r === Infinity && b.r === Infinity) return a.i - b.i;
    return a.r === b.r ? a.i - b.i : a.r - b.r;
  }).map((x: any) => x.s);
  // Sections holding a lead fact go first, in lead order; the rest (Skills among them) keep their order after them.
  return { ...resume, sections: ordered, lines: ordered.flatMap((s: any) => s.lines.filter((l: any) => l.type !== "note" && l.type !== "gap").map((l: any) => ({ ...l, section: s.heading }))) };
}

// The document that goes to an employer: the cited lines only. The tailor's eligibility verdict and gap notes are for
// the person, not the employer, and are not facts; they never print on a submitted resume.
export function submissionResume(resume: any): any {
  const sections = (resume.sections || []).map((s: any) => ({ heading: s.heading, lines: (s.lines || []).filter((l: any) => l && l.type !== "note" && l.type !== "gap" && (l.factIds || []).length) }))
    .filter((s: any) => s.lines.length);
  return { header: clone(resume.header), family: resume.family, sections, lines: sections.flatMap((s: any) => s.lines.map((l: any) => ({ ...l, section: s.heading }))) };
}

// ---------------------------------------------------------------- the changelog (from the diff only)
const wantedOf = (jd: any) => [...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])];
const corpusOf = (f: any) => `${f?.title || ""} ${f?.text || ""} ${(f?.bullets || []).join(" ")} ${(f?.skills || []).join(" ")}`;
const skillsOfLine = (t: string) => String(t || "").replace(/^technical skills:\s*/i, "").split(/,\s*/).map((x) => x.trim()).filter(Boolean);
const list = (xs: string[], max = 3) => xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;
export interface ChangeItem { kind: "lead" | "drop" | "skills" | "reword" | "kept"; text: string; diff: "added" | "moved" | "removed"; line: string; name?: string; why?: string }
// FEATURE 4: the bullet rewording (career_tailor_rewrite.ts), said after the selection changes: how many bullets were
// reworded, and each rewrite that was refused with the words it added that are not on the record.
export interface RewriteLog { status: string; accepted: { before: string; after: string }[]; rejected: { before: string; proposed: string; reasons: string[] }[] }
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
function whyKept(reasons: string[]): string {
  const added = reasons.map((x) => { const m = x.match(/^(?:number|name|tool or skill) "([^"]+)"|^"([^"]+)" is not/); return m ? (m[1] ?? m[2]) : null; }).filter(Boolean) as string[];
  const uniq = [...new Set(added)];
  if (uniq.length) return `it added ${uniq.slice(0, 3).join(", ")}, which ${uniq.length === 1 ? "is" : "are"} not on your record`;
  const dropped = reasons.map((x) => (x.match(/drops the number "([^"]+)"/) || [])[1]).filter(Boolean);
  if (dropped.length) return `it dropped ${dropped.join(", ")}`;
  return reasons[0] || "it did not pass the truth check";
}
export function rewriteItems(r: RewriteLog): { sentence: string; items: ChangeItem[] } {
  if (r.status === "model_unavailable" || r.status === "unreadable") return { sentence: "No bullet was reworded this time (the writing model did not answer usably), so every bullet is in your own confirmed words.", items: [] };
  if (r.status === "no_bullets") return { sentence: "", items: [] };
  const items: ChangeItem[] = [
    ...r.accepted.map((a) => ({ kind: "reword" as const, text: `reworded "${clip(a.before, 60)}"`, diff: "added" as const, line: a.after })),
    ...r.rejected.map((x) => ({ kind: "kept" as const, text: `kept "${clip(x.before, 60)}"`, diff: "moved" as const, line: x.before, why: whyKept(x.reasons) })),
  ];
  const n = r.accepted.length, parts: string[] = [];
  parts.push(n ? `Reworded ${n} bullet${n === 1 ? "" : "s"} toward the posting's wording, using only what your record says (for example: "${clip(r.accepted[0].after, 90)}")`
    : "No bullet was reworded: none could be improved without adding something your record does not say");
  if (r.rejected.length) parts.push(`kept ${r.rejected.length} as you wrote ${r.rejected.length === 1 ? "it" : "them"}: ${r.rejected.slice(0, 3).map((x) => `"${clip(x.before, 50)}", because ${whyKept(x.reasons)}`).join("; ")}`);
  return { sentence: `${parts.join("; ")}.`, items };
}
export function changelog(o: { diff: any; base: any; tailored: any; profile: any; jd: any; hidden: string[]; persona: string | null; rewrites?: RewriteLog | null }): { line: string; items: ChangeItem[] } {
  const sel = selectionChangelog(o);
  if (!o.rewrites) return sel;
  const rw = rewriteItems(o.rewrites);
  return { line: rw.sentence ? `${sel.line} ${rw.sentence}` : sel.line, items: [...sel.items, ...rw.items] };
}
function selectionChangelog(o: { diff: any; base: any; tailored: any; profile: any; jd: any; hidden: string[]; persona: string | null }): { line: string; items: ChangeItem[] } {
  const items: ChangeItem[] = [];
  const inDiff = (kind: "added" | "moved" | "removed", text: string) => (o.diff[kind] || []).some((d: any) => d.text === text);
  const entries = (r: any) => (r.lines || []).filter((l: any) => l.type === "entry");
  const wanted = wantedOf(o.jd).map((s: string) => s.toLowerCase());
  const firstT = entries(o.tailored)[0], firstB = entries(o.base)[0];
  if (firstT && firstB && firstT.factIds[0] !== firstB.factIds[0]) {
    const kind = inDiff("moved", firstT.text) ? "moved" : inDiff("added", firstT.text) ? "added" : null;
    if (kind) {
      const f = CareerProfile.getFact(o.profile, firstT.factIds[0]);
      const shows = CareerTailor.skillsInText(corpusOf(f)).filter((s: string) => wanted.includes(s.toLowerCase()));
      const why = o.persona && !shows.length ? `, as your ${o.persona} persona leads` : shows.length ? `, which shows ${list(shows)} from the posting` : "";
      items.push({ kind: "lead", text: `led with ${titleOf(f)}${why}`, diff: kind, line: firstT.text });
    }
  }
  const rawSkills = new Set(CareerTailor.skillsInText(o.jd.rawText || "").map((s: string) => s.toLowerCase()));
  for (const l of entries(o.base)) {
    if (!inDiff("removed", l.text)) continue;
    const id = l.factIds[0], f = CareerProfile.getFact(o.profile, id);
    const named = CareerTailor.skillsInText(corpusOf(f)).some((s: string) => rawSkills.has(s.toLowerCase()));
    const why = o.hidden.includes(id) ? `, which your ${o.persona} persona leaves out` : named ? "" : ", which this posting doesn't ask for";
    items.push({ kind: "drop", text: `dropped ${titleOf(f)}${why}`, diff: "removed", line: l.text, name: titleOf(f), why });
  }
  // Skills last: the roles matter more on one line.
  const skT = (o.tailored.lines || []).find((l: any) => l.type === "skills"), skB = (o.base.lines || []).find((l: any) => l.type === "skills");
  if (skT && inDiff("added", skT.text)) {
    const now = skillsOfLine(skT.text), before = skillsOfLine(skB?.text || "");
    const off = before.filter((s) => !now.some((n) => n.toLowerCase() === s.toLowerCase()));
    items.push({ kind: "skills", text: `skills now start with ${now.slice(0, 3).join(", ")}${off.length && skB && inDiff("removed", skB.text) ? `, without ${list(off, 2)}` : ""}`, diff: "added", line: skT.text });
  }
  if (!items.length) return { line: "Same as your base resume; it already fits this posting.", items };
  // One line: the lead, the drops grouped by their reason, then the skills; past 300 characters the skills go first,
  // then each group names two and counts the rest.
  const and = (xs: string[], max: number) => xs.length <= max ? (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]) : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;
  const groups = new Map<string, string[]>();
  for (const it of items.filter((x) => x.kind === "drop")) groups.set(it.why ?? "", [...(groups.get(it.why ?? "") ?? []), it.name ?? ""]);
  const build = (max: number, skills: boolean) => [
    ...items.filter((x) => x.kind === "lead").map((x) => x.text),
    ...[...groups].map(([why, names]) => `dropped ${and(names, max)}${why}`),
    ...(skills ? items.filter((x) => x.kind === "skills").map((x) => x.text) : []),
  ].join("; ");
  let s = build(3, true);
  if (s.length > 300) s = build(3, false);
  if (s.length > 300) s = build(2, false);
  if (s.length > 300) s = build(1, false);
  return { line: s.charAt(0).toUpperCase() + s.slice(1) + ".", items };
}

// ---------------------------------------------------------------- render + the ATS parse harness
export interface AtsVerdict { pass: boolean; status: string; reasons: string[]; warnings: string[] }
// What an applicant tracking system reads off the file, checked on the file itself: 148's two independent parsers agree
// with each other and with the source (every line, in order, nothing extra, standard headings, one column, standard
// fonts, no images, under 2.5 MB), and the name and email come back out as text. Any failure refuses the resume.
export function atsHarness(R: any, resume: any, pdf: Uint8Array): AtsVerdict {
  const buf = R.toBuffer(pdf);
  const check = R.parseCheck({ resume, pdf: buf });
  const reasons = check.reasons.filter((r: any) => r.level === "fail").map((r: any) => `${r.check}: ${r.detail}`);
  const warnings = check.reasons.filter((r: any) => r.level === "warn").map((r: any) => `${r.check}: ${r.detail}`);
  reasons.push(...contactProblems(R, resume, buf));
  return { pass: reasons.length === 0, status: reasons.length ? "FAIL" : check.status, reasons, warnings };
}
// The name and email come back out of the file as text, and so do the contact and links lines the person confirmed with
// their resume (RELEASE 9), word for word; and there is at least one entry. Spacing is compared loosely (a line the layout
// wraps reads back on two lines), the words exactly.
function contactProblems(R: any, resume: any, buf: any): string[] {
  const reasons: string[] = [];
  const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
  const text = norm((R.extractPdfLines(buf) as string[]).join(" "));
  const back = (v: string) => text.includes(norm(v));
  const name = String(resume?.header?.name || ""), email = String(resume?.header?.email || "");
  if (!name.trim() || !back(name)) reasons.push("contact: the name does not come back out of the file");
  if (!email.trim() || !back(email)) reasons.push("contact: the email does not come back out of the file");
  for (const [k, what] of [["contactLine", "contact line"], ["linksLine", "links line"]] as const) {
    const line = resume?.header?.[k];
    if (typeof line === "string" && line.trim() && !back(line)) reasons.push(`contact: the ${what} you confirmed does not come back out of the file`);
  }
  if (!(resume?.sections || []).some((s: any) => s.lines.some((l: any) => l.type === "entry"))) reasons.push("content: no experience, project or education entry");
  return reasons;
}
// RELEASE 9: a layout (career_resume_design.ts) renders the PDF and the DOCX together; the DOCX, the page fit and the
// printed lines ride the result. With no layout asked for, the renderer is exactly WO-028's (148's own PDF).
// RELEASE 10: a template (one of the fifteen, branded or neutral), or "own" from the person's PDF rebuilt from its geometry.
export interface RenderOpts { layout?: DesignLayout | null; ownDocx?: Uint8Array | null; swaps?: Swap[]; template?: TemplateId | null; branded?: boolean; ownPdfSpec?: TemplateSpec | null; ownFacts?: OwnFact[] | null }
export type RenderOut = { ok: true; pdf: Uint8Array; sha256: string; filename: string; ats: AtsVerdict; where: string; layout?: DesignLayout; template?: TemplateId | null; docx?: Uint8Array; fit?: Fit; lines?: string[]; replaced?: number; missing?: string[] } | { ok: false; reason: string; where: string };
export type ResumeRenderer = (resume: any, opts?: RenderOpts) => Promise<RenderOut>;
export function renderWith(R: any, where: string): ResumeRenderer {
  return async (resume, opts) => {
    if (!R?.runtime?.zlib || !R?.runtime?.crypto) return { ok: false, where, reason: `the PDF renderer needs zlib and crypto, which ${where} does not provide` };
    if (opts?.layout) {
      const d = renderDesigned(R, resume, { layout: opts.layout, ownDocx: opts.ownDocx ?? null, swaps: opts.swaps, template: opts.template ?? null, branded: !!opts.branded, ownPdfSpec: opts.ownPdfSpec ?? null, ownFacts: opts.ownFacts ?? null });
      if (!d.ok) return { ok: false, where, reason: d.reason };
      const buf = R.toBuffer(d.pdf);
      const reasons = [...d.parseCheck.fails, ...contactProblems(R, resume, buf)];
      const ats: AtsVerdict = { pass: reasons.length === 0, status: reasons.length ? "FAIL" : d.parseCheck.status, reasons, warnings: d.parseCheck.warnings };
      return { ok: true, pdf: d.pdf, sha256: R.sha256(buf), filename: R.filenameFor(resume?.header?.name, "pdf"), ats, where, layout: d.layout, template: d.template ?? null, docx: d.docx, fit: d.fit, lines: d.lines, ...(d.replaced !== undefined ? { replaced: d.replaced, missing: d.missing } : {}) };
    }
    const r = R.renderPdf(resume);
    if (!r.ok) return { ok: false, where, reason: r.reason || "the PDF could not be rendered" };
    const pdf = new Uint8Array(r.buffer);
    // The Word copy rides with the PDF on the plain path too (RESUME-TEMPLATES 1.1: "Trainee keeps sending both"; the resume
    // loop found the default "make me a resume" sent the PDF alone). Same document, same words; a Word copy that cannot be
    // made is left out, never faked.
    const d = R.renderDocx(resume);
    const docx = d?.ok && d.buffer ? new Uint8Array(d.buffer) : undefined;
    return { ok: true, pdf, sha256: R.sha256(r.buffer), filename: r.filename, ats: atsHarness(R, resume, pdf), where, ...(docx ? { docx } : {}) };
  };
}
// The edge (Deno): 148 over Deno's own node: built-ins, loaded once, on the first render.
export function edgeRenderer(): ResumeRenderer {
  const where = "the edge function (Deno)";
  let inner: Promise<ResumeRenderer> | null = null;
  return async (resume, opts) => {
    inner ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
      .then(([zlib, crypto, b]) => renderWith((CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), where))
      .catch((e) => async () => ({ ok: false as const, where, reason: `its node built-ins could not be loaded (${e?.message ?? e})` }));
    return (await inner)(resume, opts);
  };
}

// ---------------------------------------------------------------- private storage + the signed link
// removeAll empties the person's folder: the career erase ("forget everything") calls it; account deletion removes the
// folder in delete-account before the auth user goes.
export interface ResumeStore { put(path: string, pdf: Uint8Array): Promise<void>; signedUrl(path: string, seconds: number): Promise<string>; removeAll(userId: string): Promise<number> }
export function resumePath(userId: string, sha256: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(userId) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("not stored: bad resume path");
  return `${userId}/${sha256}.pdf`;
}
// A link is offered only when it is a signed link to this exact private object: never a public object URL.
export function privateLinkProblem(url: string, path: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "the link is not a URL"; }
  if (u.protocol !== "https:") return "the link is not https";
  if (/\/object\/public\//.test(u.pathname)) return "the link is a public object URL";
  if (!u.pathname.endsWith(`/object/sign/${RESUME_BUCKET}/${path}`)) return "the link is not a signed link to this resume";
  if (!u.searchParams.get("token")) return "the link carries no signature";
  return null;
}
export function supabaseResumeStore(admin: any): ResumeStore {
  const b = () => admin.storage.from(RESUME_BUCKET);
  return {
    async put(path, pdf) {
      const r = await b().upload(path, new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), { contentType: "application/pdf", upsert: true });
      if (r.error) throw new Error(`store resume: ${r.error.message}`);
    },
    async signedUrl(path, seconds) {
      const r = await b().createSignedUrl(path, seconds);
      if (r.error || !r.data?.signedUrl) throw new Error(`sign resume link: ${r.error?.message ?? "no link"}`);
      return r.data.signedUrl;
    },
    async removeAll(userId) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(userId)) throw new Error("remove resumes: bad user id");
      let removed = 0;
      for (let i = 0; i < 50; i++) {
        const l = await b().list(userId, { limit: 1000 });
        if (l.error) throw new Error(`list resumes: ${l.error.message}`);
        const names = (l.data ?? []).map((o: any) => `${userId}/${o.name}`);
        if (!names.length) return removed;
        const r = await b().remove(names);
        if (r.error) throw new Error(`remove resumes: ${r.error.message}`);
        removed += names.length;
      }
      return removed;
    },
  };
}
export function memoryResumeStore(base = "https://project.supabase.test/storage/v1"): ResumeStore & { files: Map<string, Uint8Array>; signed: { path: string; seconds: number }[] } {
  const files = new Map<string, Uint8Array>(), signed: { path: string; seconds: number }[] = [];
  return {
    files, signed,
    async put(path, pdf) { files.set(`${RESUME_BUCKET}/${path}`, pdf); },
    async signedUrl(path, seconds) {
      if (!files.has(`${RESUME_BUCKET}/${path}`)) throw new Error("sign resume link: object not found");
      signed.push({ path, seconds });
      return `${base}/object/sign/${RESUME_BUCKET}/${path}?token=test-${signed.length}`;
    },
    async removeAll(userId) {
      const mine = [...files.keys()].filter((k) => k.startsWith(`${RESUME_BUCKET}/${userId}/`));
      for (const k of mine) files.delete(k);
      return mine.length;
    },
  };
}

// ---------------------------------------------------------------- the whole tailor
// tailor is 123's tailorResume; it is a seam only so a test can hand this gate a defective assembler and see it refused.
export interface TailorDeps { render: ResumeRenderer; resumes: ResumeStore; tailor?: (profile: any, jd: any, opts: any) => any }
// ---------------------------------------------------------------- D-063: the email placeholder and edits to a version
// D-063 (architect, 2026-11-11; G10, D-007): the email at the top is the one on the person's confirmed resume or one they typed;
// never the channel's or the account's. With none, a review draft delivered in the chat carries this visible placeholder and the
// reply says so; that draft is never stored for an application (the apply paths tailor again and refuse without an email).
export const EMAIL_PLACEHOLDER = "[your email]";
// C20 (MIRROR-PROCESS): "condense the X stuff to one line and expand the Y part more". One edit sets how many detail lines (bullets)
// one confirmed entry prints. Every line comes from that entry's own confirmed words: its bullets, or its text after the "Role:"
// head split at ";" and sentence ends. Expanding never adds words the record does not hold; when it holds fewer details than
// asked, the result says how many it had (expand_short), and the person is asked for more instead of anything being written.
export interface ResumeEdit { role: string; lines: number }
// expand_short: more lines were asked than the entry's confirmed details hold; the person is asked for more, nothing is written.
export interface EditDone { role: string; entry: string; asked: number; before: number; now: number; available: number; change: "condensed" | "expanded" | "unchanged"; added_back: boolean; led: boolean; expand_short: boolean }
const MAX_EDIT_LINES = 6;
const roleKey = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
// The head of an entry ("Pixelforge, Founder (2023-2025)") and its details, all in the fact's own words.
export function entryParts(f: any): { head: string; details: string[] } {
  const title = String(f?.title || f?.text || "").trim();
  const bullets = (f?.bullets || []).map((b: unknown) => String(b ?? "").trim()).filter(Boolean);
  const colon = title.indexOf(": ");
  const head = colon > 0 ? title.slice(0, colon).trim() : title;
  if (bullets.length) return { head, details: bullets };
  const rest = colon > 0 ? title.slice(colon + 2) : (f?.text && f.text !== f.title ? String(f.text) : "");
  const details = rest.split(/;\s+|(?<=[a-z0-9)%])\.\s+(?=[A-Z])/).map((x) => x.trim().replace(/[.;]+$/, "").trim()).filter((x) => x.length > 2);
  return { head, details };
}
export function applyEdits(resume: any, profile: any, edits: ResumeEdit[]): { ok: true; resume: any; done: EditDone[] } | { ok: false; reason: string } {
  const out = clone(resume);
  out.sections = out.sections || [];
  const facts = (profile.facts || []).filter((f: any) => HEADING[f.kind]);
  const done: EditDone[] = [];
  for (const e of edits) {
    const want = roleKey(e.role), n = Math.trunc(Number(e.lines));
    if (want.trim().length < 2) return { ok: false, reason: "an edit names no role; ask which entry they mean" };
    if (!Number.isFinite(n) || n < 1 || n > MAX_EDIT_LINES) return { ok: false, reason: `an edit asks for ${e.lines} lines for ${e.role}; it takes 1 to ${MAX_EDIT_LINES}` };
    const hits = facts.filter((f: any) => roleKey(entryParts(f).head).includes(want) || roleKey(f.org || f.name || "").includes(want));
    if (!hits.length) return { ok: false, reason: `no confirmed entry on their record is named "${e.role}"; ask which entry they mean (nothing is invented)` };
    if (hits.length > 1) return { ok: false, reason: `"${e.role}" names ${hits.length} confirmed entries (${hits.map((f: any) => entryParts(f).head).join("; ")}); ask which one they mean` };
    const f = hits[0], id = String(f.id), heading = HEADING[f.kind];
    const { head, details } = entryParts(f);
    // Where the entry prints now (its section and its block: the entry line and the bullets after it).
    let sec = out.sections.find((s: any) => (s.lines || []).some((l: any) => l.type === "entry" && (l.factIds || []).includes(id)));
    const added_back = !sec;
    let before = 0;
    if (sec) {
      const i = sec.lines.findIndex((l: any) => l.type === "entry" && (l.factIds || []).includes(id));
      let j = i + 1;
      while (j < sec.lines.length && sec.lines[j].type === "bullet") j++;
      // Details printed inside the entry line itself ("Role: did X; did Y") count as printed.
      before = sec.lines[i].text !== head ? details.length : j - i - 1;
      sec.lines.splice(i, j - i);
    } else {
      sec = out.sections.find((s: any) => s.heading === heading);
      if (!sec) { sec = { heading, lines: [] }; out.sections.splice(Math.max(0, out.sections.findIndex((s: any) => s.heading === "Skills") + 1), 0, sec); }
    }
    const keep = details.slice(0, n);
    const block = [{ text: keep.length ? head : String(f.title || f.text), factIds: [id], type: "entry" }, ...keep.map((d) => ({ text: d, factIds: [id], type: "bullet" }))];
    const change = keep.length < before ? "condensed" : keep.length > before || added_back ? "expanded" : "unchanged";
    // An entry asked to grow leads its section (Instinct C20: "Waypoint now leads"); one condensed keeps its place.
    const led = n > before;
    if (led) sec.lines.unshift(...block);
    else sec.lines.splice(added_back ? sec.lines.length : positionOf(sec, resume, id), 0, ...block);
    done.push({ role: e.role, entry: head, asked: n, before, now: keep.length, available: details.length, change, added_back, led, expand_short: n > keep.length });
  }
  out.lines = out.sections.flatMap((s: any) => (s.lines || []).map((l: any) => ({ ...l, section: s.heading })));
  return { ok: true, resume: out, done };
}
export function editLine(done: EditDone[]): string {
  const one = (e: EditDone) => {
    const lines = `${e.now} detail line${e.now === 1 ? "" : "s"}`;
    const what = e.change === "condensed" ? `condensed to ${lines}` : e.change === "expanded" ? `${e.added_back ? "added back with" : "expanded to"} ${lines}` : `kept at ${lines}`;
    const short = e.expand_short ? ` (${e.asked} asked; the confirmed record holds ${e.available})` : "";
    return `${e.entry}: ${what}${e.led ? ", now first in its section" : ""}${short}`;
  };
  const s = done.map(one).join("; ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}
// The place an entry held in its section before it was edited (by how many entries came before it), so a condensed entry stays put.
function positionOf(sec: any, before: any, id: string): number {
  const was = (before.sections || []).find((s: any) => s.heading === sec.heading);
  const order = (was?.lines || []).filter((l: any) => l.type === "entry").map((l: any) => (l.factIds || [])[0]);
  const k = order.indexOf(id);
  if (k <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < sec.lines.length; i++) if (sec.lines[i].type === "entry" && ++seen > k) return i;
  return sec.lines.length;
}

export type TailorOut = {
  ok: true; text: string; link: string; expires_at: string; changelog: string; changes: ChangeItem[]; sha256: string; filename: string;
  // D-063: what prints as a placeholder (a review draft for the chat, never stored for an application), and the edits made.
  placeholders?: string[]; edits?: EditDone[];
  persona: string | null; job_id: string | null; company: string | null; ats: { status: string; warnings: string[] };
  not_on_your_record: string[]; lead_not_picked: string[]; rendered_in: string; ms: number; detail: { doc: any; base: any; diff: any; docx: Uint8Array | null; pdf: Uint8Array };
  // RELEASE 9: the posting against the resume (missing, weak, emphasise) and the top of the file as it prints, both for the
  // chat before the file is sent; the layout and its page fit when one was asked for.
  gaps: GapReport; preview: string; layout: DesignLayout | "plain"; template: TemplateId | null; fit: FitRecord | null; own_layout?: { replaced: number; missing: string[] };
} | { ok: false; refused: "no_confirmed_facts" | "no_contact" | "truth_audit" | "render" | "ats_parse" | "link" | "edit"; reason: string; ms: number };

export async function tailorForPosting(o: {
  userId: string; profile: any; posting: { text: string; job_id?: string | null; company?: string | null };
  persona?: Persona | null; deps: TailorDeps; now: number; layout?: DesignLayout | null; ownDocx?: Uint8Array | null; swaps?: Swap[];
  template?: TemplateId | null; branded?: boolean; ownPdfSpec?: TemplateSpec | null;
  contact?: "typed" | "confirmed";
  // D-063: a review draft for the chat only. With a name and no email, the email prints as EMAIL_PLACEHOLDER and the file is not
  // stored (no link: it rides the reply). Never set on a path that applies or sends.
  reviewDraft?: boolean;
  edits?: ResumeEdit[];
}): Promise<TailorOut> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const clean = confirmedOnly(o.profile);
  if (!(clean.facts || []).some((f: any) => HEADING[f.kind])) return { ok: false, refused: "no_confirmed_facts", reason: "there are no confirmed experience, project or education facts on file to build a resume from", ms: ms() };
  const top = resumeContact(clean, o.contact ?? "confirmed");
  const placeholder = !!o.reviewDraft && (o.contact ?? "confirmed") === "confirmed" && !!top.name && !top.email;
  if (!placeholder && (!top.name || !top.email)) {
    // H2H leftovers 1: a piece the confirmed resume header holds is not asked again; only the missing one is. A name or email
    // typed for the resume with the other missing is still asked as both (pinned: tests/architect/wo-028-tailor.test.ts WO-028/3).
    const b = clean.basics || {};
    const fromHeader = !b.name && !b.email ? top : { name: null, email: null };
    const missing = !fromHeader.name && !fromHeader.email ? "your name and email are not on your profile yet, and an employer's system reads them"
      : !fromHeader.email ? `your email is not on your profile yet (the name, ${top.name}, is from the resume you confirmed), and an employer's system reads it`
      : "your name is not on your profile yet (the email is from the resume you confirmed), and an employer's system reads it";
    return { ok: false, refused: "no_contact", reason: `${missing} from the top of the resume. Ask exactly: "${contactQuestion(fromHeader)}"`, ms: ms() };
  }
  const persona = o.persona ?? null;
  const hidden = persona ? persona.hide.filter((id) => CareerProfile.getFact(clean, id)) : [];
  const picked = hidden.length ? withResumeHeader(CareerProfile.createProfile({ id: clean.id, basics: clean.basics, facts: clean.facts.filter((f: any) => !hidden.includes(f.id)) }), clean) : clean;
  const jd = CareerTailor.parseJD(o.posting.text);
  const t = (o.deps.tailor ?? CareerTailor.tailorResume)(picked, jd, { jobId: o.posting.job_id ?? null, company: o.posting.company ?? null });
  if (!t.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused it: ${(t.violations || []).slice(0, 3).map((v: any) => v.reason).join("; ")}`, ms: ms() };
  if (t.mode !== "full" || !t.resume) return { ok: false, refused: "truth_audit", reason: t.reason || "no resume was assembled", ms: ms() };
  const lead = persona ? persona.lead.filter((id) => CareerProfile.getFact(picked, id)) : [];
  // `picked`, not `clean`: a skill a persona hides stays hidden.
  let ordered = withListedSkills(applyPersonaOrder(t.resume, lead), picked);
  let edits: EditDone[] | undefined;
  if (o.edits?.length) {
    const e = applyEdits(ordered, picked, o.edits);
    if (!e.ok) return { ok: false, refused: "edit", reason: e.reason, ms: ms() };
    ordered = e.resume; edits = e.done;
  }
  if (placeholder) {
    // The placeholder prints where the email would: after a contact line the person confirmed (which has no email), or alone.
    const h = ordered.header = { ...(ordered.header || {}), email: EMAIL_PLACEHOLDER };
    if (typeof h.contactLine === "string" && h.contactLine.trim()) h.contactLine = `${h.contactLine.trim()} | ${EMAIL_PLACEHOLDER}`;
  }
  const doc = submissionResume(ordered);
  // The hard gate again, on exactly what will print: every line cited to a confirmed fact that supports it.
  const audit = CareerTailor.auditResume(doc, clean);
  if (!audit.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused it: ${audit.violations.slice(0, 3).map((v: any) => v.reason).join("; ")}`, ms: ms() };
  // G5/B2: no skill, employer, title, date or number the person did not confirm, on any printed line.
  const guard = guardMaterials(documentLines(doc), clean);
  if (!guard.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused it: ${guard.refused.flatMap((x) => x.reasons).slice(0, 3).join("; ")}`, ms: ms() };
  // RELEASE 10: their own Word file, with no hand-made swaps, gets the tailored lines from the confirmed facts it was read
  // from (career_resume_design.ts planOwnEdits); the printed lines are then held to this document (verifyOwnPrinted).
  const ownFacts = o.layout === "own" && o.ownDocx?.length && !o.swaps ? (clean.facts || []).map((f: any) => ({ id: String(f.id), title: f.title, text: f.text, bullets: f.bullets })) : null;
  const r = o.layout ? await o.deps.render(doc, { layout: o.layout, ownDocx: o.ownDocx ?? null, swaps: o.swaps, template: o.template ?? null, branded: !!o.branded, ownPdfSpec: o.ownPdfSpec ?? null, ownFacts }) : await o.deps.render(doc);
  if (!r.ok) return { ok: false, refused: "render", reason: `the PDF could not be made: ${r.reason}`, ms: ms() };
  // The truth check on exactly what prints: a kept file's own lines (its header and headings included) pass the same
  // materials guard as the document above.
  if (r.layout === "own" && r.lines?.length) {
    const g2 = guardMaterials(r.lines, clean);
    if (!g2.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused your own file's printed lines: ${g2.refused.flatMap((x) => x.reasons).slice(0, 3).join("; ")}`, ms: ms() };
  }
  // D-063: in a review draft the one placeholder the parse check finds is the email placeholder put there on purpose (R11 keeps
  // any placeholder from being submitted; this file is never stored for submitting). Any other bracketed text still fails it.
  if (placeholder && !r.ats.pass) {
    const printed = ((CareerRender as any).sourceLines(doc) as { text: string }[]).map((l) => l.text).join("\n").split(EMAIL_PLACEHOLDER).join("");
    if (!/\[[^\]\n]*\]/.test(printed)) {
      const rest = r.ats.reasons.filter((x) => !/^placeholder:/.test(x));
      r.ats = { ...r.ats, pass: rest.length === 0, reasons: rest, status: rest.length ? "FAIL" : "REVIEW_DRAFT", warnings: [...r.ats.warnings, `placeholder: the email prints as ${EMAIL_PLACEHOLDER}; this review draft is not ready to submit`] };
    }
  }
  if (!r.ats.pass) return { ok: false, refused: "ats_parse", reason: `it failed the ATS parse check: ${r.ats.reasons.slice(0, 3).join("; ")}`, ms: ms() };
  // A placeholder draft is not stored: the private object is what an application attaches, and this one is not ready to be.
  const path = resumePath(o.userId, r.sha256);
  let link = "";
  if (!placeholder) {
    await o.deps.resumes.put(path, r.pdf);
    link = await o.deps.resumes.signedUrl(path, LINK_TTL_SECONDS);
    const bad = privateLinkProblem(link, path);
    if (bad) return { ok: false, refused: "link", reason: `not offered: ${bad}`, ms: ms() };
  }
  const base = baseResume(clean);
  const diff = CareerTailor.diffResume(base.lines, doc, clean);
  const log0 = changelog({ diff, base, tailored: doc, profile: clean, jd, hidden, persona: persona?.name ?? null });
  // An edited version says what the edits did, against the version they edited (the base-resume diff would call a condensed entry
  // "dropped").
  const log = edits ? { ...log0, line: editLine(edits) } : log0;
  const selected = new Set(doc.lines.flatMap((l: any) => l.factIds));
  // What the person reads, the same on every channel: plain words, and the link alone on its own line so any texting app
  // makes it tappable.
  const text = [`Your resume for ${o.posting.company || "this posting"} is ready. ${log.line}`, ...(link ? [link, "The link works for 7 days."] : [])].join("\n");
  return {
    ok: true, text, link, expires_at: link ? new Date(o.now + LINK_TTL_SECONDS * 1000).toISOString() : "", changelog: log.line, changes: log.items,
    ...(placeholder ? { placeholders: ["email"] } : {}), ...(edits ? { edits } : {}),
    sha256: r.sha256, filename: r.filename, persona: persona?.name ?? null, job_id: o.posting.job_id ?? null, company: o.posting.company ?? null,
    ats: { status: r.ats.status, warnings: r.ats.warnings }, not_on_your_record: (t.requiredGaps || []).map((g: any) => g.requirement),
    lead_not_picked: lead.filter((id) => !selected.has(id)), rendered_in: r.where, ms: ms(), detail: { doc, base, diff, docx: r.docx ?? null, pdf: r.pdf },
    gaps: gapAnalysis({ jd, profile: clean, doc, gaps: t.gaps || [] }), preview: previewText(r.lines ?? ((CareerRender as any).sourceLines(doc) as { text: string }[]).map((l) => l.text)),
    layout: r.layout ?? "plain", template: r.template ?? null, fit: r.fit ? fitRecord(r.fit) : null, ...(r.replaced !== undefined ? { own_layout: { replaced: r.replaced, missing: r.missing ?? [] } } : {}),
  };
}

// ---------------------------------------------------------------- callbacks: tailored vs untailored
export interface AppRow { tailored: boolean; state?: string; replied?: boolean; interviewed?: boolean }
const SENT = new Set(["confirmed", "submitted_unconfirmed"]);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "n/a");
export function callbackRate(rows: AppRow[], min = MIN_PER_ARM) {
  const arm = (tailored: boolean) => {
    const xs = rows.filter((r) => !!r.tailored === tailored && (r.state === undefined || SENT.has(r.state)));
    const applications = xs.length, replies = xs.filter((r) => r.replied || r.interviewed).length, interviews = xs.filter((r) => r.interviewed).length;
    return { applications, replies, interviews, reply_rate: applications ? replies / applications : null, interview_rate: applications ? interviews / applications : null,
      reply: `${pct(replies, applications)} (${replies} of ${applications})`, interview: `${pct(interviews, applications)} (${interviews} of ${applications})`, enough: applications >= min };
  };
  const tailored = arm(true), untailored = arm(false);
  const enough = tailored.enough && untailored.enough;
  const label = enough
    ? `Tailored: replies ${tailored.reply}, interviews ${tailored.interview}. Untailored: replies ${untailored.reply}, interviews ${untailored.interview}.`
    : `NOT enough data: ${tailored.applications} tailored and ${untailored.applications} untailored applications sent; ${min} of each are needed before the rates mean anything.`;
  return { tailored, untailored, enough, min_per_arm: min, label };
}
