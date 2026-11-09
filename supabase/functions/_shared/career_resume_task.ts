// R10 WO-A + WO-B (owner order 2026-11-09; spec docs/architect/specs/APP-LAYER-15-FIXES.md A.2 resume turns 1-3, B.1, B.4,
// B.6, E.1, E.4, E.6): the resume as ONE task that keeps its target.
//
// A resume ask that names a target ("a clean one-page PDF for data analyst internships") and no posting makes a general
// version for that target, now: it never says there is no file, and never tailors to the first role of an old list. The
// target, its level and place, and the person's limits (one page, facts as written, no new experience, don't apply) are
// kept on the profile (_resumeTask) and carried to every later turn of the task. A correction ("that's the wrong role")
// repairs the task: the mismatch is owned once and the file is made again for the right target; "send a download link"
// gets one; "don't apply" is a boundary, never an apply or batch ask. "Send this one" with a resume and job cards both on
// the screen gets one two-choice question and no action until it is settled.
//
// Facts: only the person's own, as written (confirmed facts; with none confirmed, the saved intake, said to be unconfirmed).
// A GPA the record states twice with different values is left off and asked about; a name or email not on file prints as a
// flagged placeholder and is asked for. Each missing or conflicting fact is ONE narrow question.
//
// Files: the PDF (and the DOCX only when asked for) ride the reply as documents (channel_artifacts.ts) and the PDF is kept in
// the private resume bucket behind a signed link (career_tailor.ts privateLinkProblem). The words are read back out of the PDF
// before it is offered: a file that does not carry exactly the lines built for it is not sent. No reply claims a check, an
// attachment or a format that is not delivered.
import { CareerProfile, CareerRender } from "./router_core.career.js";
import { type Block, renderBlocks, splitDates } from "./career_resume_design.ts";
import { CONTACT_QUESTION, LINK_TTL_SECONDS, privateLinkProblem, resumeContact, resumePath, type ResumeStore } from "./career_tailor.ts";

export const RESUME_TASK_INTENT = "career_resume_task";
export const RESUME_CLARIFY_INTENT = "career_resume_clarify";
type Target = { role: string; level: string | null; label: string };
export interface ResumeTask {
  target: Target; limits: string[]; rejected: string | null; said: string[]; asked: string[];
  file: { sha256: string; filename: string; pages: number; label: string } | null; pending: "send_choice" | null; at: string;
}
type Doc = { kind: "document"; format: string; filename: string; mime: string; base64: string; sha256: string };
export type ResumeTurn = { reply: string; intent: string; resultStatus: string; documents: Doc[]; link: string | null; task: ResumeTask };

