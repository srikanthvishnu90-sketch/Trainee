// REAL SET, item 3 (resumes; VERIFICATION-15 "The 95% bars", D-068). The 35 real public postings recorded by
// evals/real-sets/postings/capture.ts x the fictional persona Alex Testcase (TEST; packages/career-data/fixtures/test-resume.txt,
// every fact confirmed), each resume made through the real tailor path: the brain's tailor_resume tool (agent/career_tools.ts)
// called with the posting's job_id, the posting served by the store the way handler-career.ts serves postingsDb.get, the PDF
// and the Word copy handed over through `deliver` exactly as a reply attaches them. No model: the tailor is code (the model
// only chooses to call the tool, so the scripted part is that call). No network.
//
// Every delivered file is checked the way the person meets it:
//   opens        the PDF parses (poppler pdfinfo + pdftotext, and pdfminer.six independently); the DOCX unzips, its XML reads and
//                python-docx opens it (scripts/resume-loop-extract.py, the resume loop's extractor)
//   copies       the text a reader copies out holds the person's name and email, in every parser (pdftotext, pdfminer, DOCX
//                paragraphs), with no unmapped glyph ("(cid:", U+FFFD)
//   downloads    the attachment is a file a phone saves and opens: base64 decodes; magic bytes (%PDF-, PK); the PDF's sha256 is
//                the one the tool reported; the filename ends .pdf / .docx, has no path separator, is at most 150 characters;
//                the MIME type is the format's
//   pages        the page count is within what the layout promises
//   target       the resume is for THIS posting: the tool's job_id is the posting's, and every skill the posting names
//                (CareerTailor.skillsInText) that the person's confirmed record states as a whole word is printed. The resume
//                loop's rule (scripts/resume-loop.ts targetSkills, which trusts CareerProfile.skillEvidence) is run too and
//                reported as `loop_rule`: on real postings skillEvidence calls "R" proven by any fact with the letter r in it and
//                "SQL" proven by "PostgreSQL" (a product finding, README), so that rule asks the file to print skills the person
//                never stated. Printing them would be inventing; it is reported, not the bar.
//   invented     no name, number, date, employer, school, email or link on the file that is not on the confirmed record
//                (scripts/resume-loop.ts inventedIn, the materials truth guard's token rule), in all three texts
// A posting passes when both files pass every check. Bar (D-056 reading): >= 95% of postings by exact count, invented 0.
//
//   CI=true deno run -A --no-check evals/real-sets/resumes/run.ts [--out DIR]
// deno-lint-ignore-file no-explicit-any require-await
import { CareerProfile, CareerTailor } from "../../../supabase/functions/_shared/router_core.career.js";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";
import { confirmedOnly, edgeRenderer, memoryPersonaStore, memoryResumeStore } from "../../../supabase/functions/_shared/career_tailor.ts";
import { memoryVersionLog } from "../../../supabase/functions/_shared/career_resume_outcomes.ts";
import { TEMPLATES } from "../../../supabase/functions/_shared/career_resume_templates.ts";
import { inventedIn, listedSkills, targetSkills } from "../../../scripts/resume-loop.ts";
import { loadPostings, type PostingRow } from "../postings/postings.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 12, 15);
export const PERSONA = { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test", location: "Chicago, IL (TEST)", file: "packages/career-data/fixtures/test-resume.txt" };
export const CHECKS = ["opens", "copies", "downloads", "pages", "target", "invented"] as const;
type Check = typeof CHECKS[number];

async function profile(): Promise<any> {
  const text = await Deno.readTextFile(`${ROOT}${PERSONA.file}`);
  const prof = CareerProfile.createProfile({ basics: { name: PERSONA.name, email: PERSONA.email, location: PERSONA.location } });
  const r = CareerProfile.ingestResume(prof, { text, fileName: "alex-testcase-test-resume.txt" });
  if (!r.ok) throw new Error(`the persona's resume did not ingest: ${JSON.stringify(r).slice(0, 200)}`);
  for (const f of (prof as any).facts) CareerProfile.confirmFact(prof, f.id);
  return prof;
}
function haystack(p: any): string {
  const c = confirmedOnly(p);
  return [JSON.stringify(c.basics ?? {}), ...(c.facts ?? []).map((f: any) => JSON.stringify(f))].join(" \n ").toLowerCase().normalize("NFC");
}
async function extract(paths: string[]): Promise<any[]> {
  const r = await new Deno.Command("python3", { args: ["-I", `${ROOT}scripts/resume-loop-extract.py`, ...paths], stdout: "piped", stderr: "piped" }).output();
  const out = new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (out.length !== paths.length) throw new Error(`extractor returned ${out.length} of ${paths.length}: ${new TextDecoder().decode(r.stderr).slice(0, 400)}`);
  return out;
}
const words = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
const has = (text: string, phrase: string) => ` ${words(text)} `.includes(` ${words(phrase)} `);
const sha = async (b: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

export interface FileResult { kind: "pdf" | "docx"; filename: string; checks: Record<Check, boolean>; notes: string[]; pages: number; invented: string[] }
export interface CaseResult { job_id: string; company: string; title: string; provider: string; made: boolean; refused?: string; wanted: string[]; loopWanted: string[]; loopMissing: string[]; files: FileResult[]; pass: boolean }

export async function runResumes(o: { out?: string } = {}) {
  const dir = o.out ?? await Deno.makeTempDir({ prefix: "real-resumes-" });
  await Deno.mkdir(dir, { recursive: true });
  const postings = await loadPostings();
  const prof0 = await profile(), hay = haystack(prof0), listed = listedSkills(prof0);
  const cases: CaseResult[] = [];
  for (const row of postings) {
    const store = new Map<string, PostingRow>([[row.job_id, row]]);
    const delivered: any[] = [];
    const tools = Object.fromEntries(careerTools({
      postings: async () => [],
      tailor: { posting: async (id: string) => { const p = store.get(id); return p ? { job_id: p.job_id, title: p.title, company: p.company, description: p.description } : null; },
        personas: memoryPersonaStore(), resumes: memoryResumeStore(), render: edgeRenderer(), versions: memoryVersionLog(), upload: async () => null, ownDocx: async () => null,
        deliver: (d: any) => { delivered.push(d); } },
    } as any).map((x: any) => [x.name, x]));
    const ctx = { userId: "00000000-0000-4000-8000-00000000a1e7", threadId: "t-real-resumes", now: NOW, state: { profile: await profile() } as Record<string, any>,
      turn: { message: `make me a resume for the ${row.title} role at ${row.company}`, added: [] as string[] } };
    const posting = `${row.title} at ${row.company}\n\n${row.description}`;
    const { proven, listedOnly } = targetSkills(posting, prof0);
    const loopWanted = [...proven, ...listedOnly];
    const wanted = ((CareerTailor as any).skillsInText(posting) as string[]).filter((sk) => new RegExp(`(^|[^\\p{L}\\p{N}])${sk.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(hay));
    const c: CaseResult = { job_id: row.job_id, company: row.company, title: row.title, provider: row.provider, made: false, wanted, loopWanted, loopMissing: [], files: [], pass: false };
    let r: any = null;
    try { r = await tools.tailor_resume.run({ job_id: row.job_id }, ctx); c.made = true; }
    catch (e) { c.refused = String((e as Error)?.message ?? e).slice(0, 300); }
    const promised = r?.template && (TEMPLATES as any)[r.template] ? (TEMPLATES as any)[r.template].pages : 1;
    const paths: string[] = [];
    for (const d of delivered) {
      const p = `${dir}/${row.job_id.replace(/[^\w-]+/g, "_")}.${d.format}`;
      await Deno.writeFile(p, Uint8Array.from(atob(d.base64), (ch) => ch.charCodeAt(0)));
      paths.push(p);
    }
    const opened = paths.length ? await extract(paths) : [];
    for (let i = 0; i < delivered.length; i++) {
      const d = delivered[i], f = opened[i], notes: string[] = [];
      const bytes = Uint8Array.from(atob(d.base64), (ch) => ch.charCodeAt(0));
      const kind = d.format as "pdf" | "docx";
      const texts = [String(f.text ?? ""), ...(kind === "pdf" && f.text_pdfminer != null ? [String(f.text_pdfminer)] : [])];
      const opens = !!f.ok;
      if (!opens) notes.push(`does not open: ${f.error}`);
      const glyphs = texts.some((t) => /\(cid:\d+\)|�/.test(t));
      const copies = opens && !glyphs && texts.every((t) => has(t, "Alex Testcase") && t.includes(PERSONA.email));
      if (opens && !copies) notes.push(glyphs ? "unmapped glyphs in the copied text" : "the copied text lacks the name or the email");
      const magic = kind === "pdf" ? new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-" : bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
      const shaOk = kind === "pdf" ? (await sha(bytes)) === d.sha256 && d.sha256 === r?.sha256 : true;
      const nameOk = new RegExp(`\\.${kind}$`, "i").test(d.filename) && !/[\\/]/.test(d.filename) && d.filename.length <= 150;
      const downloads = magic && shaOk && nameOk && d.mime === MIME[kind] && bytes.length > 0;
      if (!downloads) notes.push(`download: magic ${magic}, sha256 ${shaOk}, filename ${nameOk} (${d.filename}), mime ${d.mime}`);
      const pagesOk = opens && Number(f.pages) >= 1 && Number(f.pages) <= promised;
      if (!pagesOk) notes.push(`pages ${f.pages} of ${promised}`);
      const missing = wanted.filter((sk) => !texts.every((t) => has(t, sk)));
      for (const sk of loopWanted) if (!texts.every((t) => has(t, sk)) && !c.loopMissing.includes(sk)) c.loopMissing.push(sk);
      const target = c.made && r?.job_id === row.job_id && missing.length === 0;
      if (!target) notes.push(r?.job_id !== row.job_id ? `job_id ${r?.job_id} is not the posting's` : `target skills not printed: ${missing.join(", ")}`);
      const inv = opens ? [...new Set(texts.flatMap((t) => inventedIn(t, hay)))] : [];
      if (inv.length) notes.push(`invented: ${inv.join(", ")}`);
      c.files.push({ kind, filename: d.filename, pages: Number(f.pages ?? 0), invented: inv, notes,
        checks: { opens, copies, downloads, pages: pagesOk, target, invented: opens && inv.length === 0 } });
    }
    // A made resume comes as both files (RESUME-TEMPLATES 1.1); a missing one fails every check.
    for (const k of ["pdf", "docx"] as const) if (!c.files.some((f) => f.kind === k)) c.files.push({ kind: k, filename: "", pages: 0, invented: [], notes: [`no ${k.toUpperCase()} was delivered`], checks: Object.fromEntries(CHECKS.map((x) => [x, false])) as Record<Check, boolean> });
    c.pass = c.made && c.files.every((f) => CHECKS.every((k) => f.checks[k]));
    cases.push(c);
  }
  const files = cases.flatMap((c) => c.files);
  const per = Object.fromEntries(CHECKS.map((k) => [k, files.filter((f) => f.checks[k]).length]));
  const invented = files.reduce((n, f) => n + f.invented.length, 0);
  const pass = cases.filter((c) => c.pass).length, n = cases.length;
  const bar = Math.ceil(n * 0.95);
  const line = `REAL-SET RESUMES: postings ${n} (${[...new Set(cases.map((c) => c.provider))].map((p) => `${p} ${cases.filter((c) => c.provider === p).length}`).join(", ")}) x persona Alex Testcase (TEST); made ${cases.filter((c) => c.made).length}/${n}; files ${files.length}: ${CHECKS.map((k) => `${k} ${per[k]}/${files.length}`).join(", ")}; invented facts ${invented}; postings with a confirmed skill to carry ${cases.filter((c) => c.wanted.length).length}/${n}; PASS ${pass}/${n} (bar ${bar}/${n}, invented 0) ${pass >= bar && invented === 0 ? "MEETS" : "BELOW"}; reported: loop_rule (skillEvidence) target met ${cases.filter((c) => c.made && !c.loopMissing.length).length}/${n}, its unprinted skills ${[...new Set(cases.flatMap((c) => c.loopMissing))].join(", ") || "none"}`;
  return { cases, line, pass, n, bar, invented, listed };
}

if (import.meta.main) {
  const at = Deno.args.indexOf("--out");
  const r = await runResumes({ out: at >= 0 ? Deno.args[at + 1] : undefined });
  for (const c of r.cases) if (!c.pass) console.log(`FAIL ${c.job_id} (${c.title}): ${c.refused ? `not made: ${c.refused}` : c.files.flatMap((f) => f.notes.map((x) => `${f.kind}: ${x}`)).join("; ")}`);
  const res = `${HERE}results`;
  await Deno.mkdir(res, { recursive: true });
  const sha8 = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "--short=8", "HEAD"], cwd: ROOT, stdout: "piped" }).output()).stdout).trim();
  await Deno.writeTextFile(`${res}/latest.json`, JSON.stringify({ at: new Date().toISOString(), base: sha8, line: r.line, cases: r.cases.map((c) => ({ ...c, files: c.files.map((f) => ({ kind: f.kind, filename: f.filename, pages: f.pages, checks: f.checks, notes: f.notes })) })) }, null, 1) + "\n");
  console.log(r.line);
  Deno.exit(r.pass >= r.bar && r.invented === 0 ? 0 : 1);
}
