// D-072 (files writers), the review of PR #799 (2026-11-13), in process. Each finding with its rule:
//   R1 erase: the migration 20261113120000 lets the person's own erase (and only it) delete approved versions; it is in go-live
//      (MIGRATIONS and its MIGRATION_MARK), has its rollback, and tests/db/run.sh applies it and runs its check. The behaviour itself
//      is proven on Postgres by tests/db/career_erase_approved_versions.check.sql.
//   R2 one document per posting: two pasted postings are two documents (never each other's v2), the same posting again is its v2;
//      targets with no Latin letters do not collapse to `resume`/`letter`; the posting's text is never stored or shown.
//   R3 path comparison: the name on the File is the person's wording (a model's name they did not write is replaced by their
//      words; the title too); related facts are matched on whole words, two of the path's words; Strong needs three such facts;
//      an offer matches a company by whole words only.
//   R4 a cover letter says what it is based on only when the draft lists its facts.
//   deno test -A --no-check tests/architect/files-writers-review-20261113.test.ts
import assert from "node:assert/strict";
import { docKeyOf, type MaterialRow, type MaterialWriteStore, postingKeyOf, withLetterVersions, writeTurnMaterials } from "../../supabase/functions/_shared/career_material_writer.ts";
import { directionOf, memoryPathStore } from "../../supabase/functions/_shared/career_path_comparisons.ts";
import { pathComparisonTool } from "../../supabase/functions/_shared/agent/path_comparison_tool.ts";
import type { FileService } from "../../supabase/functions/_shared/file_service.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0799";
const NOW = Date.parse("2026-11-13T15:00:00Z");
const KEY = /^[a-z0-9][a-z0-9-]{0,59}$/; // the table's own check on doc_key
const b64 = (s: string) => btoa(s);
function memMaterials(): MaterialWriteStore & { rows: (MaterialRow & { user: string })[] } {
  const rows: (MaterialRow & { user: string })[] = [];
  return {
    rows,
    async newest(u, doc) { const r = rows.filter((x) => x.user === u && x.doc_key === doc).sort((a, b) => b.version - a.version)[0]; return r ? { version: r.version, file_sha256: r.file.sha256 } : null; },
    async insert(u, row) { if (rows.some((x) => x.user === u && x.doc_key === row.doc_key && x.version === row.version)) return "conflict"; rows.push({ ...row, user: u }); return "ok"; },
  };
}

Deno.test("R1 erase: the migration, its rollback, go-live and the database suite carry the fix", async () => {
  const name = "20261113120000_career_erase_approved_versions";
  const up = await Deno.readTextFile(`${ROOT}supabase/migrations/${name}.sql`), down = await Deno.readTextFile(`${ROOT}supabase/rollbacks/${name}.down.sql`);
  const sql = up.replace(/^\s*--.*$/gm, "");
  // The erase names its person for its own transaction (transaction-local) and clears it; the guard compares it to the row's owner.
  assert.match(sql, /perform set_config\('career\.erase_person', p_user::text, true\)/);
  assert.match(sql, /perform set_config\('career\.erase_person', '', true\)/);
  assert.match(sql, /old\.approved_at is not null and exists \(select 1 from auth\.users where id = old\.user_id\)\s+and coalesce\(current_setting\('career\.erase_person', true\), ''\) is distinct from old\.user_id::text/);
  assert.match(sql, /raise exception 'an approved version is never deleted'/);
  assert.match(sql, /if old\.approved_at is not null then raise exception 'an approved version is never changed'/, "an approved version is still never changed");
  assert.match(sql, /revoke all on function public\.career_erase_person\(uuid\) from public, anon, authenticated/);
  assert.ok(!down.replace(/^\s*--.*$/gm, "").includes("career.erase_person"), "the rollback restores the guard and the erase without the setting");
  const golive = await Deno.readTextFile(`${ROOT}scripts/launch/trainee-go-live.sh`);
  const migs = golive.slice(golive.indexOf("MIGRATIONS=("), golive.indexOf("MIGRATION_MARK=(")).match(/^\s+(\d{14}_[a-z0-9_]+\.sql)$/gm)!.map((x) => x.trim());
  const marks = golive.slice(golive.indexOf("MIGRATION_MARK=("), golive.indexOf("\n)", golive.indexOf("MIGRATION_MARK=("))).match(/^\s+".*"$/gm)!;
  const at = migs.indexOf(`${name}.sql`);
  assert.ok(at > migs.indexOf("20261112150000_career_path_comparisons.sql") && at > migs.indexOf("20261110160000_career_file_plans_materials.sql"), "applied after the guard it replaces");
  assert.equal(migs.length, marks.length, "one mark per migration");
  assert.match(marks[at], /career_file_versions_guard.*career\.erase_person.*career_erase_person.*career\.erase_person/);
  const run = await Deno.readTextFile(`${ROOT}tests/db/run.sh`);
  for (const f of [`migrations/${name}.sql`, `rollbacks/${name}.down.sql`, "career_erase_approved_versions.check.sql"]) assert.ok(run.includes(f), `tests/db/run.sh runs ${f}`);
  assert.ok(run.lastIndexOf(`migrations/${name}.sql`) > run.lastIndexOf("migrations/20261110160000_career_file_plans_materials.sql"), "applied after the migration whose guard it replaces");
  const check = await Deno.readTextFile(`${ROOT}tests/db/career_erase_approved_versions.check.sql`);
  for (const s of ["career_erase_person(b)", "'career:account'", "a plain delete removed an approved plan", "a plain delete removed an approved document", "career_path_comparisons"]) assert.ok(check.includes(s), `the check covers ${s}`);
});

