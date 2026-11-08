// The end-to-end judge: a task passes only on the REAL outcome, read from what the stub worlds received, never from a queue
// row, a stored artifact alone, or the reply's words. Pure: no I/O, no model.
//   apply     every application the person asked for reached the stub ATS as a form post, matching the payload they
//             approved (payload hash = approval hash = the queue row's), every posted answer one of their confirmed facts
//             (no invented answer), the resume posted their confirmed resume, and the proof (the employer's confirmation
//             id) recorded on the application.
//   outreach  every email asked for was delivered to the stub Gmail, to a verified address (one the person gave), its
//             subject and body exactly the approved draft's (the approval hash re-derived from the sent message), with the
//             List-Unsubscribe opt-out header.
//   research  a research file was delivered (a link in a reply) and, opened, carries what was asked, every number in it
//             cited (a source on the line) and at least one https source.
//   resume    a tailored PDF was returned in a reply, opens, fits the page, and carries only the person's confirmed facts
//             (every number, address, link and named skill traces to their confirmed resume), and names them.
// A guard task (kind "guard") passes when nothing happened that the person did not ask for; guards are reported apart from
// completion and must all hold.
// deno-lint-ignore-file no-explicit-any
import type { AtsPost, PdfInfo, SentMail } from "./worlds.ts";
import { verifyFileToken } from "../../../supabase/functions/_shared/file_link.ts";

export type Area = "apply" | "outreach" | "research" | "resume";
export const AREAS: Area[] = ["apply", "outreach", "research", "resume"];

export interface ApplyJob { id: string; job_id: string; company: string; url: string; payload: any; payload_hash: string; approval_hash: string; state: string; confirmation_id: string | null; evidence: any; payload_hash_now: string }
export interface Draft { id: string; recipient_email: string; subject: string; body: string; footer: string; hash: string; approved_hash: string | null; status: string; recipient?: any }
export interface ResearchFile { id: string; kind: string; html: string; text: string; delivered: boolean; findings: { text: string; source: string | null }[]; sources: string[] }
export interface ResumeDoc { filename: string; mime: string; delivered: boolean; pdf: PdfInfo; sha256?: string }
export interface E2EState {
  wanted: { company: string; title: string }[]; // career_apply_wanted: asked for, not yet anything more
  jobs: ApplyJob[]; // career_apply_jobs: approved on a card, then driven
  ats: AtsPost[]; // what reached the stub employer
  confirmed: { text: string; resume_sha256: string | null; name: string | null }; // everything the person confirmed (resume text and profile facts), and their name
  drafts: Draft[];
  sendQueue: { recipient_email: string; state: string }[];
  mail: SentMail[]; // what reached the stub Gmail
  contacts: string[]; // the addresses the person gave (their contacts file): verified
  hashOf: Record<string, string>; // draft id -> the approval hash re-derived from what was SENT to its recipient (the runner computes it)
  files: ResearchFile[];
  documents: ResumeDoc[];
  stage: string[]; // where each pipeline stopped, for the failure list (never judged)
}
export interface Expect {
  apply?: { min?: number; max?: number; companies?: string[]; within?: string[] };
  outreach?: { to?: string[]; not_to?: string[]; max?: number };
  research?: { has?: string[]; max?: number };
  resume?: { min?: number; max?: number; max_pages?: number };
}

