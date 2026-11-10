// RESUME LOOP (agent2/resumes, 2026-11-09; release item 3, docs/architect/VERIFICATION-15.md): synthetic TEST profiles x
// target roles, each resume made through the real tailor path (the brain's tailor_resume tool, agent/career_tools.ts, which
// calls career_tailor.ts tailorForPosting and attaches the PDF and the Word copy through `deliver`), then every delivered
// file opened the way a reader's tools open it (scripts/resume-loop-extract.py: poppler and pdfminer for the PDF, the zip
// and python-docx for the DOCX). Measured per file: it opens; its page count fits what its template promises; every
// name, number, date, employer and school on it traces to a fact the person confirmed (or to a fixed section heading);
// the target role is carried. Offline and free: no model, no network.
//
//   deno run -A --no-check scripts/resume-loop.ts [--out DIR] [--json]
// prints "RESUME LOOP: ..." and exits 1 below the bar (100% open, 0 invented facts, 100% page fit, 100% target carried).
// deno-lint-ignore-file no-explicit-any
import { CareerProfile, CareerTailor } from "../supabase/functions/_shared/router_core.career.js";
import { careerTools } from "../supabase/functions/_shared/agent/career_tools.ts";
import { confirmedOnly, edgeRenderer, memoryPersonaStore, memoryResumeStore } from "../supabase/functions/_shared/career_tailor.ts";
import { memoryVersionLog } from "../supabase/functions/_shared/career_resume_outcomes.ts";
import { TEMPLATES } from "../supabase/functions/_shared/career_resume_templates.ts";
import { type LoopProfile, PROFILES } from "../tests/architect/fixtures/resume-loop/profiles.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 9, 15);

// Words a resume may print that are not facts about the person: the section headings and labels the layouts write.
const LAYOUT_WORDS = new Set(["experience", "education", "projects", "project", "leadership", "skills", "certifications", "awards", "coursework", "summary",
  "research", "publications", "additional", "present", "professional", "technical", "work", "and", "selected", "core", "competencies", "profile"]);

export interface FileCheck { kind: "pdf" | "docx"; ok: boolean; pages: number; promised: number; pageFit: boolean; invented: string[]; targetCarried: boolean; targetMissing: string[]; chronological: boolean; error?: string }
export interface CaseResult { profile: string; shape: string; role: string; variant: string; made: boolean; refused?: string; files: FileCheck[]; template: string | null; listedOnly: string[] }

function profileOf(p: LoopProfile): any {
  const prof = CareerProfile.createProfile({ basics: { name: p.name, email: p.email, location: p.location } });
  const r = CareerProfile.ingestResume(prof, { text: p.text, fileName: `${p.id}-test-resume.txt` });
  if (!r.ok) throw new Error(`${p.id}: the resume text did not ingest: ${JSON.stringify(r).slice(0, 200)}`);
  for (const f of prof.facts) CareerProfile.confirmFact(prof, f.id);
  return prof;
}

