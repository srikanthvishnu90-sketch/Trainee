// RESUME BYTES PARITY (#673, WO-028/5): the resume loop's plain-layout cases (9 TEST profiles x 3 roles) are tailored in
// Deno (career_tailor.ts tailorForPosting, the edge renderer), then the same document is rendered by Node with 148's own
// module, and the two PDFs' bytes are compared. Prints "BYTES PARITY: N/27 byte-identical (Deno vs Node)" and exits 1 below
// 27/27. Offline and free.
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json scripts/resume-bytes-parity.ts
// deno-lint-ignore-file no-explicit-any
import { CareerProfile } from "../supabase/functions/_shared/router_core.career.js";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../supabase/functions/_shared/career_tailor.ts";
import { PROFILES } from "../tests/architect/fixtures/resume-loop/profiles.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 10, 15);

export async function bytesParity(): Promise<{ same: number; total: number; differ: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "resume-bytes-" });
  try {
    const cases: { id: string; sha: string; path: string }[] = [];
    for (const p of PROFILES) {
      const prof = CareerProfile.createProfile({ basics: { name: p.name, email: p.email, location: p.location } });
      CareerProfile.ingestResume(prof, { text: p.text, fileName: `${p.id}.txt` });
      for (const f of prof.facts) CareerProfile.confirmFact(prof, f.id);
      for (const t of p.targets) {
        const r: any = await tailorForPosting({ userId: `00000000-0000-4000-8000-${p.id.padStart(12, "0")}`, profile: prof, posting: { text: t.posting }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
        if (!r.ok) throw new Error(`${p.id} ${t.role}: ${r.reason}`);
        const path = `${dir}/${cases.length}.json`;
        await Deno.writeTextFile(path, JSON.stringify(r.detail.doc));
        cases.push({ id: `${p.id} ${t.role}`, sha: r.sha256, path });
      }
    }
    const render148 = `${ROOT}packages/domain/148-career-render.js`;
    const js = `const R=require(${JSON.stringify(render148)});for(const p of process.argv.slice(1)){process.stdout.write(R.sha256(R.renderPdf(require(p)).buffer)+"\\n")}`;
    const node = await new Deno.Command("node", { args: ["-e", js, ...cases.map((c) => c.path)], stdout: "piped" }).output();
    const shas = new TextDecoder().decode(node.stdout).trim().split("\n");
    const differ = cases.filter((c, i) => shas[i] !== c.sha).map((c) => c.id);
    return { same: cases.length - differ.length, total: cases.length, differ };
  } finally { await Deno.remove(dir, { recursive: true }); }
}

if (import.meta.main) {
  const r = await bytesParity();
  for (const d of r.differ) console.log(`differs: ${d}`);
  console.log(`BYTES PARITY: ${r.same}/${r.total} byte-identical (Deno vs Node)`);
  Deno.exit(r.same === r.total ? 0 : 1);
}
