// LISTED SKILLS ARE SHOWN (architect ruling 2026-11-10, on the resume loop of #670): a skill the person listed in their own
// confirmed Skills is a confirmed fact (D-007), so it is proof and is shown; a skill only the posting names, with no confirmed
// fact behind it, stays off; the Skills section never disappears while the person has a confirmed skill. Before this the
// tailor's proof rule (123 skillFactProven, BUG-211) and its posting scope (BUG-273) left 438 of 594 listed skills off the
// loop's files, and the designer profile's Skills section vanished. The fix is in career_tailor.ts (listedSkillsProven,
// withListedSkills). Offline and free; the loop's Python extractors are installed in CI (a CI run without them fails).
// deno-lint-ignore-file no-explicit-any
import { runLoop } from "../../scripts/resume-loop.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const CI = Deno.env.get("CI") === "true";
const NOW = Date.UTC(2026, 10, 10, 15), USER = "00000000-0000-4000-8000-0000000011a1";
const printed = (r: any) => (r.detail.doc.sections as any[]).flatMap((s: any) => s.lines.map((l: any) => String(l.text))).join("\n");

function person(skills: string[]) {
  const p = CareerProfile.createProfile({ basics: { name: "TEST Skillful", email: "test.skillful@example.test" } });
  const e = CareerProfile.addFact(p, { kind: "experience", title: "Product Designer, TEST Studio", text: "Redesigned the checkout flow for TEST shoppers" });
  CareerProfile.confirmFact(p, e.id);
  const ids = skills.map((name) => { const f = CareerProfile.addFact(p, { kind: "skill", name, title: name }); CareerProfile.confirmFact(p, f.id); return f.id; });
  return { p, ids };
}
const POSTING = "UX Designer, TEST Travel (TEST posting)\nRequirements:\n- Figma and prototyping\n- Kubernetes and Terraform";

Deno.test("listed skills/1 every confirmed listed skill prints, cited to its fact; a skill only the posting names stays off", async () => {
  const { p, ids } = person(["Figma", "Illustrator"]);
  const r = await tailorForPosting({ userId: USER, profile: p, posting: { text: POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assert(r.ok, JSON.stringify(r));
  const text = printed(r);
  for (const s of ["Figma", "Illustrator"]) assert(text.includes(s), `${s} is the person's confirmed skill and prints:\n${text}`);
  for (const s of ["Kubernetes", "Terraform", "Prototyping"]) assert(!new RegExp(`\\b${s}\\b`, "i").test(text.replace(/checkout flow/i, "")), `${s} only the posting names: it stays off:\n${text}`);
  const line = (r.detail.doc.sections as any[]).flatMap((s: any) => s.lines).find((l: any) => l.type === "skills");
  assert(line && ids.every((id) => line.factIds.includes(id)), `the Skills line cites each skill fact: ${JSON.stringify(line)}`);
});

Deno.test("listed skills/2 the Skills section stays when no listed skill is in the posting's scope", async () => {
  const { p } = person(["Watercolor", "Calligraphy"]);
  const r = await tailorForPosting({ userId: USER, profile: p, posting: { text: "Backend Engineer, TEST Infra (TEST posting)\nRequirements:\n- Go and Kubernetes" }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assert(r.ok, JSON.stringify(r));
  const skills = (r.detail.doc.sections as any[]).find((s: any) => /skills/i.test(s.heading));
  assert(skills && /Watercolor/.test(JSON.stringify(skills)) && /Calligraphy/.test(JSON.stringify(skills)), `a Skills section with both: ${JSON.stringify(r.detail.doc.sections.map((s: any) => s.heading))}`);
});

Deno.test("listed skills/3 a draft skill and a skill a persona hides never print", async () => {
  const { p } = person(["Figma"]);
  const draft = CareerProfile.addFact(p, { kind: "skill", name: "Blender", title: "Blender", needs_confirmation: true }); // a draft, never confirmed
  const hidden = CareerProfile.addFact(p, { kind: "skill", name: "Sketch", title: "Sketch" });
  CareerProfile.confirmFact(p, hidden.id);
  const r = await tailorForPosting({ userId: USER, profile: p, posting: { text: POSTING }, persona: { name: "lean", lead: [], hide: [hidden.id], at: "2026-11-10" }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assert(r.ok, JSON.stringify(r));
  const text = printed(r);
  assert(!/Blender/.test(text), `a draft skill never prints (${draft.id}):\n${text}`);
  assert(!/Sketch/.test(text), `a hidden skill stays hidden:\n${text}`);
  assert(/Figma/.test(text), text);
});

async function extractorReady(): Promise<string | null> {
  const r = await new Deno.Command("python3", { args: ["-I", "-c", "import pdfminer, docx; import shutil, sys; sys.exit(0 if shutil.which('pdftotext') and shutil.which('pdfinfo') else 3)"], stdout: "null", stderr: "null" }).output().catch(() => null);
  return r?.success ? null : "pdfminer.six, python-docx and poppler (pdftotext, pdfinfo) are needed";
}

Deno.test("listed skills/4 the resume loop: confirmed listed skills shown 100%, invented facts 0, on every delivered PDF and DOCX", async () => {
  const why = await extractorReady();
  if (why) { if (CI) throw new Error(why); console.log(`NOT_RUN locally: ${why}`); return; }
  const out = await Deno.makeTempDir({ prefix: "resume-loop-skills-" });
  try {
    const r = await runLoop({ out });
    console.log(r.line);
    const s = r.summary as any;
    const miss = r.cases.flatMap((c) => c.files.filter((f: any) => f.listedMissing?.length || f.invented.length).map((f: any) => `${c.profile} ${c.role} ${c.variant} ${f.kind}: missing ${f.listedMissing?.join(", ")} invented ${f.invented.join(", ")}`));
    assert(s.listedSkills > 0 && s.listedShown === s.listedSkills, `confirmed listed skills shown ${s.listedShown}/${s.listedSkills}\n${miss.slice(0, 12).join("\n")}`);
    assert(s.invented === 0, `invented facts ${s.invented}\n${miss.slice(0, 12).join("\n")}`);
    assert(s.made === s.cases && s.opened === s.files && s.pageFit === s.files && s.targetCarried === s.files, r.line);
  } finally { await Deno.remove(out, { recursive: true }); }
});