// Everything the person confirmed, as one lowercase haystack: their facts (titles, texts, bullets, names, dates, any
// field) and the header they gave (name, email, city).
function confirmedHaystack(profile: any): string {
  const clean = confirmedOnly(profile);
  const parts: string[] = [JSON.stringify(clean.basics ?? {})];
  for (const f of clean.facts ?? []) parts.push(JSON.stringify(f));
  return parts.join(" \n ").toLowerCase().normalize("NFC");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The tokens that would be a fact if printed: numbers (with %, $ and separators), emails, links, and capitalised words.
export function factTokens(text: string): string[] {
  const t = text.normalize("NFC");
  const out = new Set<string>();
  for (const m of t.matchAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g)) out.add(m[0]);
  for (const m of t.matchAll(/\bhttps?:\/\/\S+/g)) out.add(m[0].replace(/[.,;)]+$/, ""));
  const noMail = t.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ").replace(/\bhttps?:\/\/\S+/g, " ");
  for (const m of noMail.matchAll(/(?<![\p{L}\p{N}])\$?\d[\d,.]*%?/gu)) { const n = m[0].replace(/[.,]+$/, ""); if (n && n !== "$") out.add(n); }
  for (const m of noMail.matchAll(/\p{Lu}[\p{L}\p{M}'’.-]*/gu)) { const w = m[0].replace(/[.'’-]+$/, ""); if (w.length > 1 || /\p{Lu}/u.test(w)) out.add(w); }
  return [...out];
}
export function inventedIn(text: string, haystack: string): string[] {
  const bad: string[] = [];
  for (const tok of factTokens(text)) {
    const low = tok.toLowerCase();
    if (LAYOUT_WORDS.has(low)) continue;
    if (low.length === 1) continue; // a lone initial or bullet glyph
    const digits = /\d/.test(low);
    // whole tokens only ("12" is not in "120", "Go" is not in "Google"); a number also matches with its separators dropped
    // ("50,000" vs "50000")
    const bounded = (needle: string, hay: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(needle)}($|[^\\p{L}\\p{N}])`, "u").test(hay);
    const found = bounded(low, haystack) || (digits && bounded(low.replace(/,/g, ""), haystack.replace(/(\d),(?=\d)/g, "$1")));
    if (!found) bad.push(tok);
  }
  return bad;
}

async function extract(paths: string[]): Promise<any[]> {
  const py = Deno.env.get("RESUME_LOOP_PYTHON") ?? "python3";
  const r = await new Deno.Command(py, { args: ["-I", `${ROOT}scripts/resume-loop-extract.py`, ...paths], stdout: "piped", stderr: "piped" }).output();
  const out = new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (out.length !== paths.length) throw new Error(`extractor returned ${out.length} of ${paths.length}: ${new TextDecoder().decode(r.stderr).slice(0, 400)}`);
  return out;
}

// The target is carried when the file holds what the posting asks for that the person's confirmed record proves: every skill
// the posting names that a confirmed experience, project or education fact shows (CareerProfile.skillEvidence) is printed.
// A skill the person only listed, with no fact showing it, is left off by the tailor's proof rule (123 skillFactProven,
// BUG-211); those are counted apart ("listed only"), not as a miss. A resume never prints the posting's title as theirs.
export function targetSkills(posting: string, profile: any): { proven: string[]; listedOnly: string[] } {
  const names = (CareerTailor as any).skillsInText(posting) as string[];
  const clean = confirmedOnly(profile), hay = confirmedHaystack(profile);
  const has = (sk: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(sk.toLowerCase())}($|[^\\p{L}\\p{N}])`, "u").test(hay);
  const proven = names.filter((sk) => (CareerProfile as any).skillEvidence(clean, sk).supportingFactIds.length > 0);
  return { proven, listedOnly: names.filter((sk) => !proven.includes(sk) && has(sk)) };
}
const MONTH_N: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Reverse chronological (RESUME-TEMPLATES E5): within the experience section, each entry's start is no later than the one
// above it. Reported, not a bar (the tailor may lead with the most relevant entry).
export function chronological(text: string): boolean {
  const low = text.toLowerCase(), at = low.search(/\bexperience\b/);
  if (at < 0) return true;
  const rest = low.slice(at + 10), end = rest.search(/\n(education|projects|skills|leadership|certifications|research|awards)\b/);
  const starts = [...(end >= 0 ? rest.slice(0, end) : rest).matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{4})\s*[-–—]/g)].map((m) => Number(m[2]) * 12 + MONTH_N[m[1]]);
  return starts.every((v, i) => i === 0 || v <= starts[i - 1]);
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const carried = (text: string, wanted: string[]) => { const w = ` ${words(text)} `, miss = wanted.filter((sk) => !w.includes(` ${words(sk)} `)); return { targetCarried: miss.length === 0, targetMissing: miss }; };
const words = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

// The variants a person meets: the default ("make me a resume for this one"), and a template they ask for by number (the
// recommended one for the role is what the rater would offer; T01 is the one-page student default).
const VARIANTS: { name: string; input: (posting: string) => Record<string, unknown> }[] = [
  { name: "default", input: (posting) => ({ posting_text: posting }) },
  { name: "template-1", input: (posting) => ({ posting_text: posting, layout: "template", template: "1" }) },
  { name: "template-4", input: (posting) => ({ posting_text: posting, layout: "template", template: "4" }) },
];

