// F09 gap: the posting screen (career_apply_screen.ts, PR #231) is wired into every apply path through screenPicks
// (career_apply_gate.ts). A scam, a stale and a knock-out-mismatched posting never reach the queue or the approval
// payload; an unconfirmed knock-out fact is asked once, never guessed; D-MS-3 and NO LIMITS hold. Removing the gate call
// from screenPicks turns the first three tests red (and the wiring test), checked by mutation before the PR.
import assert from "node:assert/strict";
import { applyManyTurn, applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { gatePicks, screenFactsFrom } from "../../supabase/functions/_shared/career_apply_gate.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86400000).toISOString();
const FACTS = [
  { key: "location", value: "Austin, TX" }, { key: "relocation", value: "no" }, { key: "sponsorship", value: "No" },
  { key: "citizenship", value: "India" }, { key: "years_experience", value: 2 }, { key: "education_level", value: "bachelor" },
];
const rec = (n: number, extra: Record<string, unknown> = {}) => ({
  job_id: `greenhouse:acme:${n}`, company: `Co${n}`, title: "Analyst", location: "Austin, TX", url: `https://boards.greenhouse.io/acme/jobs/${n}`,
  description: "SQL and Python. 1+ years of experience.", posted_at: day(3), closed_at: null, ...extra,
});
const RECS: Record<string, any> = {
  good: rec(1), good2: rec(2),
  stale: rec(3, { posted_at: day(120) }),
  scam: rec(4, { description: "Work from home! Pay a $50 training fee. Interview on Telegram." }),
  clearance: rec(5, { description: "Active Secret clearance required. US citizens only." }),
  degree: rec(6, { description: "A Master's degree is required." }),
  nosponsor: rec(7, { sponsorship: 1, description: "We do not provide visa sponsorship.", }),
  unknown: rec(8, { description: "Must be authorized under export controls. U.S. citizens only." }),
  samecompany: rec(9, { company: "Co1" }), // D-MS-3: another posting at an employer already in the batch
};
const idOf = (k: string) => RECS[k].job_id;
const list = (...ks: string[]): ShortlistEntry[] => ks.map((k) => ({ id: idOf(k), title: RECS[k].title, company: RECS[k].company, location: RECS[k].location, url: RECS[k].url }));
function world(facts: any[] = FACTS) {
  const wants = memoryWantStore();
  const turn = (message: string, ks: string[]) => applyManyTurn({
    message, userId: "u1", now: NOW, wants, apps: async () => [], facts, shortlist: list(...ks), postings: { search: async () => [] },
    posting: async (id) => Object.values(RECS).find((r) => r.job_id === id) ?? null,
  });
  return { wants, turn };
}
const queuedKeys = (w: ReturnType<typeof memoryWantStore>) => (w.dump().u1 ?? []).map((x) => x.url.replace("job-boards.greenhouse.io", "boards.greenhouse.io"));

Deno.test("batch: scam, stale and knock-out postings never reach the queue; the summary says why", async () => {
  const { wants, turn } = world();
  const r = await turn("apply to all of them", ["good", "stale", "scam", "clearance", "degree", "good2"]);
  assert(r && r.status === "queued", JSON.stringify(r));
  assert.deepEqual(queuedKeys(wants).sort(), [RECS.good.url, RECS.good2.url].sort());
  assert.equal(r!.screen!.counts.dropped, 4);
  assert.deepEqual(r!.screen!.counts.by_kind, { stale: 1, scam: 1, knockout: 2 });
  assert(/Screened out 4 \(1 stale, 1 scam-looking, 2 knock-out mismatch\)/.test(r!.reply), r!.reply);
  assert(/scam/i.test(r!.reply) && /days ago/.test(r!.reply) && /citizens/i.test(r!.reply) && /degree/i.test(r!.reply), r!.reply);
});

Deno.test("single apply passes the same screen", async () => {
  for (const [k, kind] of [["stale", "stale"], ["scam", "scam"], ["degree", "knockout"]] as const) {
    const wants = memoryWantStore();
    const r = await applyTurn({ message: `apply to the Analyst role at ${RECS[k].company}`, userId: "u1", now: NOW, wants, apps: async () => [], facts: FACTS,
      postings: { search: async () => [RECS[k]] } });
    assert(r && r.status === "refused", `${k}: ${JSON.stringify(r)}`);
    assert.equal(r!.screen!.dropped[0].kind, kind);
    assert.deepEqual(queuedKeys(wants), [], k);
  }
});

Deno.test("unknown knock-out fact: the posting proceeds, labeled not checked; a CONFIRMED conflicting fact still stops it (round 6)", async () => {
  const { wants, turn } = world(FACTS.filter((f) => f.key !== "citizenship"));
  const r = await turn("apply to all of them", ["good", "clearance", "unknown"]);
  assert.deepEqual(queuedKeys(wants), [RECS.good.url, RECS.clearance.url, RECS.unknown.url], "unknown citizenship never holds a posting");
  assert.equal(r!.screen!.counts.held, 0);
  assert.equal(r!.screen!.asks.length, 0);
  assert.deepEqual(r!.screen!.unchecked.map((u) => u.facts).flat(), ["citizenship", "citizenship"], "labeled not checked");
  // the same postings with a CONFIRMED non-US citizenship (FACTS has India): the knock-out stops them
  const known = world();
  await known.turn("apply to all of them", ["good", "clearance", "unknown"]);
  assert.deepEqual(queuedKeys(known.wants), [RECS.good.url]);
  // An unconfirmed value is no fact.
  assert.equal(screenFactsFrom([{ key: "citizenship", value: "India", needs_confirmation: true }]).citizenship, undefined);
});

Deno.test("D-MS-3 and NO LIMITS: another posting at the same employer passes; 300 postings are screened with no cap", () => {
  const g = gatePicks([RECS.good, RECS.samecompany].map((r) => ({ ...r, content: r })), { facts: FACTS, now: NOW });
  assert.equal(g.ok.length, 2);
  const many = Array.from({ length: 300 }, (_, i) => ({ ...rec(1000 + i), content: rec(1000 + i) }));
  assert.equal(gatePicks(many, { facts: FACTS, now: NOW }).ok.length, 300);
});

Deno.test("wired, not just present: every apply path reaches the screen through screenPicks, which calls the gate", () => {
  const read = (p: string) => Deno.readTextFileSync(new URL(`../../supabase/functions/_shared/${p}`, import.meta.url));
  assert(/gatePicks\(passed/.test(read("career_apply_want.ts")), "screenPicks must call gatePicks");
  for (const f of ["career_apply_chat.ts", "agent/career_tools.ts"]) assert(/screenPicks\(/.test(read(f)), `${f} must screen through screenPicks`);
  assert(!/queueWants\([^)]*(?:found|picks)\b/.test(read("career_apply_chat.ts").replace(/screened\.ok/g, "")), "chat must queue only screened picks");
});
