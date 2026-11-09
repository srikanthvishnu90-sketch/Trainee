// R10 owner ruling (2026-11-09): people apply by a plain message and a yes. A search ranks the postings Trainee can submit
// itself ahead of EQUAL-fit postings that need the person's own account, and labels each one in chat and on the File:
// "I can submit this one for you" vs "this employer requires your own account". A better-fit posting that needs an account
// is never hidden or moved below a worse fit: it is labelled. canSubmit(posting) -> { can, reason } is a stub now (it knows
// nothing, so nothing is labelled or moved); WO-M fills it in. Here a fake check stands in for WO-M's.
// Fail-first on trunk: submit_capability.ts does not exist, and no search line or File row carries the label.
import assertNode from "node:assert/strict";
import { searchJudgeTurn, type SearchSources, type SourcePosting } from "../../supabase/functions/_shared/career_search_judge.ts";
import { CAN_SUBMIT_LABEL, canSubmitStub, OWN_ACCOUNT_LABEL, rankBySubmit, type SubmitCapability } from "../../supabase/functions/_shared/submit_capability.ts";
import { type Picked, resultsFile, whatOf } from "../../supabase/functions/_shared/role_results.ts";
import { renderFeed } from "../../supabase/functions/_shared/file_page.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const P = (id: string, title: string, company: string): SourcePosting =>
  ({ job_id: id, company, title, location: "Chicago, IL", url: `https://boards.greenhouse.io/test/jobs/${id.split(":").pop()}`, description: "Analyze data with SQL.", first_seen_at: new Date(NOW - 86400000).toISOString() });
const sources = (live: SourcePosting[]): SearchSources => ({ live: async () => live, liveHasRows: async () => live.length > 0, snapshot: async () => [] });
// The stand-in for WO-M's check: Ramp's form Trainee can fill; Workday employers need the person's own account.
const fake = (p: { job_id: string; company: string | null }): SubmitCapability | null =>
  /Workday/.test(p.company ?? "") ? { can: false, reason: "the employer's portal needs your own sign-in" } : /Ramp/.test(p.company ?? "") ? { can: true, reason: "a public application form" } : null;

Deno.test("owner ruling: within one fit tier the submittable come first; never across a fit difference; unknown stays between", () => {
  const caps = new Map<string, SubmitCapability | null>([["a", { can: false, reason: "" }], ["b", null], ["c", { can: true, reason: "" }], ["d", { can: false, reason: "" }], ["e", { can: true, reason: "" }]]);
  const rows = [{ id: "a", t: 3 }, { id: "b", t: 3 }, { id: "c", t: 3 }, { id: "d", t: 2 }, { id: "e", t: 1 }];
  const out = rankBySubmit(rows, (r) => r.t, (r) => r.id, caps).map((r) => r.id);
  assertNode.deepEqual(out, ["c", "b", "a", "d", "e"], "c (can) before b (unknown) before a (account) in tier 3; d (account, better fit) stays above e (can, worse fit)");
  // The stub knows nothing: the order is untouched.
  const none = new Map(rows.map((r) => [r.id, canSubmitStub({ job_id: r.id, url: null, company: null, title: "" }) as SubmitCapability | null]));
  assertNode.deepEqual(rankBySubmit(rows, () => 0, (r) => r.id, none).map((r) => r.id), ["a", "b", "c", "d", "e"]);
});