export async function runLoop(opts: { out?: string } = {}): Promise<{ cases: CaseResult[]; summary: Record<string, number>; line: string }> {
  const dir = opts.out ?? await Deno.makeTempDir({ prefix: "resume-loop-" });
  await Deno.mkdir(dir, { recursive: true });
  const cases: CaseResult[] = [];
  for (const p of PROFILES) {
    const haystack = confirmedHaystack(profileOf(p));
    for (const target of p.targets) {
      const { proven: wanted, listedOnly } = targetSkills(target.posting, profileOf(p));
      for (const v of VARIANTS) {
        const delivered: { format: string; filename: string; base64: string }[] = [];
        const tools = Object.fromEntries(careerTools({
          postings: async () => [],
          tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: memoryResumeStore(), render: edgeRenderer(), versions: memoryVersionLog(), upload: async () => null, ownDocx: async () => null, deliver: (d) => { delivered.push(d); } },
        }).map((x: any) => [x.name, x]));
        const ctx = { userId: `00000000-0000-4000-8000-${p.id.padStart(12, "0")}`, threadId: `t-${p.id}`, now: NOW, state: { profile: profileOf(p) } as Record<string, any>, turn: { message: `make me a resume for the ${target.role} role`, added: [] as string[] } };
        const c: CaseResult = { profile: p.id, shape: p.shape, role: target.role, variant: v.name, made: false, files: [], template: null, listedOnly };
        try {
          const r = await tools.tailor_resume.run(v.input(target.posting), ctx) as any;
          c.made = true;
          c.template = r?.template ?? null;
        } catch (e) {
          c.refused = String((e as Error)?.message ?? e).slice(0, 240);
        }
        const promised = c.template && (TEMPLATES as any)[c.template] ? (TEMPLATES as any)[c.template].pages : 1;
        const paths: string[] = [];
        for (const d of delivered) {
          const path = `${dir}/${p.id}-${target.role.replace(/\W+/g, "_")}-${v.name}.${d.format}`;
          await Deno.writeFile(path, unb64(d.base64));
          paths.push(path);
        }
        const opened = paths.length ? await extract(paths) : [];
        for (const f of opened) {
          const text = String(f.text ?? "");
          const inv = f.ok ? [...new Set([...inventedIn(text, haystack), ...(f.text_pdfminer ? inventedIn(String(f.text_pdfminer), haystack) : [])])] : [];
          c.files.push({ kind: f.kind, ok: !!f.ok, pages: Number(f.pages ?? 0), promised, pageFit: !!f.ok && Number(f.pages) >= 1 && Number(f.pages) <= promised, invented: inv, ...carried(text, wanted), chronological: chronological(text), ...(f.error ? { error: f.error } : {}) });
        }
        // A made resume must come as both files (spec RESUME-TEMPLATES 1.1: "Trainee keeps sending both").
        if (c.made) for (const k of ["pdf", "docx"] as const) if (!c.files.some((f) => f.kind === k)) c.files.push({ kind: k, ok: false, pages: 0, promised, pageFit: false, invented: [], targetCarried: false, targetMissing: wanted, chronological: false, error: `no ${k.toUpperCase()} was delivered` });
        cases.push(c);
      }
    }
  }
  const files = cases.flatMap((c) => c.files);
  const summary = {
    profiles: PROFILES.length, targets: PROFILES.reduce((n, p) => n + p.targets.length, 0), cases: cases.length,
    made: cases.filter((c) => c.made).length, files: files.length,
    opened: files.filter((f) => f.ok).length, invented: files.reduce((n, f) => n + f.invented.length, 0),
    pageFit: files.filter((f) => f.pageFit).length, targetCarried: files.filter((f) => f.targetCarried).length,
    chronological: files.filter((f) => f.chronological).length,
    listedOnly: cases.filter((c) => c.variant === VARIANTS[0].name).reduce((n, c) => n + c.listedOnly.length, 0),
  };
  const line = `RESUME LOOP: made ${summary.made}/${summary.cases} (${summary.profiles} profiles x ${summary.targets / summary.profiles} roles x ${VARIANTS.length} layouts), opened ${summary.opened}/${summary.files}, invented facts ${summary.invented}, page fit ${summary.pageFit}/${summary.files}, target carried ${summary.targetCarried}/${summary.files}; reported (no bar): reverse chronological ${summary.chronological}/${summary.files}, posting skills listed but not shown by any fact (left off) ${summary.listedOnly}`;
  return { cases, summary, line };
}

if (import.meta.main) {
  const outAt = Deno.args.indexOf("--out");
  const r = await runLoop({ out: outAt >= 0 ? Deno.args[outAt + 1] : undefined });
  if (Deno.args.includes("--json")) console.log(JSON.stringify(r.cases, null, 1));
  else for (const c of r.cases) for (const f of c.files) if (!f.ok || f.invented.length || !f.pageFit || !f.targetCarried || !f.chronological) console.log(`${c.profile} ${c.role} ${c.variant} ${f.kind}: ${[!f.ok && `not open (${f.error})`, f.invented.length && `invented ${f.invented.join(", ")}`, !f.pageFit && `pages ${f.pages}/${f.promised}`, !f.targetCarried && `target not carried (missing ${f.targetMissing.join(", ")})`, !f.chronological && "not reverse chronological (reported)"].filter(Boolean).join("; ")}`);
  for (const c of r.cases) if (!c.made) console.log(`${c.profile} ${c.role} ${c.variant}: not made: ${c.refused}`);
  console.log(r.line);
  const s = r.summary;
  Deno.exit(s.made === s.cases && s.opened === s.files && s.invented === 0 && s.pageFit === s.files && s.targetCarried === s.files ? 0 : 1);
}