Deno.test("R2 materials: one document per posting, whatever the target's words", async () => {
  const store = memMaterials();
  const postingA = "Data Analyst\nAcme Corp is hiring a data analyst to build dashboards in SQL and Python for the finance team.";
  const postingB = "Software Engineer\nGlobex is hiring a backend engineer to build payment services in Go and Postgres.";
  const doc = (text: string, target: string, posting: string | null, job: string | null = null) => ({ format: "pdf", filename: "resume.pdf", base64: b64(text), sha256: null,
    material: { doc_kind: "resume", target, role_job_id: job, ...(posting ? { posting_key: posting } : {}), based_on: "your confirmed resume", changes: [] } });
  const [kA, kB] = [await postingKeyOf(postingA), await postingKeyOf(postingB)];
  assert.match(kA, /^[a-f0-9]{64}$/, "a digest: the posting's text goes no further");
  assert.equal(kA, await postingKeyOf(`  ${postingA.toUpperCase().replace(/ /g, "  ")}\n`), "the same posting, case and spacing aside");
  // Two pasted postings, the same words for both ("the posting you pasted"): two documents, each v1.
  const a1 = (await writeTurnMaterials(store, U, [doc("%PDF a1", "the posting you pasted", kA)], [true], null))[0];
  const b1 = (await writeTurnMaterials(store, U, [doc("%PDF b1", "the posting you pasted", kB)], [true], null))[0];
  assert.ok(a1.written && b1.written && a1.doc_key !== b1.doc_key, `a resume for another posting is its own document: ${a1.doc_key} ${b1.doc_key}`);
  assert.deepEqual([a1.written && a1.version, b1.written && b1.version], [1, 1], "never the other posting's v2");
  // The same posting again, changed: its v2. Two postings at one employer: two documents.
  const a2 = (await writeTurnMaterials(store, U, [doc("%PDF a2", "the posting you pasted", kA)], [true], null))[0];
  assert.deepEqual([a2.doc_key, a2.written && a2.version], [a1.doc_key, 2]);
  const e1 = await docKeyOf({ doc_kind: "resume", target: "the posting at Acme", role_job_id: null, posting_key: kA });
  const e2 = await docKeyOf({ doc_kind: "resume", target: "the posting at Acme", role_job_id: null, posting_key: kB });
  assert.ok(e1 !== e2 && e1.startsWith("resume-the-posting-at-acme-") && e2.startsWith("resume-the-posting-at-acme-"), `${e1} ${e2}`);
  // A posting with an id is keyed by the id, as before (the pasted text is not needed).
  assert.equal(await docKeyOf({ doc_kind: "resume", target: "Data Analyst at Acme", role_job_id: "greenhouse:acme:7", posting_key: kA }), await docKeyOf({ doc_kind: "resume", target: "Data Analyst at Acme", role_job_id: "greenhouse:acme:7" }));
  assert.notEqual(await docKeyOf({ doc_kind: "resume", target: "Data Analyst at Acme", role_job_id: "greenhouse:acme:7" }), await docKeyOf({ doc_kind: "resume", target: "Data Analyst at Acme", role_job_id: "greenhouse:acme:8" }));
  // A role (no posting) in plain words is keyed by its words alone, as before.
  assert.equal(await docKeyOf({ doc_kind: "resume", target: "data analyst internships", role_job_id: null }), "resume-data-analyst-internships");
  // Targets with no Latin letters, or told apart only by symbols, stay apart, and every key fits the table's check.
  const keys = await Promise.all(["数据分析师", "产品经理", "Аналитик данных", "مهندس برمجيات", "C++ developer", "C# developer", "C developer"].flatMap((t) =>
    (["resume", "letter"] as const).map((k) => docKeyOf({ doc_kind: k, target: t, role_job_id: null }))));
  assert.equal(new Set(keys).size, keys.length, `distinct: ${keys.join(" ")}`);
  for (const k of [...keys, a1.doc_key, b1.doc_key, e1]) assert.match(k, KEY, k);
  assert.ok(!keys.includes("resume") && !keys.includes("letter"));
  const z = (await writeTurnMaterials(store, U, [doc("%PDF z1", "数据分析师", null)], [true], null))[0];
  const y = (await writeTurnMaterials(store, U, [doc("%PDF y1", "产品经理", null)], [true], null))[0];
  assert.deepEqual([z.written && z.version, y.written && y.version, z.doc_key !== y.doc_key], [1, 1, true]);
  // Nothing invented or leaked into what the person sees: the label is the target as said; the posting's text is in no row.
  assert.deepEqual(store.rows.filter((r) => r.doc_key === a1.doc_key).map((r) => r.label), ["the resume for the posting you pasted", "the resume for the posting you pasted"]);
  const stored = JSON.stringify(store.rows.map(({ file: _f, ...r }) => r));
  assert.ok(!stored.includes("dashboards") && !stored.includes(kA.slice(10)) && !("posting_key" in store.rows[0]), "neither the posting's text nor its whole digest is stored");
});

