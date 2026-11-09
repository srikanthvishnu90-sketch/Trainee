// RELEASE 10: the template gallery, for visual regression. Renders two fixed corpus resumes (a student, C01, and a two-page
// senior, C05) in each of the fifteen templates, plus the Trainee-branded variant of three, and rasterizes every page at
// 144 dpi (twice the PDF's 72 points per inch: the deviceScaleFactor-2 screenshot of the page) with poppler's pdftoppm.
// Writes tests/architect/snapshots/resume-templates/<id>-<sample>[-branded]-p<n>.png and manifest.json, which holds each
// file's PDF sha256 (the renderer is deterministic, so a changed hash is a changed layout) and each PNG's sha256.
//   deno run -A scripts/resume-template-gallery.ts            write the gallery
//   deno run -A scripts/resume-template-gallery.ts --check    re-render; fail on any PDF hash change, and (with pdftoppm)
//                                                            on any page whose pixels differ from the committed PNG
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerRender } from "../supabase/functions/_shared/router_core.career.js";
import { type LibraryId, renderTemplate, TEMPLATE_IDS } from "../supabase/functions/_shared/career_resume_templates.ts";
import { corpus } from "../tests/helpers/resume_corpus.ts";

export const GALLERY = new URL("../tests/architect/snapshots/resume-templates/", import.meta.url);
export const SAMPLES = ["C01", "C05"] as const;
export const BRANDED: LibraryId[] = ["T01", "T03", "T11"];
const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

export function galleryPdfs(): { key: string; pdf: Uint8Array; pages: number }[] {
  const items = corpus().filter((c) => (SAMPLES as readonly string[]).includes(c.id));
  const out: { key: string; pdf: Uint8Array; pages: number }[] = [];
  for (const c of items) for (const id of TEMPLATE_IDS) for (const branded of [false, true]) {
    if (branded && !BRANDED.includes(id)) continue;
    const r = renderTemplate(R, c.doc, { template: id, branded });
    if (!r.ok) throw new Error(`${id}/${c.id}: ${r.reason}`);
    out.push({ key: `${id}-${c.id}${branded ? "-branded" : ""}`, pdf: r.pdf, pages: r.fit.pages });
  }
  return out;
}

async function raster(pdf: Uint8Array, dir: string, key: string): Promise<string[] | null> {
  const src = `${dir}/${key}.pdf`;
  await Deno.writeFile(src, pdf);
  // Neutral templates are ink only: rasterized in gray. Branded ones keep their colour (the plum must show).
  const run = await new Deno.Command("pdftoppm", { args: ["-r", "144", "-png", ...(key.endsWith("-branded") ? [] : ["-gray"]), src, `${dir}/${key}-p`], stdout: "null", stderr: "piped" }).output().catch(() => null);
  if (!run?.success) return null;
  // 16 levels per page (PIL, where installed): text keeps its edges at a tenth of the bytes.
  await new Deno.Command("python3", { args: ["-I", "-c", "import sys,glob\nfrom PIL import Image\nfor f in glob.glob(sys.argv[1]+'*.png'):\n  Image.open(f).convert('RGB').quantize(16).save(f, optimize=True)", `${dir}/${key}-p`], stdout: "null", stderr: "null" }).output().catch(() => null);
  return [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.startsWith(`${key}-p`) && n.endsWith(".png")).sort();
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const tmp = await Deno.makeTempDir();
  const manifestUrl = new URL("manifest.json", GALLERY);
  const old = check ? JSON.parse(await Deno.readTextFile(manifestUrl)) : null;
  const manifest: Record<string, { pdf_sha256: string; pages: number; png: Record<string, string> }> = {};
  const problems: string[] = [];
  let rasterized = true;
  if (!check) await Deno.mkdir(GALLERY, { recursive: true });
  for (const g of galleryPdfs()) {
    const pngs = await raster(g.pdf, tmp, g.key);
    if (!pngs) rasterized = false;
    const png: Record<string, string> = {};
    for (const p of pngs ?? []) {
      const name = p.replace(/-p-?0*(\d+)\.png$/, "-p$1.png"), bytes = await Deno.readFile(`${tmp}/${p}`);
      png[name] = sha(bytes);
      if (!check) await Deno.writeFile(new URL(name, GALLERY), bytes);
    }
    manifest[g.key] = { pdf_sha256: sha(g.pdf), pages: g.pages, png };
    if (check) {
      const was = old[g.key];
      if (!was) problems.push(`${g.key}: not in the gallery`);
      else {
        if (was.pdf_sha256 !== manifest[g.key].pdf_sha256) problems.push(`${g.key}: the PDF changed (layout or text): regenerate the gallery and review the PNGs`);
        for (const [n, h] of Object.entries(png)) if (was.png[n] && was.png[n] !== h) {
          // Pixel comparison: the share of pixels that differ (pdftoppm versions can anti-alias a glyph edge differently).
          const diff = await pixelDiff(`${tmp}/${pngs!.find((p) => p.replace(/-p-?0*(\d+)\.png$/, "-p$1.png") === n)}`, new URL(n, GALLERY).pathname);
          if (diff === null || diff > 0.001) problems.push(`${g.key} ${n}: ${diff === null ? "could not compare" : `${(diff * 100).toFixed(3)}% of pixels differ`}`);
        }
      }
    }
  }
  if (!check) await Deno.writeTextFile(manifestUrl, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`${Object.keys(manifest).length} files, ${Object.values(manifest).reduce((s, m) => s + Object.keys(m.png).length, 0)} page images${rasterized ? "" : " (NOT_RUN: pdftoppm is not installed; PDFs hashed only)"}`);
  if (problems.length) { console.error(problems.join("\n")); Deno.exit(1); }
}

async function pixelDiff(a: string, b: string): Promise<number | null> {
  const py = `import sys\nfrom PIL import Image, ImageChops\nx=Image.open(sys.argv[1]).convert('L'); y=Image.open(sys.argv[2]).convert('L')\nif x.size!=y.size: print(1.0); sys.exit()\nd=ImageChops.difference(x,y).point(lambda v: 255 if v>32 else 0)\nprint(sum(1 for v in d.getdata() if v)/ (x.size[0]*x.size[1]))`;
  const r = await new Deno.Command("python3", { args: ["-I", "-c", py, a, b], stdout: "piped", stderr: "null" }).output().catch(() => null);
  return r?.success ? Number(new TextDecoder().decode(r.stdout).trim()) : null;
}