const lc = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'");
const ROLE = "(?:internships?|interns?|analysts?|engineers?|scientists?|developers?|designers?|managers?|associates?|consultants?|specialists?|coordinators?|researchers?|accountants?|roles?|jobs?|positions?)";
const NOT_TARGET = /\b(resume|cv|pdf|docx|file|page|version|draft|that|this|it|one)\b/;
// What is rejected ("not a machine learning manager job at Reddit") is taken out before the target is read.
function rejectedOf(message: string): string | null {
  const m = /\bnot (?:an? |the )?([a-z][a-z0-9 &/+.-]{2,80}?)(?=[,.;!?]|$| please| since| and )/.exec(lc(message));
  return m ? String(message).slice(m.index + m[0].length - m[1].length, m.index + m[0].length).trim() : null;
}
export function targetOf(message: string): Target | null {
  const t = lc(message).replace(/\bnot (?:an? |the )?[a-z][a-z0-9 &/+.-]{2,80}?(?=[,.;!?]|$| please| since| and )/g, " ");
  const re = new RegExp(`\\b(?:for|is|as|asked for|toward|towards|targeting|aimed at)\\s+(?:an? |the |some )?((?:[a-z][a-z&/+-]*\\s+){0,4}?${ROLE}(?:\\s+${ROLE})*)\\b`, "g");
  for (const m of t.matchAll(re)) {
    const words = m[1].trim().split(/\s+/);
    if (words.some((w) => NOT_TARGET.test(w)) || words.length < 2 && /^(roles?|jobs?|positions?)$/.test(words[0])) continue;
    const level = /\bintern/.test(m[1]) ? "internship" : /\b(senior|lead|manager|director|principal|staff)\b/.test(m[1]) ? "senior" : null;
    const role = words.filter((w) => !/^(internships?|interns?|roles?|jobs?|positions?)$/.test(w)).join(" ");
    if (!role) continue;
    const label = level === "internship" ? `${role} internships` : `${role} roles`;
    return { role, level, label };
  }
  return null;
}
const LIMITS: [string, RegExp][] = [
  ["one_page", /\b(one|1|single)[- ]page\b/], ["facts_as_written", /\b(facts as written|keep the facts|don'?t (add|invent|change)|do not (add|invent))\b/],
  ["no_new_experience", /\b(don'?t|do not) add (any )?experience\b/], ["no_apply", /\b(don'?t|do not|never) (apply|submit)\b|\bnot apply\b/],
  ["ask_first", /\bask me\b/],
];
export const limitsOf = (message: string) => LIMITS.filter(([, re]) => re.test(lc(message))).map(([k]) => k);

const RESUME = /\b(resume|résumé|cv)\b/;
const MAKE = /\b(turn|make|tailor|create|generate|build|format|redo|regenerate|rewrite|fix|update|clean|send|give|produce)\b/;
const DOC = /\b(pdf|docx|word file|one[- ]page|file|document|draft|version)\b/;
const CORRECTION = /\b(wrong (role|job|target|position|resume|one|version)|fix the (target|role)|not what i asked|that'?s not (the|my) (role|target))\b/;
const LINK = /\b(download link|a link|link (to|for)|(isn'?t|won'?t|can'?t|doesn'?t|not) (open|opening|load|loading))\b/;
const AMBIGUOUS = /^\s*(?:please\s+|ok(?:ay)?,?\s+)?send (?:this|that|it)(?: one)?(?: now)?\s*[.!]?\s*$/;
// A posting named or pasted is the posting tailor's (142 career_tailor), not a general version.
function postingNamed(t: string, companies: string[]): boolean {
  if (/\b(this posting|the posting|job (#|number )?\d|number \d|#\d|(role|position|job|opening) at)\b/.test(t)) return true;
  if (t.length > 600 && /\b(requirements|qualifications|responsibilities)\b/.test(t)) return true;
  return companies.some((c) => c.length > 2 && new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}
export type ResumeAsk = "make" | "correct" | "link" | "ask_send" | "send_pdf" | null;
export function resumeAskOf(message: string, task: ResumeTask | null, view: { companies: string[]; jobs: number; posting: boolean; lastFile?: boolean }): ResumeAsk {
  const t = lc(message), rest = t.replace(/\bnot (?:an? |the )?[a-z][a-z0-9 &/+.-]{2,80}?(?=[,.;!?]|$| please| since| and )/g, " ");
  if (task?.pending === "send_choice") {
    if (/\b(submit|apply)\b/.test(t)) return null;
    if (/\b(pdf|resume|to me|the file|download|send it to me)\b/.test(t)) return "send_pdf";
  }
  if (AMBIGUOUS.test(t) && task?.file) return view.jobs > 0 ? "ask_send" : "send_pdf";
  const target = targetOf(message);
  // A correction or a link ask about the resume file this person was last given (ours, or the posting tailor's).
  const onFile = !!task || !!view.lastFile && !!target;
  if (onFile && CORRECTION.test(t) && !postingNamed(rest, view.companies)) return "correct";
  if ((task?.file || onFile) && LINK.test(t) && !postingNamed(rest, view.companies)) return "link";
  if (view.posting || postingNamed(rest, view.companies)) return null;
  if (RESUME.test(t) && (MAKE.test(t) || DOC.test(t)) && (target || task)) return "make";
  if (task && target && DOC.test(t) && MAKE.test(t)) return "make";
  return null;
}

// ---------------------------------------------------------------- the record, as written
// deno-lint-ignore no-explicit-any
type Fact = any;
const SECTION: Record<string, string> = { education: "Education", experience: "Experience", project: "Projects", leadership: "Leadership", certification: "Certifications" };
const GPA = /\bGPA\s*(?:of\s*)?:?\s*(\d\.\d{1,2})\b/gi;
const textOf = (f: Fact) => `${f.title || ""} ${f.text || ""} ${(f.bullets || []).join(" ")}`;
// Words that make an entry relevant to the target: the target's own words and the family's usual evidence.
function scorer(target: Target): (f: Fact) => number {
  const words = target.role.split(/\s+/).filter((w) => w.length > 2);
  const family = /analy|data|business/.test(target.role) ? ["data", "analy", "sql", "python", "excel", "dashboard", "report", "statistic", "model", "tableau", "postgres", "metric"]
    : /engineer|developer|software/.test(target.role) ? ["built", "python", "java", "go", "react", "deploy", "api", "kubernetes", "aws"] : [];
  return (f) => { const x = lc(textOf(f)); return [...words, ...family].reduce((n, w) => n + (x.includes(w) ? 1 : 0), 0); };
}
// A skill read with its label still on it ("Skills: Python", "Interests: Coding"): the label is the person's, kept as theirs.
function skillLines(skills: Fact[]): { text: string }[] {
  const groups = new Map<string, string[]>();
  for (const f of skills) {
    const raw = String(f.name || f.title || f.text || "").trim();
    const m = /^(skills?|technical|interests?|certifications?|languages?|tools?)\s*:\s*(.+)$/i.exec(raw);
    const label = m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()).replace(/^Skill$/, "Skills") : "Skills";
    const v = (m ? m[2] : raw).trim();
    if (v) groups.set(label, [...(groups.get(label) ?? []), v]);
  }
  // Under the Skills heading, a lone Skills group needs no label of its own.
  return [...groups].map(([k, v]) => ({ text: groups.size === 1 && k === "Skills" ? v.join(", ") : `${k}: ${v.join(", ")}` }));
}
const printedOf = (bs: Block[]) => bs.flatMap((b) => b.right ? [b.text, b.right] : [b.text]);
export interface Built { blocks: Block[]; lines: string[]; gpaConflict: string[] | null; contactMissing: boolean; unconfirmed: boolean; left: string[] }
// deno-lint-ignore no-explicit-any
export function buildResume(profile: any, target: Target, source: string): Built {
  const confirmed = (CareerProfile.confirmedFacts(profile || {}) as Fact[]).filter((f) => f.status !== "draft");
  const unconfirmed = !confirmed.length;
  const facts: Fact[] = unconfirmed ? (profile?.facts || []).filter((f: Fact) => f && f.kind) : confirmed;
  const gpas = [...new Set(facts.flatMap((f) => [...textOf(f).matchAll(GPA)].map((m) => m[1])))];
  const gpaConflict = gpas.length > 1 ? gpas : null;
  const asWritten = (s: string) => gpaConflict ? s.replace(/,?\s*\bGPA\s*(?:of\s*)?:?\s*\d\.\d{1,2}\b/gi, "").replace(/\s{2,}/g, " ").trim() : s;
  const top = resumeContact(profile, "confirmed");
  const contactMissing = !top.name || !top.email;
  const blocks: Block[] = [];
  blocks.push(top.name ? { kind: "name", text: top.name } : { kind: "name", text: "[Your name]", flag: true });
  const line = profile?.resume_header?.contactLine || [profile?.basics?.location, top.email, profile?.basics?.phone].filter(Boolean).join(" | ");
  if (!contactMissing && line) blocks.push({ kind: "contact", text: String(line) });
  else blocks.push({ kind: "contact", text: "[email · phone · LinkedIn to add]", flag: true });
  const score = scorer(target);
  // A student target leads with education; everything else leads with experience. Within a section, the entries that show
  // the target's work come first (a stable order otherwise: the person's own).
  const order = target.level === "internship" ? ["education", "experience", "project", "leadership", "certification"] : ["experience", "project", "education", "leadership", "certification"];
  for (const kind of order) {
    const xs = facts.filter((f) => f.kind === kind).map((f, i) => ({ f, i, s: score(f) })).sort((a, b) => b.s - a.s || a.i - b.i);
    if (!xs.length) continue;
    blocks.push({ kind: "heading", text: SECTION[kind] });
    for (const { f } of xs) {
      blocks.push({ kind: "entry", ...splitDates(asWritten(String(f.title || f.text))) });
      for (const b of (f.bullets?.length ? f.bullets : (f.text && f.text !== f.title ? [f.text] : []))) blocks.push({ kind: "bullet", text: asWritten(String(b)) });
    }
  }
  const skills = skillLines(facts.filter((f) => f.kind === "skill"));
  if (skills.length) { blocks.push({ kind: "heading", text: "Skills" }); for (const s of skills) blocks.push({ kind: "line", text: s.text }); }
  const notes = [`Review draft for ${target.label}, built from ${source}.`];
  if (gpaConflict) notes.push(`GPA omitted: your resume shows ${gpaConflict.join(" and ")}; confirm one before use.`);
  notes.push(unconfirmed ? "Facts unconfirmed; not for external submission." : contactMissing ? "Contact details to add; not ready for an employer." : "General version, not written for a specific posting.");
  blocks.push({ kind: "line", text: notes.join(" "), flag: true });
  return { blocks, lines: printedOf(blocks), gpaConflict, contactMissing, unconfirmed, left: [] };
}
// Over one page: the least relevant bullets come off first, then whole entries (never education), each one said.
function toOnePage(R: unknown, b: Built, target: Target) {
  let out = renderBlocks(R, b.blocks);
  const score = scorer(target);
  while (out.fit.pages > 1) {
    const idx = b.blocks.map((x, i) => ({ x, i })).filter(({ x }) => x.kind === "bullet").sort((p, q) => score({ title: p.x.text }) - score({ title: q.x.text }) || q.i - p.i)[0]?.i;
    if (idx === undefined) break;
    b.left.push(b.blocks[idx].text);
    b.blocks.splice(idx, 1);
    out = renderBlocks(R, b.blocks);
  }
  b.lines = printedOf(b.blocks);
  return out;
}

// ---------------------------------------------------------------- the turn
let runtime: Promise<unknown> | null = null;
const R0 = () => runtime ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
  .then(([zlib, crypto, b]) => (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }));
const words = (xs: string[]) => xs.join(" ").replace(/•/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
const fileStem = (t: Target) => `Resume_${t.label.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/[^A-Za-z0-9]+/g, "_").replace(/_+$/, "")}`;
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const hex = async (u: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(u)))].map((x) => x.toString(16).padStart(2, "0")).join("");

// deno-lint-ignore no-explicit-any
export async function resumeTaskTurn(o: { message: string; ctx: any; userId: string; now: number; deps: { resumes: ResumeStore; uploaded: () => Promise<boolean> } }): Promise<ResumeTurn | null> {
  const profile = o.ctx?.profile;
  if (!profile || typeof profile !== "object" || !(profile.facts || []).some((f: Fact) => f && SECTION[f.kind])) return null;
  const prior: ResumeTask | null = profile._resumeTask && typeof profile._resumeTask === "object" ? profile._resumeTask : null;
  const shortlist = Array.isArray(o.ctx?.discovery?.lastShortlist) ? o.ctx.discovery.lastShortlist : [];
  const companies = shortlist.map((r: any) => lc(r?.company)).filter(Boolean);
  const routerLast = [...(Array.isArray(profile._careerRouterArtifacts) ? profile._careerRouterArtifacts : [])].reverse().find((a: any) => a?.pdf?.base64);
  const ask = resumeAskOf(o.message, prior, { companies, jobs: shortlist.length, posting: !!o.ctx?.posting, lastFile: !!routerLast });
  if (!ask) { if (prior?.pending) prior.pending = null; return null; }
  const t = lc(o.message);
  const named = targetOf(o.message);
  if (!named && !prior) return null;
  const target = named ?? prior!.target;
  const task: ResumeTask = { target, limits: [...new Set([...(prior?.limits ?? []), ...limitsOf(o.message)])], rejected: rejectedOf(o.message) ?? prior?.rejected ?? null,
    said: prior && prior.target.label === target.label ? [...prior.said] : [], asked: [...(prior?.asked ?? [])], file: prior?.file ?? null, pending: null, at: new Date(o.now).toISOString() };
  const say: string[] = [];
  if (ask === "ask_send") {
    task.pending = "send_choice";
    profile._resumeTask = task;
    const n = shortlist.length;
    const which = n === 1 ? "the job I listed" : `one of the ${n} jobs I listed`;
    return { reply: `Do you mean submit an application for ${which}, or send you the resume PDF for ${task.file!.label}? Nothing is sent until you say.`, intent: RESUME_CLARIFY_INTENT, resultStatus: "awaiting_user", documents: [], link: null, task };
  }
  // The last resume file this person was given, by its target: ours, or the posting tailor's (142 _careerRouterArtifacts).
  const lastWasOther = ask === "correct" && (routerLast && (!prior?.file || Date.parse(routerLast.at || routerLast.created_at || "") > Date.parse(prior.at)) || (prior?.file && prior.file.label !== target.label));
  if (ask === "correct") {
    const used = routerLast?.company && (!prior?.file || prior.file.label === target.label) ? `the ${routerLast.company} posting from your earlier list` : task.rejected;
    if (lastWasOther) say.push(`You're right, I used the wrong role${used ? ` (${used})` : ""}. This version is for ${target.label}.`);
    else say.push(`The file I sent is for ${target.label}${task.rejected ? `, not the ${task.rejected}` : ""}; here it is again.`);
  }
  const R = await R0();
  const source = (await o.deps.uploaded().catch(() => false)) ? "the facts read from your uploaded resume" : "your saved resume intake, not the original file";
  const built = buildResume(profile, target, source);
  const out = toOnePage(R, built, target);
  // The words read back out of the PDF must be exactly the lines built (no line lost, none added).
  const back = (R as any).extractPdfLines((R as any).primitives.bytes(out.pdf)) as string[];
  if (words(back) !== words(built.lines)) {
    profile._resumeTask = task;
    return { reply: `I couldn't make a PDF for ${target.label} that reads back correctly, so I haven't sent one. Ask me again and I'll rebuild it.`, intent: RESUME_TASK_INTENT, resultStatus: "failed", documents: [], link: null, task };
  }
  const sha = await hex(out.pdf), filename = `${fileStem(target)}.pdf`;
  const documents: Doc[] = [{ kind: "document", format: "pdf", filename, mime: "application/pdf", base64: b64(out.pdf), sha256: sha }];
  if (/\b(docx|word)\b/.test(t)) documents.push({ kind: "document", format: "docx", filename: `${fileStem(target)}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: b64(out.docx), sha256: await hex(out.docx) });
  let link: string | null = null;
  try {
    const path = resumePath(o.userId, sha);
    await o.deps.resumes.put(path, out.pdf);
    const l = await o.deps.resumes.signedUrl(path, LINK_TTL_SECONDS);
    link = privateLinkProblem(l, path) ? null : l;
  } catch (e) { console.error("resume task link:", (e as Error)?.message ?? e); }
  task.file = { sha256: sha, filename, pages: out.fit.pages, label: target.label };
  const pages = out.fit.pages === 1 ? "one-page" : `${out.fit.pages}-page`;
  if (ask === "make" || ask === "send_pdf") say.push(documents.length > 1 ? `Here are the PDF and Word (DOCX) files of your resume for ${target.label}.`
    : ask === "send_pdf" || prior?.file?.label === target.label && !named ? `Here is the resume PDF for ${target.label}.` : `Here is your ${pages} resume PDF for ${target.label}.`);
  else if (ask === "link" && !say.length) say.push(`Here is the resume PDF for ${target.label} again, with a download link.`);
  if (!task.said.includes("general") && ask !== "send_pdf") { say.push("It's a general version, not written for one posting; send me a posting and I'll tailor it to that."); task.said.push("general"); }
  if (!task.said.includes("source")) {
    say.push(`I used ${source}${built.unconfirmed ? " (not yet confirmed by you)" : ""}, kept every fact as written and added no experience.`);
    task.said.push("source");
  }
  if (built.left.length) say.push(`To fit one page I left off ${built.left.length === 1 ? "one bullet" : `${built.left.length} bullets`}: "${built.left[0]}"${built.left.length > 1 ? " and the next least relevant" : ""}.`);
  if (task.limits.includes("one_page") && out.fit.pages > 1) say.push(`It runs to ${out.fit.pages} pages even with the least relevant bullets off; I set nothing below 10 pt.`);
  const questions: [string, string][] = [];
  if (built.gpaConflict) questions.push(["gpa", `Your GPA is left off because your resume shows two values (${built.gpaConflict.join(" and ")}). Which one is right?`]);
  if (built.contactMissing) questions.push(["contact", `Your name and contact details aren't on file, so the top shows placeholders. ${CONTACT_QUESTION}`]);
  if (built.unconfirmed) questions.push(["confirm", `These facts are still unconfirmed. Are they right as written?`]);
  const asking = /\bask me\b/.test(t) || ask === "make" && !prior;
  for (const [k, q] of questions) {
    if (!task.asked.includes(k) || asking) { say.push(q); if (!task.asked.includes(k)) task.asked.push(k); }
  }
  if (questions.length && !say.some((s) => s.endsWith("?")) && ask !== "send_pdf") say.push(`Still open: ${questions.map(([k]) => k === "gpa" ? "your GPA" : k === "contact" ? "your name and email" : "your confirmation of the facts").join(" and ")}.`);
  if (limitsOf(o.message).includes("no_apply")) say.push("I haven't applied to anything.");
  if (link) say.push(`Download link (works for 7 days):\n${link}`);
  else say.push("I couldn't make a download link this time.");
  profile._resumeTask = task;
  return { reply: say.join("\n"), intent: RESUME_TASK_INTENT, resultStatus: questions.length ? "awaiting_user" : "completed", documents, link, task };
}
