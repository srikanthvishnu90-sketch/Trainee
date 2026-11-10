// RESUME DESIGN LOOP (r-resume-design, 2026-11-10; release item 3, docs/architect/VERIFICATION-15.md). The resume loop
// (scripts/resume-loop.ts, #670) proves every file opens and invents nothing. This measures how each one LOOKS: every case
// of the loop is printed to PNG (poppler, 100 dpi), the Word copy is printed by LibreOffice the way a reader opens it, and
// each of the 162 files is checked against APP-LAYER-15-FIXES A.4 (the comparator render) and E.1 (one page, readable
// type, no clipped bullets), and RESUME-TEMPLATES E5 (body 10-12 pt, reverse chronological, consistent formatting):
//
//   one page     pages <= what the layout promises (1 unless the template says 2)
//   identity     the name is the first line, the largest type on the page (>= 14 pt), within the top 1.5 in; the email
//                within the top 2 in
//   target       the first line that shows a skill the posting asks for and the person's confirmed record holds sits in
//                the top half of page 1 (an entry or project line first; the Skills line only when no entry shows one).
//                With no posting skill on the record at all, the first entry stands in (counted apart)
//   readable     body type (the most used glyph size) >= 10 pt, and no glyph under 8 pt
//   no overflow  ink >= 0.4 in from every paper edge, no text line past the right margin, no text drawn over text
//   dates        one month style (full or short, never both), one range dash, and every right-aligned date ends at
//                the same x (within 1.5 pt)
//   chronology   every dated section lists its entries newest first (by start date)
//   ATS order    the text a parser reads (PDF: pdfminer and PDFium; DOCX: its paragraphs in order) is the page's
//                visual order, word for word. Reported apart (coordinator ruling 2026-11-10): the DOCX in entry order,
//                poppler's layout mode, and poppler's default mode, which orders by geometry alone and reads a
//                flush-right date after its entry's bullets or its section, whatever the file holds
//   DOCX = PDF   the Word copy prints the same pages, the same words in the same order, the name and body within 1 pt,
//                every heading within 18 pt of its place in the PDF
//
//   deno run -A --no-check scripts/resume-design-loop.ts [--out DIR] [--json]
// prints "RESUME DESIGN: ..." and exits 1 below the bar (every check 162/162). Offline, free: no model, no network.
// Needs poppler-utils, LibreOffice (soffice), python3 with pdfminer.six and Pillow.
// deno-lint-ignore-file no-explicit-any
import { chronological, runLoop, targetSkills } from "./resume-loop.ts";
import { PROFILES } from "../tests/architect/fixtures/resume-loop/profiles.ts";
import { CareerProfile } from "../supabase/functions/_shared/router_core.career.js";

const ROOT = new URL("..", import.meta.url).pathname;
export const CHECKS = ["onePage", "identity", "target", "readable", "noOverflow", "dates", "chronology", "atsOrder", "docxLikePdf"] as const;
export type Check = typeof CHECKS[number];
export interface DesignFile { id: string; profile: string; role: string; variant: string; kind: "pdf" | "docx"; png: string; checks: Record<Check, boolean>; notes: string[]; targetNA: boolean; popplerOrder: boolean; layoutOrder: boolean; docxEntryOrder: boolean }

const words = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[•·▪●◆♦]/g, " ").replace(/[^\p{L}\p{N}@.+%$-]+/gu, " ").replace(/\s+/g, " ").trim();
const MONTHS_FULL = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
const MONTHS_SHORT = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?(?=\s+\d{4})/;
const DATE_ONLY = /^(?:(?:[A-Z][a-z]{2,8}\.? )?\d{4})(?:\s*[–—-]\s*(?:(?:[A-Z][a-z]{2,8}\.? )?\d{4}|Present))?$/;

