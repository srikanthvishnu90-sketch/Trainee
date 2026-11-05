// One posting, one identity, whatever link carries it (20261105190000; the mass-apply outcome eval, PR #519: duplicates
// prevented 0/14 on Greenhouse). A Greenhouse job number is global: ?gh_jid=N on the employer's own careers page is the
// same posting as boards.greenhouse.io/<board>/jobs/N, job-boards.greenhouse.io/<board>/jobs/N and the embedded form.
// Lever and Ashby: the posting page, its /apply or /application step, tracking, case and the EU host are one posting;
// the same id on another board is not. Two people applying to one posting: both admitted. One person twice: refused,
// and the refusal names the earlier application. The database's rule is the same function (tests/db/
// career_apply_posting_identity.test.sql; flow-scenarios-apply-r4 compares TypeScript and Postgres link by link).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { admitApplication, duplicateReply, type LogRow, postingKey } from "../../supabase/functions/_shared/career_apply.ts";
import { postingKey as portalKey } from "../../supabase/functions/_shared/posting_key.ts";
import { screenPicks } from "../../supabase/functions/_shared/career_apply_want.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const GH = "https://boards.greenhouse.io/datadog/jobs/8257324";
const GH_SAME = [
  "https://job-boards.greenhouse.io/datadog/jobs/8257324",
  "https://job-boards.eu.greenhouse.io/datadog/jobs/8257324",
  "https://boards.greenhouse.io/datadog/jobs/8257324?gh_src=newsletter",
  "https://boards.greenhouse.io/datadog/jobs/8257324/",
  "https://boards.greenhouse.io/datadog/jobs/8257324#app",
  "https://boards.greenhouse.io/embed/job_app?for=datadog&token=8257324",
  "https://boards.greenhouse.io/embed/job_app?for=datadog&gh_jid=8257324",
  "https://job-boards.greenhouse.io/embed/job_app?token=8257324&for=datadog",
  "https://careers.datadoghq.com/detail/?gh_jid=8257324",
  "https://www.datadoghq.com/careers/job?gh_jid=8257324&gh_src=abc",
  "https://careers.example.test/jobs?gh_jid=8257324",
  "HTTPS://Careers.Example.Test/jobs?utm_source=x&gh_jid=8257324",
  "https://boards.greenhouse.io/otherboard/jobs/8257324",
];
const GH_OTHER = [
  "https://boards.greenhouse.io/datadog/jobs/8257325",
  "https://careers.example.test/jobs?gh_jid=82573240",
  "https://careers.example.test/jobs?gh_jid=825732",
  "https://boards.greenhouse.io/embed/job_app?for=datadog&token=8257325",
  "https://careers.example.test/jobs?id=8257324",
  "https://careers.example.test/jobs/8257324",
];
const UUID = "a49693f9-2066-43b3-972a-cdd3a62fbbce";
const LEVER = `https://jobs.lever.co/cesiumastro/${UUID}`;
const LEVER_SAME = [`${LEVER}/apply`, `${LEVER}/`, `${LEVER}?lever-source=LinkedIn`, `${LEVER}/apply?lever-origin=applied`,
  `https://jobs.lever.co/CesiumAstro/${UUID.toUpperCase()}`, `https://jobs.eu.lever.co/cesiumastro/${UUID}`, `https://www.jobs.lever.co/cesiumastro/${UUID}/apply/`];
const LEVER_OTHER = [`https://jobs.lever.co/cesiumastro/00000000-0000-4000-8000-000000000001`, `https://jobs.lever.co/othercompany/${UUID}`];
const AID = "8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3";
const ASHBY = `https://jobs.ashbyhq.com/openai/${AID}`;
const ASHBY_SAME = [`${ASHBY}/application`, `${ASHBY}/`, `${ASHBY}?utm_source=alert`, `${ASHBY}/application?utm_source=x&src=y`,
  `https://jobs.ashbyhq.com/OpenAI/${AID.toUpperCase()}`, `https://Jobs.AshbyHQ.com/openai/${AID}#overview`];
const ASHBY_OTHER = [`https://jobs.ashbyhq.com/openai/00000000-0000-4000-8000-000000000001`, `https://jobs.ashbyhq.com/anthropic/${AID}`];