Deno.test("owner ruling: the search lines carry the label, equal-fit submittable first; the stub labels and moves nothing", async () => {
  const live = [P("greenhouse:test:1", "Data Analyst Intern", "TEST Workday Co"), P("greenhouse:test:2", "Data Analyst Intern", "TEST Plain Co"), P("greenhouse:test:3", "Data Analyst Intern", "TEST Ramp")];
  const ask = { role: "data analyst internships", place: "Chicago", remote: false };
  // No confirmed facts: every posting's fit is the same (unscored), so the order may move within it.
  const r = (await searchJudgeTurn({ message: "find data analyst internships in Chicago", ask, userId: "u", now: NOW, profile: null, sources: sources(live), judge: { on: false }, canSubmit: fake }))!;
  const numbered = r.reply.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/ — .*/, ""));
  assertNode.deepEqual(numbered.map((l) => l.replace(/^\d+\. Data Analyst Intern at /, "")), ["TEST Ramp", "TEST Plain Co", "TEST Workday Co"], r.reply);
  assertNode.match(r.reply, new RegExp(`1\\. Data Analyst Intern at TEST Ramp[\\s\\S]*?\\n   Apply: ${CAN_SUBMIT_LABEL}\\.`));
  assertNode.match(r.reply, new RegExp(`3\\. Data Analyst Intern at TEST Workday Co[\\s\\S]*?\\n   Apply: ${OWN_ACCOUNT_LABEL}\\.`));
  const plain = r.reply.split(/\n(?=\d+\. )/).find((b) => /TEST Plain Co/.test(b))!;
  assertNode.doesNotMatch(plain, /Apply:/, "an unknown posting gets no label (nothing claimed)");
  assertNode.equal(r.shortlist.length, 3, "nothing hidden");
  assertNode.deepEqual(r.picked!.map((p) => p.submit?.can ?? null), [true, null, false]);
  // The stub (what production passes until WO-M): the plain order, and no label.
  const s = (await searchJudgeTurn({ message: "find data analyst internships in Chicago", ask, userId: "u", now: NOW, profile: null, sources: sources(live), judge: { on: false }, canSubmit: canSubmitStub }))!;
  assertNode.doesNotMatch(s.reply, /Apply: /);
  const base = (await searchJudgeTurn({ message: "find data analyst internships in Chicago", ask, userId: "u", now: NOW, profile: null, sources: sources(live), judge: { on: false } }))!;
  assertNode.deepEqual(s.shortlist.map((x) => x.id), base.shortlist.map((x) => x.id), "the stub moves nothing");
  assertNode.equal(s.reply, base.reply, "the stub changes no word");
  assertNode.deepEqual(s.picked!.map((p) => p.submit ?? null), [null, null, null]);
  // A check that throws is unknown for that posting, never "can".
  const t = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources(live), judge: { on: false }, canSubmit: () => { throw new Error("down"); } }))!;
  assertNode.doesNotMatch(t.reply, /Apply: /);
});

Deno.test("owner ruling: the results page's chat lines and the File row carry the label", async () => {
  const remembered: any[] = [];
  const store: any = { remember: async (_u: string, _r: string, v: unknown) => { remembered.push(v); }, rememberList: async () => {}, rememberListMeta: async () => {}, prepared: async () => null };
  const pick = (id: string, company: string, submit: SubmitCapability | null): Picked => ({
    hit: { job_id: id, company, title: "Data Analyst Intern", location: "Chicago, IL", url: `https://boards.greenhouse.io/test/jobs/${id}`, first_seen_at: null, role_match: true, fit: null, pay: null } as any,
    posting: null, checked: { state: "live", at: NOW }, submit });
  const made = (await resultsFile({ userId: "u", now: NOW, what: whatOf({ role: "data analyst internships", place: "Chicago", remote: false, limits: null } as any), floor: null, store,
    picked: [pick("greenhouse:t:1", "TEST Ramp", { can: true, reason: "form" }), pick("greenhouse:t:2", "TEST Workday Co", { can: false, reason: "sign-in" }), pick("greenhouse:t:3", "TEST Plain Co", null)],
    links: async () => ({ url: "https://trainee.test/file/x" }) }))!;
  assertNode.match(made.lines[0], new RegExp(`^1\\. TEST Ramp — Data Analyst Intern, Chicago, IL — ${CAN_SUBMIT_LABEL} \\(open-checked\\) https://`));
  assertNode.match(made.lines[1], new RegExp(`^2\\. TEST Workday Co — Data Analyst Intern, Chicago, IL — ${OWN_ACCOUNT_LABEL} \\(open-checked\\) https://`));
  assertNode.match(made.lines[2], /^3\. TEST Plain Co — Data Analyst Intern, Chicago, IL \(open-checked\) https:\/\//, "unknown: no label");
  assertNode.deepEqual(remembered.map((v) => v.submit ?? null), [{ can: true, reason: "form" }, { can: false, reason: "sign-in" }, null], "kept on the listed job, for the File");
  const job = { ...remembered[1] };
  const html = renderFeed({ token: "t", rows: [{ ref: "r1", job, logo: null, snippet: "On-site", full: "x", status: null, inApps: false, tag: null, resume: null, byHand: false, blocked: null,
    submitLine: "This employer requires your own account" } as any], setHash: null, setSize: 0, top: null, og: null as any, total: 1 } as any);
  assertNode.match(html, /<p class="meta submit">This employer requires your own account<\/p>/);
  // The File's own mapping (trainee-file/handler.ts) reads job.submit with the same labels.
  const src = await Deno.readTextFile(new URL("../../supabase/functions/trainee-file/handler.ts", import.meta.url));
  assertNode.match(src, /job\.submit \? \{ submitLine: .*submitLabel\(job\.submit\)/);
});
