// WO-124b/c third review (2026-11-15): meets only by allow-list; day-precision ties; real month names; per-lock-up
// refund timing; refund kinds; sheet and defined names; cohort keys; ICS offsets and real days; capacity minimums.
import * as xlsx from "../../../supabase/functions/_shared/work/xlsx.ts";
import * as ics from "../../../supabase/functions/_shared/work/ics.ts";
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }

Deno.test("124c review 3: only a plain commitment is meets; curly quotes, missing apostrophes and conditions never are", () => {
  const notMeets = ["we don’t sponsor", "we won’t sponsor", "we dont sponsor", "we wont sponsor", "we cant sponsor", "we don`t sponsor",
    "we stopped sponsoring", "we used to sponsor", "we sponsored in the past", "sponsor? nope", "non-sponsored role", "we do n​ot sponsor",
    "will sponsor after 1 year", "once you pass probation", "if you relocate to Canada", "in 2028", "for 6 months then stop",
    "yes (for seniors)", "yes - for seniors", "yes, for US-based staff", "we provide sponsorship to citizens", "exclusively for citizens",
    "candidates with a green card", "available to existing employees", "sponsor H-1B transfers", "pending legal review", "pending approval", "conditions apply"];
  for (const s of notMeets) assert(triage.classify(s) !== "meets", `not meets: ${s}`);
  for (const s of ["we don’t sponsor", "we dont sponsor", "we stopped sponsoring", "sponsor? nope"]) eq(triage.classify(s), "conflict", s);
  for (const s of ["we sponsor, no questions asked", "no problem, we sponsor", "we sponsor without exception", "nothing stops us from sponsoring", "we never refuse sponsorship"]) {
    assert(triage.classify(s) !== "conflict", `a positive idiom is never conflict: ${s}`);
  }
  for (const s of ["yes", "we sponsor visas", "sponsors visas", "sponsorship is available", "We do sponsor visas."]) eq(triage.classify(s), "meets", s);
  const L = [{ id: "s", text: "needs sponsorship", kind: "hard" }];
  eq(triage.rank([{ id: "J", verdicts: triage.verdict(L, [{ source: "x", date: "2026-11-10", says: { s: "We don’t sponsor visas." } }]) }]).actionable, [], "never actionable");
});

Deno.test("124c review 3: a date-only and a timed source on the same day are unordered; only real month names are dates", () => {
  const L = [{ id: "s", text: "needs sponsorship", kind: "hard" }];
  eq(triage.verdict(L, [{ source: "ad", date: "2026-11-10", says: { s: "we do not sponsor" } }, { source: "mail", date: "2026-11-10T08:00:00Z", says: { s: "we sponsor visas" } }]).s, "unknown", "same day, one untimed");
  eq(triage.verdict(L, [{ source: "a", date: "2026-11-10T07:00:00Z", says: { s: "we do not sponsor" } }, { source: "b", date: "2026-11-10T08:00:00Z", says: { s: "we sponsor visas" } }]).s, "meets", "two timed sources are ordered");
  for (const d of ["Decade 1, 2026", "Junk 10, 2026", "Mayday 10, 2026", "2026-11-10T09:00:00"]) eq(triage.dateOf(d), null, `${d} is undated`);
  eq(triage.dateOf("Sept 3, 2026"), Date.UTC(2026, 8, 3), "Sept is a month");
});

Deno.test("124c review 3: refunds are matched to lock-ups one by one; refunds under another name are refused", () => {
  const a = cashflow.run({ start: 2000, events: [
    { day: 1, amount: -1000, kind: "deposit_lockup", refundableDay: 10 }, { day: 2, amount: -100, kind: "deposit_lockup", refundableDay: 2 },
    { day: 3, amount: 1000, kind: "deposit_refund" }] });
  assert(a.findings.some((f) => /refundable day/.test(f)), `only 100 was refundable by day 3: ${a.findings}`);
  const b = cashflow.run({ start: 2000, events: [
    { day: 1, amount: -1000, kind: "deposit_lockup", refundableDay: 5 }, { day: 5, amount: 1000, kind: "deposit_refund" },
    { day: 6, amount: -1000, kind: "deposit_lockup", refundableDay: 20 }, { day: 7, amount: 1000, kind: "deposit_refund" }] });
  assert(b.findings.some((f) => /refundable day/.test(f)), `the second refund is early: ${b.findings}`);
  eq(cashflow.run({ start: 0, events: [{ day: 1, amount: -500, kind: "deposit_lockup", refundableDay: 3 }, { day: 3, amount: 500, kind: "deposit_refund" }] }).findings, [], "on time is clean");
  throws(() => cashflow.run({ start: 0, events: [{ day: 1, amount: 5000, kind: "refund" }] }), "a refund not named deposit_refund");
  throws(() => cashflow.run({ start: 0, events: [{ day: 1, amount: 5, kind: undefined as unknown as string }] }), "no kind");
  throws(() => cashflow.run({ start: 0, events: [{ day: 1, amount: 1e308, kind: "stipend" }, { day: 2, amount: 1e308, kind: "stipend" }] }), "overflow");
});

Deno.test("124b review 3: sheet names, defined names and cohort keys Excel or the checks would break are refused", () => {
  for (const n of ["", "x".repeat(32), "a:b", "a/b", "a?b", "a*b", "a[b]", "History", "'quoted'", "ctl\u0001"]) throws(() => xlsx.checkSheetName(n), `sheet ${JSON.stringify(n)}`);
  xlsx.checkSheetName("Metrics");
  for (const n of ["A1", "1abc", "has space", "R1C1"]) throws(() => xlsx.checkDefinedName(n), `name ${n}`);
  xlsx.checkDefinedName("net_cash");
  const row = (cohort: string) => ({ cohort, acquired: 10, activated: 5, retained: 2, spend: 100 });
  throws(() => xlsx.cohortWorkbook({ rows: [row("P"), row("P")], mature: () => true }), "a repeated cohort");
  throws(() => xlsx.cohortWorkbook({ rows: [row("baseline")], mature: () => true }), "the reserved name");
});

Deno.test("124c review 3: ICS times carry an offset; offsetOn refuses days that do not exist; capacity refuses sub-minute tasks", () => {
  throws(() => ics.utc("2026-11-10T09:00:00"), "a time with no offset");
  eq(ics.utc("2026-11-10T09:00:00Z"), "20261110T090000Z", "Z is fine");
  throws(() => ics.offsetOn("America/New_York", "2026-02-30"), "Feb 30");
  throws(() => capacity.solve({ days: [{ d: 1, hours: 4 }], tasks: [{ id: "T", hours: 1e-12, due: 1 }] }), "a task too small to plan");
  eq(capacity.solve({ days: [{ d: 1, hours: 4 }], tasks: [{ id: "T", hours: 4.0000000005, due: 1 }] }).feasible, false, "over capacity by any real amount");
});