Deno.test("R2 tailor_resume marks a pasted posting's file with the posting's own key", async () => {
  const src = await Deno.readTextFile(`${ROOT}supabase/functions/_shared/agent/career_tools.ts`);
  assert.match(src, /role_job_id: r\.job_id, \.\.\.\(r\.job_id \? \{\} : \{ posting_key: await postingKeyOf\(text\) \}\)/);
});

const fact = (title: string, text = "") => ({ title, text });
Deno.test("R3 path comparison: whole words, two of the path's words, and a stricter Strong", () => {
  const at = new Date(NOW).toISOString();
  const offers = [{ company: "Meta", terms: "PM, base $150,000", at: NOW }, { company: "Bain", terms: "Associate", at: NOW }, { company: "Jane Street", terms: "Trader", at: NOW }];
  // One shared word is not a relation when the path has two words or more: three facts that say "management" were Strong before.
  const mgmt = [fact("Stock room management, campus store"), fact("Time management workshop"), fact("Event management volunteer")];
  const pm = directionOf("A", { name: "product management", said: "product management" }, mgmt, [], at);
  assert.deepEqual([pm.evidence, pm.related, pm.rows[1].v], ["Weak", 0, null]);
  // Two of its words, as whole words: related. Three such facts: Strong.
  const real = [fact("Product Analyst Intern", "Sat with the product management team"), fact("Associate product manager course", "Product management basics"), fact("Capstone", "A product management case for a campus app")];
  assert.deepEqual([directionOf("A", { name: "product management", said: "product management" }, real.slice(0, 2), [], at).evidence, directionOf("A", { name: "product management", said: "product management" }, real, [], at).evidence], ["Partial", "Strong"]);
  // Part of a word is not the word.
  assert.equal(directionOf("A", { name: "data science", said: "data science" }, [fact("Database administrator", "Ran the conscience survey datasets")], [], at).related, 0);
  // A one-word path relates by that word, and is never Strong however many facts say it.
  const one = directionOf("A", { name: "consulting", said: "consulting" }, [fact("Consulting club"), fact("Consulting case team"), fact("Pro bono consulting"), fact("Consulting intern")], [], at);
  assert.deepEqual([one.evidence, one.related], ["Partial", 4]);
  // An offer: the company's name as whole words in what they wrote, never inside another word.
  const has = (name: string, said = name) => directionOf("A", { name, said }, [], offers, at).rows.some((r) => r.k === "Offer on file");
  assert.deepEqual([has("metallurgy research"), has("the Meta offer"), has("consulting at Bainbridge"), has("consulting at Bain"), has("trading at Jane Street"), has("Jane's street food stall"), has("banking", "the offer from Meta")], [false, true, false, true, true, false, true]);
  assert.equal(directionOf("A", { name: "x y", said: "x y" }, [], [{ company: "", terms: "t", at: NOW }], at).rows.length, 2, "an offer with no company matches nothing");
});

