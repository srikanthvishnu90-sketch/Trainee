// FEATURE 4 (DIAGNOSIS 2.2): a truthful rewrite of the tailored resume's bullets toward one posting.
//
// 123's tailorResume selects, orders and hides confirmed facts; it never rewords a bullet. Here the model (OpenAI through
// the gateway, CAREER_MODEL) is asked once per tailoring to reword each selected bullet toward the posting's language and
// priorities, and code decides what may print. Every rewritten bullet is audited against the ONE confirmed fact it cites:
//   - every word that carries content (nouns, tools, employers, adjectives, numbers spelled out) must be in that fact
//     (title, text, bullets, org, skills, dates) or the original bullet; only plain connectives and a short list of
//     neutral verbs ("built", "developed", "used") are free, and none of those claims a role (no "led", "managed");
//   - every number must appear in the fact, and every number the original states must still be there;
//   - every skill-lexicon term must be evidenced by the fact; a skill the posting names may be mirrored only when the fact
//     already evidences it (the posting's own words are a target, never a source of claims);
//   - 123's auditResume (the hard gate every shipped line passes) must pass the line on its own, and the whole resume
//     again after all accepted rewrites are in.
// A bullet that fails any rule keeps its original words, and the reason is recorded. No model, a model error, an
// unreadable answer, or the flag off: the select-and-reorder resume ships unchanged (today's behaviour).
//
// Behind CAREER_TAILOR_REWRITE=on (default off). One model call per tailoring, metered by the caller's meter.
import { CareerProfile, CareerRouter, CareerTailor, CareerWriting } from "./router_core.career.js";
import { baseResume, changelog, confirmedOnly, submissionResume } from "./career_tailor.ts";
import { claimProblems } from "./person_claims.ts";
import { redactIdentity } from "./identity_redact.ts";

export const REWRITE_FLAG = "CAREER_TAILOR_REWRITE";
export const MAX_BULLETS = 14;
export const MAX_TOKENS = 1600;
export const rewriteOn = (env: { get(k: string): string | undefined }) => (env.get(REWRITE_FLAG) || "").trim().toLowerCase() === "on";

export type ModelFn = (payload: any) => Promise<any>;
export interface Target { id: string; index: number; text: string; factId: string; section: string | null }
export interface Accepted { id: string; factId: string; before: string; after: string }
export interface Rejected { id: string; factId: string; before: string; proposed: string; reasons: string[] }
export interface RewriteResult {
  status: "rewritten" | "unchanged" | "model_unavailable" | "unreadable" | "no_bullets";
  resume: any; accepted: Accepted[]; rejected: Rejected[]; unchanged: number; detail: string | null;
}

