// OWNER RULE (never automate LinkedIn, Indeed or Handshake) at scale: thousands of generated asks and controls through the
// functions the chat runs before every apply, link-read and batch turn (career_outreach_track.ts siteAsk, the refusal turn
// career_networking.ts siteRefusedTurn) and the posting-link reader (career_apply_link.ts linkOf / linkAsk).
//   - an ask to apply, message, connect, DM or reach out on one of the three, in words (any case, common typos such as
//     "linkedn", "linked in") or by a link on any country host ("in.linkedin.com", "indeed.co.uk", "uk.indeed.com",
//     "app.joinhandshake.com/stu/jobs/..") with query strings, fragments, trailing punctuation, parentheses, markdown or
//     angle brackets, is refused naming that site; the refusal says nothing was done and records nothing
//   - a control is never refused: "indeed I did", "a firm handshake", their own LinkedIn export or profile link, an advice
//     question ("how should I update my linkedin headline?"), an employer careers link (also with ?utm_source=linkedin)
//   - the posting-link reader never takes a link on those hosts
// Seeded (tests/architect/scenarios-fixture.ts); no network, no model.
import assertNode from "node:assert/strict";
import { siteAsk } from "../../supabase/functions/_shared/career_outreach_track.ts";
import { siteRefusedTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { linkAsk, linkOf } from "../../supabase/functions/_shared/career_apply_link.ts";
import { rng, siteAsks, siteControls, siteLink, type Site } from "./scenarios-fixture.ts";

const ASKS = siteAsks(rng(20261029), 3000);
const CONTROLS = siteControls(rng(91), 1200);

function report(fails: string[], total: number, what: string) {
  if (fails.length) throw new Error(`${fails.length} of ${total} ${what} failed:\n${[...new Set(fails)].slice(0, 40).join("\n")}`);
}

Deno.test(`${ASKS.length} generated asks on LinkedIn, Indeed or Handshake are each refused, naming the site`, () => {
  const fails: string[] = [];
  for (const c of ASKS) { const got = siteAsk(c.input); if (got !== c.expect) fails.push(`[${c.family}] ${JSON.stringify(c.input)}: expected ${c.expect}, got ${got}`); }
  report(fails, ASKS.length, "asks");
});

Deno.test(`${CONTROLS.length} generated controls are never refused`, () => {
  const fails: string[] = [];
  for (const c of CONTROLS) { const got = siteAsk(c.input); if (got !== null) fails.push(`[${c.family}] ${JSON.stringify(c.input)}: refused as ${got}`); }
  report(fails, CONTROLS.length, "controls");
});

Deno.test("the refusal turn names the site, says nothing was done, and records nothing (a sample of 300 asks)", async () => {
  const store = memoryOutreachStore();
  const fails: string[] = [];
  const sample = ASKS.filter((_, i) => i % 10 === 0);
  for (const c of sample) {
    const state: Record<string, unknown> = {};
    const r = await siteRefusedTurn({ message: c.input, userId: "u-scen", threadId: "t-scen", now: Date.parse("2026-10-29T15:00:00Z"), state, store, events: null, model: null } as any);
    if (!r) { fails.push(`${JSON.stringify(c.input)}: no refusal turn`); continue; }
    const reply = String((r as any).reply ?? "");
    if ((r as any).status !== "refused" || !reply.includes(`Nothing was sent or done on ${c.expect}.`)) fails.push(`${JSON.stringify(c.input)}: ${(r as any).status}: ${reply}`);
    if (Object.keys(state).length) fails.push(`${JSON.stringify(c.input)}: left state ${JSON.stringify(state)}`);
  }
  assertNode.deepEqual(store.dump().drafts, [], "no outreach drafted or recorded");
  report(fails, sample.length, "refusal turns");
});

Deno.test("the posting-link reader never takes a link on LinkedIn, Indeed or Handshake (1500 generated links)", () => {
  const r = rng(7);
  const fails: string[] = [];
  const sites: Site[] = ["LinkedIn", "Indeed", "Handshake"];
  for (let i = 0; i < 1500; i++) {
    const u = siteLink(r, r.pick(sites));
    const url = /^https?:\/\//.test(u) ? u : `https://${u}`;
    if (linkOf(url) !== null) fails.push(`linkOf ${url}`);
    if (linkAsk(`apply to ${url}`) !== null) fails.push(`linkAsk ${url}`);
  }
  report(fails, 1500, "links");
});
