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

export const RESUME_BUCKET = "career-resumes";
export const LINK_TTL_SECONDS = 7 * 86400;
export const MIN_PER_ARM = 30;
export const MAX_PERSONAS = 10;
export const PERSONAS_KEY = "career:resume-personas";

// ---------------------------------------------------------------- the confirmed-only record
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
// A fresh profile holding only the person's confirmed facts: a draft is not in it at all, so it cannot support a line,
// vouch for a skill name, or be picked.
export function confirmedOnly(profile: any): any {
  const facts = (CareerProfile.confirmedFacts(profile || {}) as any[]).filter((f) => f.status !== "draft").map(clone);
  return CareerProfile.createProfile({ id: profile?.id, basics: clone(profile?.basics || {}), facts });
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
export function contactFromMessage(message: string, name: unknown, email: unknown): { ok: true; name: string; email: string } | { ok: false; error: string } {
  const n = squash(String(name ?? "")), e = String(email ?? "").trim(), m = squash(String(message ?? ""));
  if (n.length < 2 || n.length > 80 || !NAME.test(n)) return { ok: false, error: "the name must be 2 to 80 letters, spaces, hyphens or apostrophes" };
  if (!EMAIL.test(e)) return { ok: false, error: "that is not a valid email address" };
  if (!tokenIn(m, e, /[A-Za-z0-9._%+@-]/)) return { ok: false, error: "the person did not type that email in this message; they must type it themselves" };
  if (!tokenIn(m, n, /\p{L}/u)) return { ok: false, error: "the person did not type that name in this message; they must type it themselves" };
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
// own bullets) and the sections that hold them; it never changes a line.
export function applyPersonaOrder(resume: any, lead: string[]): any {
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
  const text = (R.extractPdfLines(buf) as string[]).join("\n").toLowerCase();
  const name = String(resume?.header?.name || ""), email = String(resume?.header?.email || "");
  if (!name || !text.includes(name.toLowerCase())) reasons.push("contact: the name does not come back out of the file");
  if (!email || !text.includes(email.toLowerCase())) reasons.push("contact: the email does not come back out of the file");
  if (!(resume?.sections || []).some((s: any) => s.lines.some((l: any) => l.type === "entry"))) reasons.push("content: no experience, project or education entry");
  return { pass: reasons.length === 0, status: reasons.length ? "FAIL" : check.status, reasons, warnings };
}
export type RenderOut = { ok: true; pdf: Uint8Array; sha256: string; filename: string; ats: AtsVerdict; where: string } | { ok: false; reason: string; where: string };
export type ResumeRenderer = (resume: any) => Promise<RenderOut>;
export function renderWith(R: any, where: string): ResumeRenderer {
  return async (resume) => {
    if (!R?.runtime?.zlib || !R?.runtime?.crypto) return { ok: false, where, reason: `the PDF renderer needs zlib and crypto, which ${where} does not provide` };
    const r = R.renderPdf(resume);
    if (!r.ok) return { ok: false, where, reason: r.reason || "the PDF could not be rendered" };
    const pdf = new Uint8Array(r.buffer);
    return { ok: true, pdf, sha256: R.sha256(r.buffer), filename: r.filename, ats: atsHarness(R, resume, pdf), where };
  };
}
// The edge (Deno): 148 over Deno's own node: built-ins, loaded once, on the first render.
export function edgeRenderer(): ResumeRenderer {
  const where = "the edge function (Deno)";
  let inner: Promise<ResumeRenderer> | null = null;
  return async (resume) => {
    inner ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
      .then(([zlib, crypto, b]) => renderWith((CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), where))
      .catch((e) => async () => ({ ok: false as const, where, reason: `its node built-ins could not be loaded (${e?.message ?? e})` }));
    return (await inner)(resume);
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
export type TailorOut = {
  ok: true; text: string; link: string; expires_at: string; changelog: string; changes: ChangeItem[]; sha256: string; filename: string;
  persona: string | null; job_id: string | null; company: string | null; ats: { status: string; warnings: string[] };
  not_on_your_record: string[]; lead_not_picked: string[]; rendered_in: string; ms: number; detail: { doc: any; base: any; diff: any };
} | { ok: false; refused: "no_confirmed_facts" | "no_contact" | "truth_audit" | "render" | "ats_parse" | "link"; reason: string; ms: number };

export async function tailorForPosting(o: {
  userId: string; profile: any; posting: { text: string; job_id?: string | null; company?: string | null };
  persona?: Persona | null; deps: TailorDeps; now: number;
}): Promise<TailorOut> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const clean = confirmedOnly(o.profile);
  if (!(clean.facts || []).some((f: any) => HEADING[f.kind])) return { ok: false, refused: "no_confirmed_facts", reason: "there are no confirmed experience, project or education facts on file to build a resume from", ms: ms() };
  if (!clean.basics?.name || !clean.basics?.email) return { ok: false, refused: "no_contact", reason: `your name and email are not on your profile yet, and an employer's system reads them from the top of the resume. Ask exactly: "${CONTACT_QUESTION}"`, ms: ms() };
  const persona = o.persona ?? null;
  const hidden = persona ? persona.hide.filter((id) => CareerProfile.getFact(clean, id)) : [];
  const picked = hidden.length ? CareerProfile.createProfile({ id: clean.id, basics: clean.basics, facts: clean.facts.filter((f: any) => !hidden.includes(f.id)) }) : clean;
  const jd = CareerTailor.parseJD(o.posting.text);
  const t = (o.deps.tailor ?? CareerTailor.tailorResume)(picked, jd, { jobId: o.posting.job_id ?? null, company: o.posting.company ?? null });
  if (!t.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused it: ${(t.violations || []).slice(0, 3).map((v: any) => v.reason).join("; ")}`, ms: ms() };
  if (t.mode !== "full" || !t.resume) return { ok: false, refused: "truth_audit", reason: t.reason || "no resume was assembled", ms: ms() };
  const lead = persona ? persona.lead.filter((id) => CareerProfile.getFact(picked, id)) : [];
  const ordered = applyPersonaOrder(t.resume, lead);
  const doc = submissionResume(ordered);
  // The hard gate again, on exactly what will print: every line cited to a confirmed fact that supports it.
  const audit = CareerTailor.auditResume(doc, clean);
  if (!audit.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused it: ${audit.violations.slice(0, 3).map((v: any) => v.reason).join("; ")}`, ms: ms() };
  // G5/B2: no skill, employer, title, date or number the person did not confirm, on any printed line.
  const guard = guardMaterials(documentLines(doc), clean);
  if (!guard.ok) return { ok: false, refused: "truth_audit", reason: `the truth check refused it: ${guard.refused.flatMap((x) => x.reasons).slice(0, 3).join("; ")}`, ms: ms() };
  const r = await o.deps.render(doc);
  if (!r.ok) return { ok: false, refused: "render", reason: `the PDF could not be made: ${r.reason}`, ms: ms() };
  if (!r.ats.pass) return { ok: false, refused: "ats_parse", reason: `it failed the ATS parse check: ${r.ats.reasons.slice(0, 3).join("; ")}`, ms: ms() };
  const path = resumePath(o.userId, r.sha256);
  await o.deps.resumes.put(path, r.pdf);
  const link = await o.deps.resumes.signedUrl(path, LINK_TTL_SECONDS);
  const bad = privateLinkProblem(link, path);
  if (bad) return { ok: false, refused: "link", reason: `not offered: ${bad}`, ms: ms() };
  const base = baseResume(clean);
  const diff = CareerTailor.diffResume(base.lines, doc, clean);
  const log = changelog({ diff, base, tailored: doc, profile: clean, jd, hidden, persona: persona?.name ?? null });
  const selected = new Set(doc.lines.flatMap((l: any) => l.factIds));
  // What the person reads, the same on every channel: plain words, and the link alone on its own line so any texting app
  // makes it tappable.
  const text = [`Your resume for ${o.posting.company || "this posting"} is ready. ${log.line}`, link, "The link works for 7 days."].join("\n");
  return {
    ok: true, text, link, expires_at: new Date(o.now + LINK_TTL_SECONDS * 1000).toISOString(), changelog: log.line, changes: log.items,
    sha256: r.sha256, filename: r.filename, persona: persona?.name ?? null, job_id: o.posting.job_id ?? null, company: o.posting.company ?? null,
    ats: { status: r.ats.status, warnings: r.ats.warnings }, not_on_your_record: (t.requiredGaps || []).map((g: any) => g.requirement),
    lead_not_picked: lead.filter((id) => !selected.has(id)), rendered_in: r.where, ms: ms(), detail: { doc, base, diff },
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
