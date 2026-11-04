// OWNER RULE (never automate LinkedIn, Indeed or Handshake), on the chat: an ask to apply, message or act on any of the
// three, or a link to one of them, is declined plainly, naming the site, by the turn the chat runs before every apply,
// link-read and batch turn (career_networking.ts siteRefusedTurn, career_outreach_track.ts siteAsk). Nothing is recorded
// and nothing is left waiting, so a later bare "yes" is never answered by it. The posting-link reader
// (career_apply_link.ts linkOf / linkAsk) never takes a link on those hosts either.
// Before this (trunk 2026-10-28) only LinkedIn was declined: "apply to the Data Analyst job at Contoso on Indeed" answered
// "I can't apply ... on Indeed yet", an indeed.com or joinhandshake.com link opened a batch that then took every later
// "yes", and "apply to jobs on Handshake for me" reached the catch-all.
import assertNode from "node:assert/strict";
import { siteAsk, siteOfLink, trackAsk } from "../../supabase/functions/_shared/career_outreach_track.ts";
import { siteRefusedTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { linkAsk, linkOf } from "../../supabase/functions/_shared/career_apply_link.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "u-site", TH = "t-site", T0 = Date.parse("2026-10-28T15:00:00Z");

const ASKS: [string, "LinkedIn" | "Indeed" | "Handshake"][] = [
  ["apply to the Data Analyst job at Contoso on Indeed", "Indeed"],
  ["apply to this job for me https://www.indeed.com/viewjob?jk=abc", "Indeed"],
  ["https://www.indeed.com/viewjob?jk=abc", "Indeed"],
  ["apply to https://uk.indeed.com/viewjob?jk=1", "Indeed"],
  ["can you apply here ca.indeed.com/viewjob?jk=2", "Indeed"],
  ["apply to this one https://www.indeed.co.uk/viewjob?jk=3", "Indeed"],
  ["Easy Apply to the Stripe job on Indeed", "Indeed"],
  ["message the recruiter on Indeed for me", "Indeed"],
  ["search Indeed for data jobs and apply", "Indeed"],
  ["apply through my indeed account", "Indeed"],
  ["apply to jobs on Handshake for me", "Handshake"],
  ["message recruiters on Handshake for me", "Handshake"],
  ["apply me on handshake https://app.joinhandshake.com/jobs/12345", "Handshake"],
  ["https://joinhandshake.com/jobs/9", "Handshake"],
  ["apply to https://uw.joinhandshake.com/stu/postings/77", "Handshake"],
  ["reach out to Maya through Handshake", "Handshake"],
  ["apply to the Data Analyst job at Contoso on LinkedIn", "LinkedIn"],
  ["apply to this one https://www.linkedin.com/jobs/view/123456", "LinkedIn"],
  ["send a message to Maya on LinkedIn", "LinkedIn"],
  ["https://lnkd.in/abc", "LinkedIn"],
];
const NOT_ASKS = [
  "yes", "Yes!", "no", "indeed I did", "I did indeed apply to Stripe last week", "I gave the recruiter a firm handshake",
  "here are my linkedin connections", "my linkedin profile https://www.linkedin.com/in/alex", "who do I know at stripe from linkedin",
  "follow up with maya who I met on linkedin", "apply to https://boards.greenhouse.io/acme/jobs/1 (I found it on https://www.indeed.com/viewjob?jk=1)",
  "apply to the Data Analyst role at Contoso", "email maya@indeed.com about the analyst role", "apply to https://jobs.lever.co/acme/123",
];

Deno.test("siteAsk: LinkedIn, Indeed and Handshake asks and links are found, naming the site; plain words are not", () => {
  for (const [m, site] of ASKS) eq(siteAsk(m), site, m);
  for (const m of NOT_ASKS) eq(siteAsk(m), null, m);
  for (const [u, site] of [["https://www.indeed.com/viewjob?jk=1", "Indeed"], ["https://de.indeed.com/x", "Indeed"], ["https://indeed.jobs/x", "Indeed"],
    ["https://joinhandshake.com/x", "Handshake"], ["https://app.joinhandshake.com/jobs/1", "Handshake"], ["https://www.linkedin.com/jobs/view/1", "LinkedIn"],
    ["https://boards.greenhouse.io/acme/jobs/1", null], ["https://notindeed.example/jobs/1", null]] as const) eq(siteOfLink(u), site, u);
});

Deno.test("the posting-link reader never takes a LinkedIn, Indeed or Handshake link", () => {
  for (const u of ["https://www.indeed.com/viewjob?jk=abc", "https://uk.indeed.com/viewjob?jk=abc", "https://app.joinhandshake.com/jobs/12345",
    "https://joinhandshake.com/jobs/1", "https://www.linkedin.com/jobs/view/123456", "https://boards.greenhouse.io.indeed.com/acme/jobs/1"]) {
    eq(linkOf(u), null, u);
    eq(linkAsk(`apply to ${u}`), null, u);
  }
  assert(linkOf("https://boards.greenhouse.io/acme/jobs/1"), "an employer's own ATS link still reads");
});

Deno.test("each is declined plainly, naming the site; nothing recorded or left waiting; a later 'yes' is not taken", async () => {
  const store = memoryOutreachStore();
  for (const [m, site] of ASKS) {
    const r = await siteRefusedTurn({ message: m, userId: U, threadId: TH, now: T0, state: {}, store, model: null });
    assert(r, `${m}: declined`);
    eq(r!.status, "refused", m);
    eq(r!.intent, site === "LinkedIn" ? "career_linkedin_refused" : "career_site_refused", m);
    const words = r!.reply.replace(/https?:\/\/\S+/g, "");
    assert(new RegExp(`I don't (?:apply|message)[^.]*${site}`).test(words), `${m}: says what it doesn't do on ${site}: ${r!.reply}`);
    assert(words.includes(`Nothing was sent or done on ${site}.`), `${m}: ${r!.reply}`);
    assert(!/\byet\b/i.test(words), `${m}: never implies it might later: ${r!.reply}`);
    if (/\bapply\b/i.test(m) && !/message|reach out/i.test(m)) assert(/employer's own careers site/.test(words), `${m}: offers the employer's own site: ${r!.reply}`);
  }
  const d = store.dump();
  eq([d.drafts, d.dnc, d.prefs], [[], {}, {}], "nothing drafted or recorded");
  // Nothing is waiting: a bare "yes" (or "send all") after a refusal is not this turn's, nor the tracker's.
  for (const m of ["yes", "Yes!", "yes please", "send all", "ok"]) {
    eq(await siteRefusedTurn({ message: m, userId: U, threadId: TH, now: T0, state: {}, store, model: null }), null, m);
    eq(trackAsk(m), null, m);
  }
});
