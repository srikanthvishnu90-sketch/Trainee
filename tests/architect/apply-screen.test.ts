// COMPETITIVE-BAR G1 / B6: the posting screen before a batch. include (with why, from confirmed facts only) | exclude
// (plain reason) | needs_fact (asked once per batch). No volume cap: a 20,000-posting batch is screened in one pass.
import assert, { deepStrictEqual as assertEquals } from "node:assert/strict";
import { screenBatch, screenPosting, type ScreenFacts } from "../../supabase/functions/_shared/career_apply_screen.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86400000).toISOString();
const facts: ScreenFacts = {
  location: { value: "Austin, TX", confirmed: true },
  relocation: { value: "no", confirmed: true },
  sponsorship: { value: "Yes", confirmed: true }, // needs sponsorship
  years_experience: { value: 2, confirmed: true },
  education_level: { value: "bachelor", confirmed: true },
  skills: { value: ["Python", "SQL", "React"], confirmed: true },
};
const gh = (id: number, extra: Record<string, unknown> = {}) => ({
  job_id: `greenhouse:acme:${id}`, url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, company: "Acme", title: "Data Analyst",
  location: "Austin, TX", description: "We use Python and SQL every day. 1+ years of experience.", posted_at: day(3), ...extra,
});

Deno.test("include: why-line names only confirmed facts", () => {
  const s = screenPosting("u1", gh(1), facts, { now: NOW });
  assertEquals(s.verdict, "include");
  if (s.verdict !== "include") return;
  assert(/Python and SQL/.test(s.why), s.why);
  assert(!/React/.test(s.why), "React is not in the posting");
  // An unconfirmed skill never appears.
  const s2 = screenPosting("u1", gh(1), { ...facts, skills: { value: ["Python"], confirmed: false } }, { now: NOW });
  assert(s2.verdict === "include" && !/Python/.test(s2.why), JSON.stringify(s2));
});

Deno.test("exclude: each knock-out, in plain words", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ closed_at: day(1) }, "closed"],
    [{ posted_at: day(90) }, "stale"],
    [{ description: "Work from home! A $50 training fee is due before your first day. Interview on Telegram." }, "scam"],
    [{ location: "Denver, CO" }, "location"],
    [{ location: "Remote - Canada" }, "location"],
    [{ description: "We are unable to sponsor visas for this role. Python." }, "sponsorship"],
    [{ description: "Minimum of 7 years of experience in analytics." }, "years"],
    [{ description: "A Master's degree in Statistics is required." }, "degree"],
  ];
  for (const [extra, reason] of cases) {
    const s = screenPosting("u1", gh(2, extra), facts, { now: NOW });
    assertEquals(s.verdict === "exclude" ? s.reason : s.verdict, reason, JSON.stringify(extra));
    assert(s.verdict === "exclude" && !/[a-z]+_[a-z]+/.test(s.why), `no internal codes: ${JSON.stringify(s)}`);
  }
  // "or equivalent experience" and "preferred" are not knock-outs.
  const soft = screenPosting("u1", gh(3, { description: "Master's degree required, or equivalent experience. 8+ years preferred." }), facts, { now: NOW });
  assertEquals(soft.verdict, "include");
});

Deno.test("already applied to this exact posting, by any link; duplicates in a batch screened once", () => {
  const applied = ["greenhouse:acme:5"];
  const viaEmbed = gh(5, { job_id: "agg-123", url: "https://aggregator.example/jobs/agg-123", apply_url: "https://boards.greenhouse.io/acme/jobs/5" });
  const s = screenPosting("u1", viaEmbed, facts, { now: NOW, applied });
  assertEquals(s.verdict === "exclude" && s.reason, "already_applied");
  // Same company, other posting: never blocked (no per-company cooldown, D-MS-3).
  assertEquals(screenPosting("u1", gh(6), facts, { now: NOW, applied }).verdict, "include");
  const b = screenBatch("u1", [gh(7), gh(7, { job_id: "mirror", url: "https://aggregator.example/x", apply_url: "https://job-boards.greenhouse.io/acme/jobs/7" })], facts, { now: NOW });
  assertEquals([b.counts.include, b.counts.by_reason.duplicate_in_batch], [1, 1]);
});

Deno.test("needs_fact: an unconfirmed knock-out fact is asked once per batch, never guessed", () => {
  const draft: ScreenFacts = { ...facts, sponsorship: { value: "Yes", confirmed: false } };
  const ps = [1, 2, 3].map((i) => gh(10 + i, { description: "Python. We do not provide visa sponsorship." }));
  const b = screenBatch("u1", ps, draft, { now: NOW });
  assertEquals(b.counts.needs_fact, 3);
  assertEquals(b.asks.length, 1);
  assertEquals(b.asks[0].fact, "sponsorship");
  assertEquals(b.asks[0].keys.length, 3);
  assertEquals(screenBatch("u1", ps, draft, { now: NOW, alreadyAsked: ["sponsorship"] }).asks.length, 0);
});

Deno.test("no volume cap: 20,000 postings screened in one pass, every fit included", () => {
  const ps = Array.from({ length: 20000 }, (_, i) => gh(100000 + i));
  const t = performance.now();
  const b = screenBatch("u1", ps, facts, { now: NOW });
  const ms = performance.now() - t;
  assertEquals(b.counts.include, 20000);
  assert(ms < 15000, `took ${ms} ms`);
});