Deno.test("R3 compare_paths: the name and the title on the File are the person's wording", async () => {
  const store = memoryPathStore(() => NOW), tool = pathComparisonTool(store);
  const message = "I'm weighing two paths: staying at my lab job or the offer from Meta. Compare them?";
  const state = { profile: { facts: [] }, offerBenchmark: { offers: [{ offer: { company: "Meta", role: "Data Scientist", base: 150000 }, at: NOW - 1000 }] } };
  const ctx = { userId: U, threadId: "t", now: NOW, state, turn: { message, added: [] } };
  // The model's names are its own ("Academic research career", "Big Tech"): the person never wrote them, so their words stand instead.
  // deno-lint-ignore no-explicit-any
  const out: any = await tool.run({ title: "Academia vs Big Tech", paths: [{ name: "Academic research career", said: "staying at my lab job" }, { name: "Big Tech", said: "the offer from Meta" }] }, ctx);
  const row = (await store.newest(U))!;
  assert.deepEqual(row.directions.map((d) => [d.name, d.said]), [["staying at my lab job", "staying at my lab job"], ["the offer from Meta", "the offer from Meta"]]);
  assert.equal(row.title, "staying at my lab job vs the offer from Meta");
  assert.ok(!/Academi|Big Tech/.test(JSON.stringify(row) + JSON.stringify(out)), "none of the model's naming is stored or returned as theirs");
  assert.ok(row.directions[1].rows.some((r) => r.k === "Offer on file" && /Data Scientist, base \$150,000/.test(String(r.v))), "the offer they told Trainee about, matched in their words");
  // A name and a title they did write are kept as given.
  await tool.run({ title: "Lab job vs Meta", paths: [{ name: "My lab job", said: "staying at my lab job" }, { name: "Meta", said: "the offer from Meta" }] }, ctx);
  const kept = (await store.newest(U))!;
  assert.deepEqual([kept.version, kept.title, kept.directions.map((d) => d.name)], [2, "Lab job vs Meta", ["My lab job", "Meta"]]);
  // A path whose words they did not write is refused, as before.
  await assert.rejects(() => tool.run({ paths: [{ name: "Meta", said: "the offer from Google" }, { name: "My lab job", said: "staying at my lab job" }] }, ctx), /own words/);
});

Deno.test("R4 a cover letter states its basis only when the draft lists its facts", async () => {
  const store = memMaterials();
  const files = { create: async (_u: string, kind: string) => ({ ok: true, id: "f1", kind, title: "t", url: "https://trainee.example/file?t=x", webApp: null }), ttlHours: () => 168 } as unknown as FileService;
  const f = withLetterVersions(files, store);
  const letter = { title: "Cover letter for Data Analyst at Acme", type: "cover_letter", body: "Dear Acme team,\nI built a reporting dashboard used by 200 people." };
  await f.create(U, "draft", { ...letter, basis: [] });
  await f.create(U, "draft", { ...letter, body: `${letter.body}\nThank you.` });
  await f.create(U, "draft", { ...letter, body: `${letter.body}\nRegards.`, basis: [{ label: "Dashboard", value: "Built a reporting dashboard used by 200 people" }] });
  await f.create(U, "draft", { ...letter, body: `${letter.body}\nBest.`, basis: [{ label: "a", value: "b" }, { label: "c", value: "d" }, null] });
  assert.deepEqual(store.rows.map((r) => [r.version, r.based_on]), [[1, null], [2, null], [3, "the 1 fact listed on the draft"], [4, "the 2 facts listed on the draft"]]);
  assert.ok(!JSON.stringify(store.rows.map(({ file: _f, ...r }) => r)).includes("confirmed facts"), "no unchecked claim about confirmed facts");
});
