// RESUME LOOP (agent2/resumes, 2026-11-09; release item 3 in docs/architect/VERIFICATION-15.md, "Each delivered resume opens,
// can be copied and downloaded, matches the target, and invents no fact; checked in its delivered form (D.4 11)").
// scripts/resume-loop.ts makes 9 synthetic TEST profiles x 3 target roles x 3 layouts through the brain's tailor_resume tool
// (career_tools.ts -> career_tailor.ts tailorForPosting -> the renderer), takes the PDF and Word files it attaches, and opens
// each with outside tools (scripts/resume-loop-extract.py: poppler, pdfminer.six, the zip and python-docx). The bar: every
// case is made, every file opens, 0 invented facts, every file fits its template's pages, every file carries the target.
// Offline and free. The Python extractors are installed in CI (ci.yml, the architect shard); a CI run without them fails.
// deno-lint-ignore-file no-explicit-any
import { factTokens, inventedIn, runLoop, targetSkills } from "../../scripts/resume-loop.ts";
import { confirmedRecord, lineProblems } from "../../supabase/functions/_shared/career_materials_guard.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { PROFILES } from "./fixtures/resume-loop/profiles.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;

async function extractorReady(): Promise<string | null> {
  const r = await new Deno.Command("python3", { args: ["-I", "-c", "import pdfminer, docx; import shutil, sys; sys.exit(0 if shutil.which('pdftotext') and shutil.which('pdfinfo') else 3)"], stdout: "null", stderr: "null" }).output().catch(() => null);
  return r?.success ? null : "pdfminer.six, python-docx and poppler (pdftotext, pdfinfo) are needed";
}

Deno.test("resume loop/1 the checker catches what it must: an invented employer, number, email or link; a whole token only", () => {
  const hay = "riley fixture riley.fixture@example.test chicago, il built a python workflow for 120 targets at test transit office, june 2025";
  const bad = inventedIn("Riley Fixture\nLed a team of 12 at Google\nriley@other.test https://example.test/x\nTEST Transit Office, June 2025", hay);
  for (const w of ["12", "Google", "riley@other.test", "https://example.test/x", "Led"]) assert(bad.includes(w), `${w} is invented: ${JSON.stringify(bad)}`);
  for (const w of ["Riley", "Fixture", "TEST", "Transit", "Office", "June", "2025"]) assert(!bad.includes(w), `${w} is on the record: ${JSON.stringify(bad)}`);
  assert(inventedIn("Go", "google cloud").includes("Go"), "Go is not in Google");
  assert(!factTokens("Cut p99 latency").includes("99"), "p99 is a word, not the number 99");
  assert(inventedIn("Managed a budget of $8,000 for 50,000 shoppers", "managed a budget of $8,000 for 50,000 shoppers").length === 0, "the person's own separators");
});

Deno.test("resume loop/2 the truth check keeps the person's own \"$8,000\" and \"50,000\" (it refused every resume holding one)", () => {
  const p = CareerProfile.createProfile({ basics: { name: "TEST Person", email: "test.person@example.test" } });
  const f = CareerProfile.addFact(p, { kind: "experience", title: "Treasurer, TEST Society", text: "Managed a club budget of $8,000 for 50,000 members" });
  CareerProfile.confirmFact(p, f.id);
  const rec = confirmedRecord(p);
  assert(lineProblems("Managed a club budget of $8,000 for 50,000 members", rec, [f.id]).length === 0, JSON.stringify(lineProblems("Managed a club budget of $8,000 for 50,000 members", rec, [f.id])));
  const wrong = lineProblems("Managed a club budget of $9,000", rec, [f.id]);
  assert(wrong.some((x) => /9000/.test(x)), `a different number is still refused: ${JSON.stringify(wrong)}`);
});

Deno.test("resume loop/3 a file that does not open is counted as not open", async () => {
  const why = await extractorReady();
  if (why) { if (CI) throw new Error(why); console.log(`NOT_RUN locally: ${why}`); return; }
  const dir = await Deno.makeTempDir({ prefix: "resume-loop-bad-" });
  try {
    await Deno.writeTextFile(`${dir}/bad.pdf`, "%PDF-1.4\nnot really a pdf");
    await Deno.writeTextFile(`${dir}/bad.docx`, "PK not a zip");
    const r = await new Deno.Command("python3", { args: ["-I", `${ROOT}scripts/resume-loop-extract.py`, `${dir}/bad.pdf`, `${dir}/bad.docx`], stdout: "piped" }).output();
    const out = new TextDecoder().decode(r.stdout).trim().split("\n").map((l) => JSON.parse(l));
    assert(out.length === 2 && out.every((o) => o.ok === false && o.error), JSON.stringify(out));
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("resume loop/4 the profiles are synthetic and varied: at least 8, each marked TEST, each with 3 targets", () => {
  assert(PROFILES.length >= 8, "at least 8 profiles");
  for (const p of PROFILES) {
    assert(/\(TEST\)/.test(p.text) && /@example\.test$/.test(p.email), `${p.id} is marked TEST with an example.test address`);
    assert(p.targets.length >= 3, `${p.id} has 3 target roles`);
  }
  assert(PROFILES.some((p) => /[^\x00-\x7f]/.test(p.name)), "a non-ASCII name");
  const profile = CareerProfile.createProfile({ basics: {} });
  CareerProfile.ingestResume(profile, { text: PROFILES[0].text, fileName: "t.txt" });
  for (const f of profile.facts) CareerProfile.confirmFact(profile, f.id);
  assert(targetSkills(PROFILES[0].targets[0].posting, profile).proven.length > 0, "the first target names a skill the record shows");
});

Deno.test("resume loop/5 every TEST profile x role x layout: made, opens as PDF and DOCX, fits its pages, invents nothing, carries the target", async () => {
  const why = await extractorReady();
  if (why) { if (CI) throw new Error(why); console.log(`NOT_RUN locally: ${why}`); return; }
  const out = await Deno.makeTempDir({ prefix: "resume-loop-" });
  try {
    const r = await runLoop({ out });
    console.log(r.line);
    const s = r.summary;
    const problems = r.cases.flatMap((c) => [
      ...(c.made ? [] : [`${c.profile} ${c.role} ${c.variant}: not made: ${c.refused}`]),
      ...c.files.filter((f) => !f.ok || f.invented.length || !f.pageFit || !f.targetCarried).map((f) => `${c.profile} ${c.role} ${c.variant} ${f.kind}: ${JSON.stringify({ ok: f.ok, error: f.error, invented: f.invented, pages: f.pages, promised: f.promised, missing: f.targetMissing })}`),
    ]);
    assert(s.made === s.cases, `made ${s.made}/${s.cases}\n${problems.slice(0, 12).join("\n")}`);
    assert(s.files === s.cases * 2, `a PDF and a DOCX for every case: ${s.files}/${s.cases * 2}`);
    assert(s.opened === s.files, `opened ${s.opened}/${s.files}\n${problems.slice(0, 12).join("\n")}`);
    assert(s.invented === 0, `invented facts ${s.invented}\n${problems.slice(0, 12).join("\n")}`);
    assert(s.pageFit === s.files, `page fit ${s.pageFit}/${s.files}\n${problems.slice(0, 12).join("\n")}`);
    assert(s.targetCarried === s.files, `target carried ${s.targetCarried}/${s.files}\n${problems.slice(0, 12).join("\n")}`);
  } finally { await Deno.remove(out, { recursive: true }); }
});
