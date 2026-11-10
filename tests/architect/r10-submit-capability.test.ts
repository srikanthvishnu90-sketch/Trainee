// R10 (owner ruling 2026-11-09, D-050: apply by a plain message and a yes): each posting is labelled, before the yes, by what
// Trainee's cloud runner can actually do on its host. Guest-apply boards get no label until the browser benchmark shows the runner completes them;
// account boards say the employer needs the person's own account; any other host gets no label (never a guess).
import assertNode from "node:assert/strict";
import { canSubmitByHost, capabilitiesOf, OWN_ACCOUNT_LABEL, rankBySubmit, submitLabel } from "../../supabase/functions/_shared/submit_capability.ts";

const at = (url: string | null) => canSubmitByHost({ job_id: "j", url, company: "Acme", title: "Analyst" }) as { can: boolean; reason: string } | null;

Deno.test("submit capability: guest-apply boards get no promise until the benchmark earns it (19 of 220 filled on 2026-11-09)", () => {
  for (const u of ["https://boards.greenhouse.io/acme/jobs/1", "https://job-boards.greenhouse.io/acme/jobs/2", "https://jobs.lever.co/acme/abc", "https://jobs.ashbyhq.com/acme/x", "https://jobs.smartrecruiters.com/Acme/1"]) {
    assertNode.equal(at(u), null, u);
  }
});

Deno.test("submit capability: account boards need the person's own account; Trainee never creates one", () => {
  for (const u of ["https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1", "https://careers-acme.icims.com/jobs/1/job", "https://acme.taleo.net/careersection/1", "https://career4.successfactors.com/career?company=acme"]) {
    const c = at(u);
    assertNode.ok(c && c.can === false && /own account/.test(c.reason), u);
    assertNode.equal(submitLabel(c), OWN_ACCOUNT_LABEL);
  }
});

Deno.test("submit capability: an unknown or unreadable host gets no label, and look-alike hosts are not trusted", () => {
  for (const u of [null, "", "not a url", "https://acme.com/careers/1", "https://greenhouse.io.evil.example/x", "https://jobs.lever.co.evil.example/x"]) assertNode.equal(at(u as string | null), null, String(u));
});

Deno.test("submit capability: within a fit tier, submittable postings come first; better fit is never pushed down", async () => {
  const rows = [{ id: "wd", t: 1, url: "https://acme.wd1.myworkdayjobs.com/x" }, { id: "gh", t: 1, url: "https://boards.greenhouse.io/acme/jobs/1" }, { id: "best", t: 0, url: "https://acme.wd1.myworkdayjobs.com/y" }];
  const caps = await capabilitiesOf(rows.map((r) => ({ job_id: r.id, url: r.url, company: "Acme", title: "x" })), canSubmitByHost);
  const out = rankBySubmit([...rows].sort((a, b) => a.t - b.t), (r) => r.t, (r) => r.id, caps).map((r) => r.id);
  assertNode.deepEqual(out, ["best", "gh", "wd"], "an unlabelled posting ranks above one that needs an account");
});