// ------------------------------------------------------------------------------------------------ the bullets to rewrite
const REWRITABLE_KINDS = new Set(["experience", "project", "leadership", "education"]);
// Cited bullets of one experience, project, leadership or education fact. Entry lines, the skills line, certification
// titles and notes stay exactly as assembled.
export function rewriteTargets(resume: any, profile: any, max = MAX_BULLETS): Target[] {
  const out: Target[] = [];
  (resume?.lines || []).forEach((l: any, index: number) => {
    if (!l || l.type !== "bullet" || (l.factIds || []).length !== 1 || !String(l.text || "").trim()) return;
    const f = CareerProfile.getFact(profile, l.factIds[0]);
    if (!f || !REWRITABLE_KINDS.has(f.kind) || l.section === "Certifications") return;
    if (out.length < max) out.push({ id: `b${out.length + 1}`, index, text: String(l.text), factId: l.factIds[0], section: l.section ?? null });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ the per-bullet audit
const FREE = new Set(("a an the and or of in on for to by with using use used uses across into from via through that which while as at per " +
  "each its their this these those over within than both all also then so including such who whose where when after before " +
  "built build builds building developed develop developing designed design designing created create creating implemented " +
  "implementing produced producing wrote writing delivered delivering applied applying worked working").split(/\s+/));
// Irregular verb forms share one base, so "written" traces to "wrote" and "led" to "lead" (and only to it).
const IRREGULAR: Record<string, string> = { wrote: "write", written: "write", writes: "write", built: "build", led: "lead", leads: "lead", ran: "run", made: "make",
  drove: "drive", driven: "drive", grew: "grow", grown: "grow", took: "take", taken: "take", taught: "teach", sold: "sell", won: "win", held: "hold",
  oversaw: "oversee", overseen: "oversee", began: "begin", begun: "begin", spoke: "speak", spoken: "speak", chose: "choose", chosen: "choose", brought: "bring", sent: "send", spent: "spend", met: "meet", found: "find", gave: "give", given: "give" };
const stem = (w: string) => {
  const x0 = w.toLowerCase().replace(/[^a-z0-9+#]/g, "");
  const x = IRREGULAR[x0] ?? x0;
  const s = x.replace(/(ations|ation|ions|ion|ings|ing|ed|es|s|ly)$/, "");
  return s.length >= 3 ? s : x;
};
const sameStem = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
const wordsOf = (t: string) => (String(t || "").match(/[A-Za-z][A-Za-z0-9+#&'.-]*/g) || []).map((w) => w.replace(/[.'-]+$/, "")).filter(Boolean);
const numbersIn = (t: string) => (String(t || "").match(/\d[\d,.]*%?/g) || []).map((x) => x.replace(/,/g, "").replace(/\.$/, ""));
const factCorpus = (f: any) => [f?.title, f?.text, ...(f?.bullets || []), f?.org, f?.name, ...(f?.skills || []), f?.start, f?.end].filter(Boolean).join(" ");

export function auditRewrite(o: { original: string; proposed: string; fact: any; profile: any }): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const p = String(o.proposed ?? "").replace(/\s+/g, " ").trim();
  if (!p) return { ok: false, reasons: ["the rewrite is empty"] };
  // A secret (an SSN, a card number, a password, a code) is refused by name, never quoted back in a reason.
  const secret = redactIdentity(p).removed;
  if (secret.length) return { ok: false, reasons: [`it holds a ${secret[0] === "ssn" ? "Social Security number" : secret[0] === "card" ? "card number" : secret[0] === "code" ? "one-time code" : secret[0] === "account" ? "account number" : "password"}`] };
  if (/[\r\n]/.test(String(o.proposed))) reasons.push("the rewrite is more than one line");
  if (p.length > Math.max(220, Math.round(o.original.length * 1.6))) reasons.push(`the rewrite is ${p.length} characters, too long for one bullet`);
  const corpus = `${factCorpus(o.fact)} ${o.original}`;
  const corpusStems = wordsOf(corpus).map(stem);
  const corpusLc = ` ${corpus.toLowerCase().replace(/[^a-z0-9+#. ]/g, " ")} `;
  // Skills: a lexicon term may print only where this fact evidences it.
  const skills = CareerTailor.skillsInText(p) as string[];
  const skillWords = new Set<string>();
  for (const sk of skills) {
    const nm = sk.toLowerCase();
    const evidenced = (o.fact?.skills || []).some((x: string) => String(x).toLowerCase() === nm) || corpusLc.includes(` ${nm} `) || corpusLc.includes(` ${nm}.`) || corpusLc.includes(` ${nm},`);
    if (!evidenced) reasons.push(`tool or skill "${sk}" is not on this entry of your record`);
    else for (const w of wordsOf(sk)) skillWords.add(stem(w));
  }
  // Numbers: each one traced to the fact; none of the original's dropped.
  // Whole numbers, not digits inside a date: "$2M" is not traced by "2025-06".
  const corpusNums = new Set(numbersIn(corpus.replace(/(\d)-(\d)/g, "$1 $2")));
  for (const n of numbersIn(p)) if (!corpusNums.has(n)) reasons.push(`number "${n}" is not on this entry of your record`);
  const kept = new Set(numbersIn(p));
  for (const n of numbersIn(o.original)) if (!kept.has(n)) reasons.push(`it drops the number "${n}" your bullet states`);
  // Content words: traced to the fact (any position; capitalised words are names: employers, schools, tools).
  const seen = new Set<string>();
  for (const w of wordsOf(p)) {
    const lw = w.toLowerCase();
    if (seen.has(lw) || FREE.has(lw) || lw.length < 2) continue;
    seen.add(lw);
    const st = stem(w);
    if (skillWords.has(st) || corpusStems.some((c) => sameStem(c, st))) continue;
    if (skills.some((sk) => sk.toLowerCase().split(/\s+/).includes(lw))) continue; // already named as an unevidenced skill
    reasons.push(/^[A-Z]/.test(w) && p.indexOf(w) > 0 ? `name "${w}" is not on this entry of your record` : `"${w}" is not on this entry of your record`);
  }
  for (const b of CareerTailor.bannedPhrasesIn(p) as string[]) reasons.push(`banned phrase "${b}"`);
  // TAILORING SCENARIOS (2026-10-29): a word that only shares a stem with the fact is no evidence of a claim: "Managed"
  // traced to "the management team", "team leader" to "the leadership team"; and "40+" is more than "40". Each claim
  // about the person (leadership, numbers, degrees, authorization, how they identify, a secret) is held to this fact.
  for (const c of claimProblems(p, { record: [corpus] })) reasons.push(c.replace(/your confirmed record/g, "this entry of your record"));
  // 123's own gate on the line by itself.
  if (!reasons.length) {
    const a = CareerTailor.auditResume([{ text: p, factIds: [o.fact.id], type: "bullet" }], o.profile);
    for (const v of a.violations || []) reasons.push(`truth audit: ${v.reason}`);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

// ------------------------------------------------------------------------------------------------ the model call
const SYSTEM = [
  "You reword resume bullets so they read toward one job posting. You are given each bullet, the one confirmed fact it comes from, and the posting.",
  "Rules, all of them hard:",
  "- Use only what the bullet's own fact says. Never add a number, metric, percentage, employer, school, client, tool, technology, skill, title, team size or outcome the fact does not state.",
  "- You may reorder the bullet so the part the posting cares about comes first, choose a plainer or stronger verb that claims nothing new (built, developed, designed, created, implemented, used), and use the posting's exact spelling of a skill ONLY when the bullet's fact already names that skill.",
  "- Keep every number the bullet states. Never claim leadership, ownership or management the fact does not state.",
  "- One line per bullet, past tense for past work, no first person, no buzzwords, about the same length as the original.",
  "- If a bullet cannot be improved without adding something, return it unchanged.",
  "Answer with JSON only: {\"bullets\":[{\"id\":\"b1\",\"text\":\"...\"}]} with one entry per bullet id you were given.",
].join("\n");

export function rewritePayload(o: { targets: Target[]; profile: any; jd: any; posting: { title?: string | null; company?: string | null }; voice?: any }) {
  const priorities = [...(o.jd?.mustHaveSkills || []), ...(o.jd?.niceToHaveSkills || [])];
  const body = {
    posting: { title: o.posting.title || null, company: o.posting.company || null, skills_named: priorities, text: String(o.jd?.rawText || "").slice(0, 2500) },
    voice: o.voice ? CareerWriting.voiceTargetsText(o.voice) : null,
    bullets: o.targets.map((t) => {
      const f = CareerProfile.getFact(o.profile, t.factId) || {};
      return { id: t.id, text: t.text, fact: { title: f.title || null, text: f.text || null, bullets: f.bullets || [], skills: f.skills || [] } };
    }),
  };
  return { system: SYSTEM, messages: [{ role: "user", content: JSON.stringify(body) }], max_tokens: MAX_TOKENS };
}
function parseAnswer(msg: any): Map<string, string> | null {
  const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? "")).join("").trim();
  const body = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    const j = JSON.parse(body);
    if (!j || !Array.isArray(j.bullets)) return null;
    const out = new Map<string, string>();
    for (const b of j.bullets) if (b && typeof b.id === "string" && typeof b.text === "string") out.set(b.id, b.text);
    return out;
  } catch { return null; }
}

// ------------------------------------------------------------------------------------------------ the whole rewrite
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
// Sets one cited bullet's words in both the flat line list and the section the PDF renders from; putting the original
// words back (a whole-document refusal) clears the rewrite mark.
function withText(resume: any, t: Target, text: string) {
  const old = resume.lines[t.index];
  const original = old.rewrittenFrom ?? old.text;
  const mark = (l: any) => { l.text = text; if (text === original) delete l.rewrittenFrom; else l.rewrittenFrom = original; };
  const line = { ...old };
  mark(line);
  resume.lines[t.index] = line;
  for (const s of resume.sections || []) {
    if (t.section && s.heading !== t.section) continue;
    const l = (s.lines || []).find((x: any) => x && x.type === "bullet" && x.text === old.text && (x.factIds || [])[0] === t.factId);
    if (l) { mark(l); return; }
  }
}
export async function rewriteResume(o: { resume: any; profile: any; jd: any; posting: { title?: string | null; company?: string | null }; model: ModelFn; voice?: any }): Promise<RewriteResult> {
  const targets = rewriteTargets(o.resume, o.profile);
  const base = { resume: o.resume, accepted: [] as Accepted[], rejected: [] as Rejected[], unchanged: 0, detail: null as string | null };
  if (!targets.length) return { ...base, status: "no_bullets" };
  let msg: any;
  try { msg = await o.model(rewritePayload({ targets, profile: o.profile, jd: o.jd, posting: o.posting, voice: o.voice })); }
  catch (e) { return { ...base, status: "model_unavailable", detail: e instanceof Error ? e.message : String(e) }; }
  const answers = parseAnswer(msg);
  if (!answers) return { ...base, status: "unreadable", detail: "the model's answer was not the JSON asked for" };
  const resume = clone(o.resume);
  const accepted: Accepted[] = [], rejected: Rejected[] = [];
  let unchanged = 0;
  for (const t of targets) {
    const proposed = answers.get(t.id);
    if (proposed === undefined || proposed.replace(/\s+/g, " ").trim() === t.text.trim()) { unchanged++; continue; }
    const fact = CareerProfile.getFact(o.profile, t.factId);
    const a = auditRewrite({ original: t.text, proposed, fact, profile: o.profile });
    // The refused wording rides the reply's meta (tailor_rewrite): a secret in it is never kept.
    if (!a.ok) { rejected.push({ id: t.id, factId: t.factId, before: t.text, proposed: redactIdentity(proposed.trim()).text, reasons: a.reasons }); continue; }
    const after = proposed.replace(/\s+/g, " ").trim();
    withText(resume, t, after);
    accepted.push({ id: t.id, factId: t.factId, before: t.text, after });
  }
  // The hard gate again on the whole document; any line it refuses goes back to its own words.
  const whole = CareerTailor.auditResume(resume, o.profile);
  if (!whole.ok) {
    for (const v of whole.violations || []) {
      const i = accepted.findIndex((x) => x.after === v.line);
      if (i < 0) continue;
      const [x] = accepted.splice(i, 1);
      withText(resume, targets.find((y) => y.id === x.id)!, x.before);
      rejected.push({ id: x.id, factId: x.factId, before: x.before, proposed: x.after, reasons: [`truth audit: ${v.reason}`] });
    }
  }
  return { status: accepted.length ? "rewritten" : "unchanged", resume, accepted, rejected, unchanged, detail: null };
}

// ------------------------------------------------------------------------------------------------ the live turn
// The router's career_tailor result (the tailored document rides it as tailorDoc / tailorJd) is rewritten, re-rendered
// through 123's render (148 PDF, exactly as the router renders it) and the artifact replaced in place, so the PDF that is
// materialized and the copy the router kept on the profile are the rewritten one. Anything missing: untouched. Off: no
// model call, no reply change, and the files become the employer copy (employerFiles).
export interface TurnOut { reply: string; intent: string; result?: any; [k: string]: unknown }
export interface RewriteTurn { out: TurnOut; summary: { status: string; accepted: Accepted[]; rejected: Rejected[]; unchanged: number; changelog: string } | null }
export async function tailorRewriteTurn(o: { out: TurnOut; profile: any; on: boolean; model: ModelFn; voice?: any }): Promise<RewriteTurn> {
  const res = o.out?.result;
  if (o.out?.intent !== "career_tailor" || !res || !res.tailorDoc || !res.artifact || res.artifact.kind !== "tailored_resume" || !o.profile) return { out: o.out, summary: null };
  // Off: no model call and no reply change; the attached files become the employer copy (employerFiles below).
  if (!o.on) { employerFiles(res, res.tailorDoc, o.profile); return { out: o.out, summary: null }; }
  const jd = CareerTailor.parseJD(String(res.tailorJd || ""));
  const posting = { title: res.tailorPosting?.title ?? null, company: res.tailorPosting?.company ?? res.artifact.company ?? null };
  const r = await rewriteResume({ resume: res.tailorDoc, profile: o.profile, jd, posting, model: o.model, voice: o.voice });
  // What changed and why: the select-and-reorder changes against the person's base resume (career_tailor's changelog,
  // from the diff only) and then the rewording, each refusal with its reason.
  const clean = confirmedOnly(o.profile);
  const base = baseResume(clean);
  const cited = { ...r.resume, lines: (r.resume.lines || []).filter((l: any) => l && l.type !== "note" && (l.factIds || []).length) };
  const diff = CareerTailor.diffResume(base.lines, cited, clean);
  const log = changelog({ diff, base, tailored: cited, profile: clean, jd, hidden: [], persona: null, rewrites: r });
  let reply = o.out.reply;
  if (r.accepted.length) {
    if (employerFiles(res, r.resume, o.profile)) {
      res.artifact.reworded = r.accepted.length;
    } else {
      // The rewritten document did not render: the select-and-reorder files stand, and nothing claims a rewrite.
      employerFiles(res, res.tailorDoc, o.profile);
      return { out: { ...o.out, reply: `${reply}\nNo bullet was reworded this time (the reworded version did not render), so the attached resume is in your own confirmed words.` }, summary: { status: "render_failed", accepted: [], rejected: r.rejected, unchanged: r.unchanged, changelog: "" } };
    }
  } else employerFiles(res, res.tailorDoc, o.profile);
  reply = `${reply}\nWhat changed: ${log.line}`;
  return { out: { ...o.out, reply }, summary: { status: r.status, accepted: r.accepted, rejected: r.rejected, unchanged: r.unchanged, changelog: log.line } };
}

// FAMILY MATERIALS (AM-03, 2026-10-26): the files the person is handed are the ones they would send. The router's PDF
// printed the tailor's eligibility verdict on the page as if it were a resume line, was named Resume_Resume.pdf when no
// name is on file, and the reply's "Saved as PDF and DOCX files, attached" was half true: only the PDF rode the reply.
// Here the attached files become the employer copy (career_tailor.ts submissionResume: cited lines only; the verdict and
// gap notes stay in the reply, where the person reads them), audited again against the confirmed facts, rendered as PDF
// and DOCX from the same lines (channel_artifacts.ts documentsOf attaches both), and named for the person or, with no
// name on file, for the posting. The router keeps the same artifact object on the profile, so "send me the pdf again"
// sends this copy. Anything that does not hold (an empty copy, a failed audit, a format that did not render) leaves the
// router's files exactly as they were.
export function employerFiles(res: any, doc: any, profile: any): boolean {
  try {
    const sub = submissionResume(doc);
    if (!sub.sections.length) return false;
    if (!CareerTailor.auditResume(sub, confirmedOnly(profile)).ok) return false;
    const rendered = CareerTailor.render(sub, { profile });
    if (!rendered?.pdf?.base64 || !rendered?.docx?.base64) return false;
    const company = String(res.artifact?.company || res.tailorPosting?.company || "").replace(/\([^)]*\)/g, " ")
      .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    const named = (ext: string, given: string) => (sub.header?.name ? given : `Resume${company ? `_${company}` : ""}.${ext}`);
    Object.assign(res.artifact, {
      text: rendered.text || "", markdown: rendered.markdown || "", sha256: CareerRouter.sha256(rendered.text || ""),
      pdf: { ...rendered.pdf, filename: named("pdf", rendered.pdf.filename) },
      docx: { ...rendered.docx, filename: named("docx", rendered.docx.filename) },
      employer_copy: true,
    });
    return true;
  } catch {
    return false;
  }
}