function mode(xs: number[]): number {
  const c = new Map<number, number>();
  for (const x of xs) c.set(Math.round(x * 2) / 2, (c.get(Math.round(x * 2) / 2) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}
const visual = (lines: any[]) => [...lines].sort((a, b) => a.page - b.page || (Math.abs(a.top - b.top) < 3 ? a.x0 - b.x0 : a.top - b.top));
const isHeading = (l: any) => /^[A-Z][A-Za-z &/]+$/.test(l.text) && l.text.length < 40 && l.bold > 0.9 && !DATE_ONLY.test(l.text) && l.text.split(" ").length <= 4;

export function checkOne(m: any, twin: any, ctx0: { promised: number; name: string; email: string; proven: string[]; listed: string[] }): { checks: Record<Check, boolean>; notes: string[]; targetNA: boolean; popplerOrder: boolean; layoutOrder: boolean; docxEntryOrder: boolean } {
  const notes: string[] = [];
  const lines = visual(m.lines);
  // Placement, not selection: a skill the person only listed counts when this file prints it (whether it must is the
  // resume loop's listed-skills check, #673); a skill a confirmed fact proves always counts.
  const all = ` ${words(lines.map((l: any) => l.text).join(" "))} `;
  const wanted = [...ctx0.proven, ...ctx0.listed.filter((sk) => all.includes(` ${words(sk)} `))];
  const ctx = { ...ctx0, wanted };
  const pageH = m.pages[0]?.h ?? 792, pageW = m.pages[0]?.w ?? 612;
  const sizes = lines.flatMap((l: any) => Array(Math.max(1, l.text.length)).fill(l.min));
  const body = mode(sizes), smallest = Math.min(...lines.map((l: any) => l.min));
  const biggest = Math.max(...lines.map((l: any) => l.size));

  const onePage = m.pages.length >= 1 && m.pages.length <= ctx.promised;
  if (!onePage) notes.push(`pages ${m.pages.length}/${ctx.promised}`);

  const first = lines[0], emailLine = lines.find((l: any) => l.text.includes(ctx.email));
  const identity = !!first && words(first.text) === words(ctx.name) && first.size >= biggest - 0.01 && first.size >= 14 && first.top <= 108 && !!emailLine && emailLine.page === 1 && emailLine.bottom <= 144;
  if (!identity) notes.push(`identity: first "${first?.text}" ${first?.size}pt at ${first?.top}pt; email ${emailLine ? `at ${emailLine.bottom}pt` : "missing"}`);

  // The skills section is the one headed Skills (or Technical Skills): a skill named only there is not a shown project.
  let section = "", targetLine: any = null, skillsLine: any = null;
  const has = (t: string, sk: string) => ` ${words(t)} `.includes(` ${words(sk)} `);
  for (const l of lines) {
    if (isHeading(l)) { section = l.text.toLowerCase(); continue; }
    if (l === first || l === emailLine) continue;
    if (!ctx.wanted.some((sk) => has(l.text, sk))) continue;
    if (/skill|competenc/.test(section)) { skillsLine ??= l; continue; }
    targetLine ??= l;
  }
  // No posting skill on the person's record at all: the first entry (their most relevant or most recent role) stands in.
  const targetNA = ctx.wanted.length === 0;
  const firstEntry = lines.find((l: any, i: number) => i > 0 && l !== emailLine && !isHeading(l) && l.bold0);
  const shown = targetNA ? firstEntry : targetLine ?? skillsLine;
  const target = (!!shown && shown.page === 1 && shown.top <= pageH / 2);
  if (!target) notes.push(`target: ${shown ? `first at ${shown.top}pt p${shown.page} "${shown.text.slice(0, 50)}"` : `none of ${ctx.wanted.join(", ")} shown`}`);

  const readable = body >= 10 && smallest >= 8;
  if (!readable) notes.push(`type: body ${body}pt, smallest ${smallest}pt`);

  const M = 28.8;
  const inkOk = m.ink.every((p: any) => !p.empty && !p.edge && p.left >= M && p.right >= M && p.top >= M && p.bottom >= M);
  const pastMargin = lines.filter((l: any) => l.x1 > pageW - M || l.x0 < M);
  const noOverflow = inkOk && !pastMargin.length && m.overlaps === 0;
  if (!noOverflow) notes.push(`overflow: ink ${JSON.stringify(m.ink.map((p: any) => [p.left, p.top, p.right, p.bottom]))}, past margin ${pastMargin.length}, overlaps ${m.overlaps}`);

  const text = lines.map((l: any) => l.text).join("\n");
  const full = MONTHS_FULL.test(text), short = MONTHS_SHORT.test(text);
  const dashes = new Set([...text.matchAll(/(?:\d{4})\s*([–—-])\s*(?:[A-Z][a-z]+\.? )?(?:\d{4}|Present)/g)].map((x) => x[1]));
  const right = lines.filter((l: any) => DATE_ONLY.test(l.text));
  const rx = right.map((l: any) => l.x1);
  const aligned = !rx.length || Math.max(...rx) - Math.min(...rx) <= 1.5;
  const dates = !(full && short) && dashes.size <= 1 && aligned;
  if (!dates) notes.push(`dates: full ${full} short ${short} dashes ${[...dashes].join("")} right-edges ${rx.join(",")}`);

  const chronology = chronological(m.text_poppler);
  if (!chronology) notes.push("not reverse chronological");

  const seen = words(lines.map((l: any) => l.text).join(" "));
  // A PDF is read by text extraction (poppler, pdfminer); a Word file by its paragraphs in document order.
  const reads: [string, string][] = m.text_xml !== undefined ? [["docx paragraphs", m.text_xml]] : [["pdfminer", m.text_pdfminer], ["pdfium", m.text_pdfium ?? ""]];
  const atsOrder = reads.every(([, t]) => words(t) === seen);
  if (!atsOrder) notes.push(`ATS order: ${reads.map(([k, t]) => `${k} ${words(t) === seen ? "=" : "≠"}`).join(", ")} visual`);
  // Reported, not a bar (coordinator ruling 2026-11-10: flush-right dates stay, A.4): poppler's default pdftotext mode
  // finds columns by geometry alone, so a flush-right date column is read after its section whatever the file holds; only inline dates pass it.
  const popplerOrder = m.text_xml !== undefined || words(m.text_poppler) === seen;
  // Reported (coordinator ruling 2026-11-10): poppler's layout mode, and the Word copy's own paragraph order (each entry's
  // title, then its dates, then its bullets: the logical order an ATS reading the DOCX gets), for the case of this file.
  const layoutOrder = m.text_xml !== undefined || words(m.text_poppler_layout ?? "") === seen;
  const docxXml = m.text_xml ?? twin?.text_xml;
  const docxEntryOrder = docxXml !== undefined && words(docxXml) === words(visual(m.text_xml !== undefined ? m.lines : twin.lines).map((l: any) => l.text).join(" "));

  let docxLikePdf = false;
  if (twin) {
    const tl = visual(twin.lines);
    const tBody = mode(tl.flatMap((l: any) => Array(Math.max(1, l.text.length)).fill(l.min)));
    const tName = tl[0]?.size ?? 0;
    const sameWords = words(tl.map((l: any) => l.text).join(" ")) === seen;
    const heads = lines.slice(1).filter(isHeading), theads = tl.slice(1).filter(isHeading);
    const headsOk = heads.length === theads.length && heads.every((h: any, i: number) => words(h.text) === words(theads[i].text) && h.page === theads[i].page && Math.abs(h.top - theads[i].top) <= 18);
    docxLikePdf = twin.pages.length === m.pages.length && sameWords && Math.abs(tName - (first?.size ?? 0)) <= 1 && Math.abs(tBody - body) <= 1 && headsOk;
    if (!docxLikePdf) notes.push(`docx vs pdf: pages ${twin.pages.length}/${m.pages.length}, words ${sameWords ? "=" : "≠"}, name ${tName}/${first?.size}, body ${tBody}/${body}, headings ${headsOk ? "ok" : `${JSON.stringify(theads.map((h: any) => [h.text, h.top]))} vs ${JSON.stringify(heads.map((h: any) => [h.text, h.top]))}`}`);
  } else notes.push("docx vs pdf: no twin");
  return { checks: { onePage, identity, target, readable, noOverflow, dates, chronology, atsOrder, docxLikePdf }, notes, targetNA, popplerOrder, layoutOrder, docxEntryOrder };
}

async function soffice(dir: string, docx: string[]): Promise<void> {
  const out = `${dir}/docx-pdf`;
  await Deno.mkdir(out, { recursive: true });
  const r = await new Deno.Command(Deno.env.get("SOFFICE") ?? "soffice", { args: [`-env:UserInstallation=file://${dir}/lo-profile`, "--headless", "--convert-to", "pdf", "--outdir", out, ...docx], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(`soffice: ${new TextDecoder().decode(r.stderr).slice(0, 300)}`);
}

export async function runDesign(opts: { out?: string } = {}) {
  const dir = opts.out ?? await Deno.makeTempDir({ prefix: "resume-design-" });
  const files = `${dir}/files`;
  const loop = await runLoop({ out: files });
  const stem = (c: any) => `${c.profile}-${c.role.replace(/\W+/g, "_")}-${c.variant}`;
  const cases = loop.cases.filter((c) => c.made);
  await soffice(dir, cases.map((c) => `${files}/${stem(c)}.docx`));
  const manifest = cases.map((c) => ({ id: stem(c), pdf: `${files}/${stem(c)}.pdf`, docx: `${files}/${stem(c)}.docx`, docx_pdf: `${dir}/docx-pdf/${stem(c)}.pdf`, png_dir: `${dir}/png/${stem(c)}` }));
  const py = Deno.env.get("RESUME_LOOP_PYTHON") ?? "python3";
  const child = new Deno.Command(py, { args: ["-I", `${ROOT}scripts/resume-design-measure.py`], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(manifest)));
  await w.close();
  const res = await child.output();
  const rows = new TextDecoder().decode(res.stdout).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (rows.length !== manifest.length) throw new Error(`measure returned ${rows.length} of ${manifest.length}: ${new TextDecoder().decode(res.stderr).slice(-600)}`);
  const byId = new Map(rows.map((r: any) => [r.id, r]));
  const out: DesignFile[] = [];
  for (const c of loop.cases) {
    const p = PROFILES.find((x) => x.id === c.profile)!;
    const prof = CareerProfile.createProfile({ basics: { name: p.name, email: p.email, location: p.location } });
    CareerProfile.ingestResume(prof, { text: p.text, fileName: `${p.id}-test-resume.txt` });
    for (const f of prof.facts as any[]) CareerProfile.confirmFact(prof, f.id);
    const ts = targetSkills(p.targets.find((t) => t.role === c.role)!.posting, prof);
    const promised = c.files[0]?.promised ?? 1;
    const row: any = byId.get(stem(c));
    for (const kind of ["pdf", "docx"] as const) {
      const base = { id: stem(c), profile: c.profile, role: c.role, variant: c.variant, kind, png: `${dir}/png/${stem(c)}/${kind}-1.png` };
      const m = row?.[kind], twin = row?.[kind === "pdf" ? "docx" : "pdf"];
      if (!c.made || !row || row.error || !m) {
        out.push({ ...base, checks: Object.fromEntries(CHECKS.map((k) => [k, false])) as Record<Check, boolean>, notes: [c.refused ?? row?.error ?? `no ${kind}`], targetNA: false, popplerOrder: false, layoutOrder: false, docxEntryOrder: false });
        continue;
      }
      out.push({ ...base, ...checkOne(m, twin, { promised, name: p.name, email: p.email, proven: ts.proven, listed: ts.listedOnly }) });
    }
  }
  const tally = Object.fromEntries(CHECKS.map((k) => [k, out.filter((f) => f.checks[k]).length])) as Record<Check, number>;
  const na = out.filter((f) => f.targetNA).length, pop = out.filter((f) => f.popplerOrder).length, lay = out.filter((f) => f.layoutOrder).length, dxo = out.filter((f) => f.docxEntryOrder).length;
  const line = `RESUME DESIGN: ${out.length} files (${loop.summary.cases} cases x PDF + DOCX); ${CHECKS.map((k) => `${k} ${tally[k]}/${out.length}`).join(", ")}; target by first entry (no posting skill on the record) ${na}; reported (no bar): DOCX reads in entry order ${dxo}/${out.length}, poppler layout-mode order ${lay}/${out.length}, poppler default-mode order ${pop}/${out.length}`;
  return { files: out, tally, line, dir };
}

if (import.meta.main) {
  const outAt = Deno.args.indexOf("--out");
  const r = await runDesign({ out: outAt >= 0 ? Deno.args[outAt + 1] : undefined });
  if (Deno.args.includes("--json")) console.log(JSON.stringify(r.files, null, 1));
  else for (const f of r.files) if (CHECKS.some((k) => !f.checks[k])) console.log(`${f.id} ${f.kind}: ${CHECKS.filter((k) => !f.checks[k]).join(", ")} | ${f.notes.join("; ")}`);
  console.log(`PNGs: ${r.dir}/png`);
  console.log(r.line);
  Deno.exit(CHECKS.every((k) => r.tally[k] === r.files.length) ? 0 : 1);
}