const cases: [string, string, string[], string[]][] = [["greenhouse", GH, GH_SAME, GH_OTHER], ["lever", LEVER, LEVER_SAME, LEVER_OTHER], ["ashby", ASHBY, ASHBY_SAME, ASHBY_OTHER]];

for (const [fam, base, same, other] of cases) {
  Deno.test(`${fam}: every link form of one posting is one identity; other postings are not`, () => {
    const k = postingKey(base);
    assert(k, `no key for ${base}`);
    for (const u of same) assertEquals(postingKey(u), k, `${u} is the same ${fam} posting as ${base}`);
    for (const u of other) assert(postingKey(u) !== k, `${u} is not the same posting as ${base}`);
  });

  Deno.test(`${fam}: one person twice is refused at every link form, naming the earlier application`, () => {
    const log: LogRow[] = [{ user_id: "A", job_id: `${fam}:first`, company: "Acme", at: NOW - 3_600_000, state: "submitted_unconfirmed", url: base }];
    for (const [k, u] of same.entries()) {
      const r = admitApplication(log, { user_id: "A", job_id: `${fam}:via${k}`, company: "Acme", url: u }, NOW);
      assertEquals([r.ok, r.reason], [false, "duplicate_job"], `${u}: a second application to the posting was admitted`);
      assertEquals(r.earlier?.job_id, `${fam}:first`, `${u}: the refusal names the earlier application`);
      const said = duplicateReply(r.earlier!);
      assert(said.includes("Acme") && said.includes(base) && said.includes("2026-11-05") && /not yet confirmed/.test(said) && /nothing new was queued or sent/.test(said), said);
    }
    for (const u of other) assert(admitApplication(log, { user_id: "A", job_id: `${fam}:${u}`, company: "Acme", url: u }, NOW).ok, `${u}: another posting is admitted`);
  });

  Deno.test(`${fam}: two people applying to the same posting are each admitted`, () => {
    const log: LogRow[] = [{ user_id: "A", job_id: `${fam}:first`, company: "Acme", at: NOW - 60_000, state: "queued", url: base }];
    for (const u of [base, ...same]) {
      const r = admitApplication(log, { user_id: "B", job_id: `${fam}:first`, company: "Acme", url: u }, NOW);
      assertEquals([r.ok, r.reason], [true, null], `${u}: person B is refused because person A applied`);
    }
  });
}

Deno.test("an attempt that sent nothing does not block the same posting by another link", () => {
  const log: LogRow[] = [{ user_id: "A", job_id: "gh:first", company: "Datadog", at: NOW - 60_000, state: "not_submitted", url: GH }];
  assert(admitApplication(log, { user_id: "A", job_id: "gh:again", company: "Datadog", url: "https://careers.example.test/jobs?gh_jid=8257324" }, NOW).ok);
});

Deno.test("the extension's portal key reads a Greenhouse embed that carries gh_jid (it was null)", () => {
  assertEquals(portalKey("https://boards.greenhouse.io/embed/job_app?for=datadog&gh_jid=8257324"), "greenhouse:datadog:8257324");
  assertEquals(portalKey("https://boards.greenhouse.io/embed/job_app?for=datadog&token=8257324"), "greenhouse:datadog:8257324");
});

Deno.test("the chat's queue: a pick of the board's link refused when the employer-page link is on record, the earlier application named", () => {
  const apps = [{ ref: "r1", company: "Datadog", role: "Product Manager", url: "https://careers.datadoghq.com/detail/?gh_jid=8257324", applied_at: "2026-11-01T10:00:00Z", stage: "Submitted", source: "queue" as const }];
  const pick = { job_id: "greenhouse:datadog:8257324", url: GH, company: "Datadog", title: "Product Manager" };
  const r = screenPicks([pick], { apps, facts: [], now: NOW });
  assertEquals(r.ok.length, 0, "the same posting was let through to the queue");
  const said = r.refused[0]?.said ?? "";
  assert(/already in your applications as the same posting/.test(said) && said.includes("careers.datadoghq.com/detail/?gh_jid=8257324") &&
    said.includes("Submitted") && said.includes("2026-11-01") && /nothing was queued/.test(said), said);
  // Another person's record never blocks this person: with no application of their own, the pick is not refused as a duplicate.
  const mine = screenPicks([pick], { apps: [], facts: [], now: NOW });
  assert(!mine.refused.some((x) => /same posting/.test(x.said)), JSON.stringify(mine.refused));
});