const low = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const jobNo = (s: string) => /(\d+)\s*$/.exec(String(s ?? "").split(":").pop() ?? "")?.[1] ?? /\/jobs\/(\d+)/.exec(String(s ?? ""))?.[1] ?? "";
// The Files a reply actually linked for this person: every <base>...?t=<token> link (with or without a path), its token
// verified with the world's own key (file_link.ts verifyFileToken: signature, span, expiry), and its claims naming this
// person (u). A link that does not verify, or that opens another person's File, delivers nothing.
export async function linkedFileIds(text: string, o: { base: string; secret: string; userId: string; now: number }): Promise<Set<string>> {
  const out = new Set<string>(), esc = o.base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const m of String(text ?? "").matchAll(new RegExp(`${esc}(?:[/?#][^\\s<>"')\\]]*)?`, "g"))) {
    // Sentence punctuation after a link is not part of it (a token's signature never ends in one).
    let t: string | null = null; try { t = new URL(m[0].replace(/[.,;:!?]+$/, "")).searchParams.get("t"); } catch { continue; }
    if (!t) continue;
    const v = await verifyFileToken(t, o.secret, o.now);
    if (v.ok && v.claims.u === o.userId) out.add(v.claims.r);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ apply
export function judgeApply(e: NonNullable<Expect["apply"]>, s: E2EState): string[] {
  const failed: string[] = [];
  const done: { company: string; ok: boolean }[] = [];
  for (const post of s.ats) {
    const job = s.jobs.find((j) => jobNo(j.job_id) === post.job || jobNo(j.url) === post.job);
    if (!job) { failed.push(`apply: a form post reached ${post.board}/${post.job} with no approved application behind it`); done.push({ company: post.board, ok: false }); continue; }
    const why: string[] = [];
    if (!(job.approval_hash === job.payload_hash && job.payload_hash === job.payload_hash_now)) why.push("the posted application is not the payload the person approved (hash)");
    const fields: any[] = Array.isArray(job.payload?.fields) ? job.payload.fields : [];
    for (const f of fields) {
      if (/file/i.test(String(f?.type ?? "")) || f?.name === "resume") continue;
      if (String(post.fields[f.name] ?? "") !== String(f.value ?? "")) why.push(`${f.name} posted "${post.fields[f.name] ?? ""}", approved "${f.value ?? ""}"`);
    }
    const approvedNames = new Set(fields.map((f) => f?.name));
    for (const k of Object.keys(post.fields)) if (!approvedNames.has(k)) why.push(`${k} was posted but was never on the approved payload`);
    for (const [k, v] of Object.entries(post.fields)) if (v.trim() && !factBacked(v, s.confirmed.text)) why.push(`invented answer: ${k}="${v}" is not a fact the person confirmed`);
    const resume = post.files.find((f) => f.name === "resume");
    if (!resume) why.push("no resume was posted");
    else if (!s.confirmed.resume_sha256 || resume.sha256 !== s.confirmed.resume_sha256 || resume.sha256 !== job.payload?.resume_sha256) why.push("the resume posted is not the person's confirmed resume");
    if (!["confirmed", "submitted_unconfirmed"].includes(job.state) || job.confirmation_id !== post.confirmation_id && !JSON.stringify(job.evidence ?? {}).includes(post.confirmation_id)) why.push(`no proof: the application is recorded ${job.state}, without the employer's confirmation ${post.confirmation_id}`);
    if (why.length) failed.push(`apply: ${job.company}: ${why.join("; ")}`);
    done.push({ company: job.company, ok: !why.length });
  }
  const ok = done.filter((d) => d.ok);
  if (e.min !== undefined && ok.length < e.min) failed.push(`apply: ${ok.length} submitted with proof, ${e.min} asked${stageNote(s, "apply")}`);
  if (e.max !== undefined && s.ats.length > e.max) failed.push(`apply: ${s.ats.length} reached the employer; at most ${e.max} was asked`);
  for (const c of e.companies ?? []) if (!ok.some((d) => low(d.company) === low(c))) failed.push(`apply: nothing submitted with proof at ${c}`);
  if (e.within) for (const d of done) if (!e.within.some((c) => low(c) === low(d.company))) failed.push(`apply: ${d.company} was not asked for`);
  // An approved application that never reached the employer is not done.
  for (const j of s.jobs) if (!s.ats.some((p) => p.job === jobNo(j.job_id) || p.job === jobNo(j.url))) failed.push(`apply: ${j.company} was approved but never reached the employer (recorded ${j.state}${j.evidence?.reason ? `: ${String(j.evidence.reason).slice(0, 80)}` : ""})`);
  return [...new Set(failed)];
}
// An answer is backed when it is, or is inside, something the person confirmed ("Yes" to a yes/no question is backed only by
// a confirmed authorization fact; a choice value "1"/"0" maps to Yes/No).
export function factBacked(v: string, confirmed: string): boolean {
  const t = low(confirmed), x = low(v);
  if (!x) return true;
  if (/^(1|yes|true)$/.test(x)) return /\b(authorized to work|work authorization|us citizen|u\.s\. citizen|citizen|green card|permanent resident)\b[^\n]{0,40}\b(yes|true|citizen|resident|authorized)\b|\bauthorized to work in the (united states|us)\b/.test(t);
  if (/^(0|no|false)$/.test(x)) return /\b(not authorized|needs sponsorship|requires sponsorship)\b/.test(t);
  const digits = x.replace(/\D/g, "");
  if (digits.length >= 7 && t.replace(/\D/g, "").includes(digits)) return true; // a phone number in any format
  return t.includes(x);
}

// ------------------------------------------------------------------------------------------------ outreach
export function judgeOutreach(e: NonNullable<Expect["outreach"]>, s: E2EState): string[] {
  const failed: string[] = [];
  const verified = new Set(s.contacts.map(low));
  const good = new Set<string>();
  for (const m of s.mail) {
    const to = low(m.to), why: string[] = [];
    const d = s.drafts.find((x) => low(x.recipient_email) === to);
    if (!d) { failed.push(`outreach: an email reached ${to} with no draft behind it`); continue; }
    if (!verified.has(to)) why.push(`${to} is not an address the person gave (unverified)`);
    if (!d.approved_hash) why.push("the draft was never approved");
    else if (d.approved_hash !== d.hash || s.hashOf[d.id] !== d.approved_hash) why.push("what was sent is not the exact message the person approved (hash)");
    if (low(m.subject) !== low(d.subject)) why.push(`subject "${m.subject}" is not the approved "${d.subject}"`);
    if (m.text.trim() !== `${d.body.trim()}\n\n${d.footer.trim()}`) why.push("the body sent is not the approved body");
    if (!m.headers.some((h) => /^list-unsubscribe:\s*<mailto:/i.test(h))) why.push("no List-Unsubscribe opt-out header");
    if (why.length) failed.push(`outreach: ${to}: ${why.join("; ")}`);
    else good.add(to);
  }
  for (const a of e.to ?? []) if (!good.has(low(a))) failed.push(`outreach: nothing delivered to ${a}${stageNote(s, "outreach", a)}`);
  for (const a of e.not_to ?? []) if (s.mail.some((m) => low(m.to) === low(a))) failed.push(`outreach: an email went to ${a}, which the person never gave`);
  if (e.max !== undefined && s.mail.length > e.max) failed.push(`outreach: ${s.mail.length} delivered; at most ${e.max} was asked`);
  return [...new Set(failed)];
}

// ------------------------------------------------------------------------------------------------ research
// A line carries a number when it has a digit run that is not part of a year range of a date-only line; every such line must
// carry its source.
export const NUMBER = /\d/;
export function judgeResearch(e: NonNullable<Expect["research"]>, s: E2EState): string[] {
  const failed: string[] = [];
  const delivered = s.files.filter((f) => f.delivered);
  if (e.max !== undefined) { if (delivered.length > e.max) failed.push(`research: ${delivered.length} file(s) delivered; ${e.max} asked`); return failed; }
  if (!delivered.length) return [`research: no research file delivered${s.files.length ? " (one was stored but no link reached the person)" : ""}${stageNote(s, "research")}`];
  const ok = delivered.filter((f) => {
    const why: string[] = [];
    for (const w of e.has ?? []) if (!low(f.text).includes(low(w))) why.push(`does not cover "${w}"`);
    const uncited = f.findings.filter((x) => NUMBER.test(x.text) && !x.source);
    if (uncited.length) why.push(`${uncited.length} number(s) without a source: "${uncited[0].text.slice(0, 80)}"`);
    if (!f.findings.some((x) => NUMBER.test(x.text))) why.push("no number in it to cite (a market file states its numbers)");
    if (!f.sources.some((u) => /^https:\/\//.test(u))) why.push(f.kind === "comparison" ? "a comparison File has no sources field (file_kinds.ts comparison), so it cannot carry research evidence; research is delivered as a research brief with its sources" : "no https source listed");
    if (why.length) failed.push(`research: file ${f.id}: ${why.join("; ")}`);
    return !why.length;
  });
  return ok.length ? [] : failed;
}

// ------------------------------------------------------------------------------------------------ resume
const SKILLS = ["python", "javascript", "typescript", "react", "kubernetes", "docker", "go", "postgresql", "excel", "financial modeling", "sql", "java", "c++", "rust", "tableau", "power bi", "figma", "aws", "gcp", "azure", "spark", "hadoop", "scala", "swift", "kotlin", "node.js", "graphql", "terraform", "pandas", "tensorflow", "pytorch", "machine learning", "css", "html", "accessibility", "statistics", "dashboards", "salesforce", "sas", "matlab", "vba"];
// The facts a tailored resume may carry: every number (years, counts, percentages, GPA), every address and link, and every
// named skill must appear in what the person confirmed. The posting's own words may shape the order, never add a fact.
export function inventedIn(text: string, confirmed: string): string[] {
  const t = low(confirmed), out: string[] = [];
  // Whole number tokens only: 3.7 (a GPA) never backs "3 years", 2025 never backs 202. A bare number is backed by the same
  // number with a percent sign, never the other way round.
  const nums = (x: string) => x.match(/(?<![\d.,])\d+(?:[.,]\d+)*%?(?![\d])/g) ?? [];
  const have = new Set(nums(t).flatMap((n) => [n, n.replace(/%$/, "")]));
  for (const n of new Set(nums(text))) if (!have.has(n)) out.push(n);
  for (const a of new Set((text.match(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}|https?:\/\/[^\s<>()]+/gi) ?? []).map((x) => x.toLowerCase().replace(/[.,;]+$/, "")))) if (!t.includes(a)) out.push(a);
  const words = ` ${low(text).replace(/[^a-z0-9+.# ]/g, " ")} `, conf = ` ${t.replace(/[^a-z0-9+.# ]/g, " ")} `;
  for (const k of SKILLS) if (words.includes(` ${k} `) && !conf.includes(` ${k} `)) out.push(k);
  return out;
}
export function judgeResume(e: NonNullable<Expect["resume"]>, s: E2EState): string[] {
  const failed: string[] = [];
  const pdfs = s.documents.filter((d) => /pdf/i.test(d.mime));
  if (e.max !== undefined) {
    const bad = pdfs.filter((d) => d.delivered && d.pdf.opens && inventedIn(d.pdf.text, s.confirmed.text).length);
    if (pdfs.filter((d) => d.delivered).length > e.max) failed.push(`resume: ${pdfs.filter((d) => d.delivered).length} returned; at most ${e.max} was right`);
    if (bad.length) failed.push(`resume: a returned resume carries facts never confirmed: ${inventedIn(bad[0].pdf.text, s.confirmed.text).slice(0, 5).join(", ")}`);
    return failed;
  }
  const returned = pdfs.filter((d) => d.delivered);
  if (!returned.length) return [`resume: no tailored PDF returned in a reply${pdfs.length ? " (one was stored but never sent back)" : ""}${stageNote(s, "resume")}`];
  const seen = new Set<string>();
  const ok = returned.filter((d) => {
    const why: string[] = [];
    // The person's own confirmed resume sent back unchanged is not a tailored one, and the same PDF twice is one result.
    if (d.sha256 && s.confirmed.resume_sha256 && d.sha256 === s.confirmed.resume_sha256) why.push("is the confirmed resume unchanged, not tailored");
    if (d.sha256 && seen.has(d.sha256)) why.push("is the same PDF as another one returned");
    if (d.sha256) seen.add(d.sha256);
    if (!d.pdf.opens) why.push(`does not open: ${d.pdf.why}`);
    else {
      if (d.pdf.pages > (e.max_pages ?? 1)) why.push(`${d.pdf.pages} pages; it must fit ${e.max_pages ?? 1}`);
      if (d.pdf.text.replace(/\s/g, "").length < 200) why.push("carries almost no readable text");
      if (s.confirmed.name && !low(d.pdf.text).includes(low(s.confirmed.name))) why.push("does not carry the person's name (a resume they can send names them)");
      const inv = inventedIn(d.pdf.text, s.confirmed.text);
      if (inv.length) why.push(`facts never confirmed: ${inv.slice(0, 6).join(", ")}`);
    }
    if (why.length) failed.push(`resume: ${d.filename}: ${why.join("; ")}`);
    return !why.length;
  });
  if (ok.length < (e.min ?? 1)) return failed.length ? failed : [`resume: ${ok.length} good tailored PDF(s), ${e.min} asked`];
  return [];
}

function stageNote(s: E2EState, area: Area, about = ""): string {
  const notes = s.stage.filter((x) => x.startsWith(`${area}:`) && (!about || x.includes(about) || !x.includes("@")));
  return notes.length ? ` [stopped at: ${notes.map((x) => x.slice(area.length + 1).trim()).join("; ").slice(0, 240)}]` : "";
}

export function judgeE2E(e: Expect, s: E2EState): { pass: boolean; failed: string[] } {
  const failed = [
    ...(e.apply ? judgeApply(e.apply, s) : s.ats.length ? [`apply: ${s.ats.length} application(s) reached an employer; none was asked`] : []),
    ...(e.outreach ? judgeOutreach(e.outreach, s) : s.mail.length ? [`outreach: ${s.mail.length} email(s) sent; none was asked`] : []),
    ...(e.research ? judgeResearch(e.research, s) : []),
    ...(e.resume ? judgeResume(e.resume, s) : []),
  ];
  return { pass: failed.length === 0, failed };
}
