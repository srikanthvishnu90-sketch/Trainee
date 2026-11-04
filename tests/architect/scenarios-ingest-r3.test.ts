// INGEST ROUND 3 (2026-11-03), part 1 of 2: what one read makes of a board's text. Markup, entities and script blocks in
// titles, places, departments and descriptions (stored as the plain text the board meant; a page shows it escaped); posted
// dates in other zones, ahead of the read or from 1970 (kept only when they can be true); pay written with entities (read
// as written; the pay column only from structured fields); "US Remote" / "Remote (PST)" / "3 Locations" / "Remote - IN";
// RTL, CJK and bidi controls. Scenarios and checks: tests/architect/scenarios/ingest-r3-generator.ts. Part 2
// (scenarios-ingest-r3-2.test.ts): paging, empty lists, reused ids, migrations, large boards. On Postgres:
// tests/architect/ingest-r3-pg.test.ts. Seeded, fakes at every boundary: no database, no network, no model.
import { COUNTS, eq, generate, grade, runDates, runMarkup, runPay, runPlace, runUnicode } from "./scenarios/ingest-r3-generator.ts";
import { sameJob } from "../../supabase/functions/_shared/posting_text.ts";

const ALL = generate();
Deno.test({ name: `ingest r3, markup, entities and scripts in every text field, stored as plain text, shown escaped: ${COUNTS.markup} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("markup", ALL.markup, runMarkup); } });
Deno.test({ name: `ingest r3, posted dates (zones, date only, ahead of the read, 1970, garbage, Workday's age read on a later day): ${COUNTS.dates} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("dates", ALL.dates, runDates); } });
Deno.test({ name: `ingest r3, pay written with entities in a description; the pay column only from structured fields: ${COUNTS.pay} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("pay", ALL.pay, runPay); } });
Deno.test({ name: `ingest r3, places (US Remote / Remote - US, time zone only, N Locations, a code two places share): ${COUNTS.place} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("place", ALL.place, runPlace); } });
Deno.test({ name: `ingest r3, RTL, CJK, emoji and bidi controls in titles: ${COUNTS.unicode} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("unicode", ALL.unicode, runUnicode); } });

// One job edited or another job under the same id: labelled pairs (the rule ingest uses to never merge two jobs).
const SAME: [string, string][] = [
  ["Senior Software Engineer", "Software Engineer, Payments"], ["Registered Nurse - ICU", "Registered Nurse - ICU (Nights)"], ["Registered Nurse - ICU", "Registered Nurse - ER"],
  ["Data Analyst", "Senior Data Analyst II"], ["Barista", "Barista (Part-Time)"], ["Product Manager", "Product Manager — Growth"], ["Store Associate", "STORE ASSOCIATE"],
  ["<b>Pharmacy Technician</b>", "Pharmacy Technician"], ["Werkstudent (m/w/d) Vertrieb", "Werkstudent Vertrieb"], ["מהנדס תוכנה", "מהנדס תוכנה בכיר"], ["Nurse", "Nurses"],
  ["Customer Success Manager", "Customer Success Manager, Enterprise"], ["Line Cook", "Line Cook - Weekends"], ["Lead", "Senior"], ["12345", "Data Analyst"],
];
const OTHER: [string, string][] = [
  ["Registered Nurse", "Accountant"], ["Software Engineer", "Civil Engineer"], ["Barista", "Shift Supervisor"], ["Data Analyst", "Forklift Operator"], ["Sales Associate", "Store Associate"],
  ["Pharmacy Technician", "Dental Hygienist"], ["Product Manager", "Line Cook"], ["مهندس برمجيات", "محاسب"], ["Head of Sales", "Head of Marketing"], ["Software Engineering Intern", "Marketing Intern"],
];
Deno.test("ingest r3: one job edited, or the id given to another job (labelled pairs)", () => {
  for (const [a, b] of SAME) eq([a, b, sameJob(a, b), sameJob(b, a)], [a, b, true, true], "one job edited");
  for (const [a, b] of OTHER) eq([a, b, sameJob(a, b), sameJob(b, a)], [a, b, false, false], "another job");
});
Deno.test("ingest r3: the battery is the size it says, deterministic, over 10,000 scenarios", () => {
  const again = generate();
  eq(JSON.stringify(again.markup.slice(0, 40)), JSON.stringify(ALL.markup.slice(0, 40)));
  const total = Object.values(ALL).reduce((a, xs) => a + xs.length, 0);
  eq(total, Object.values(COUNTS).reduce((a, b) => a + b, 0));
  if (total < 10_000) throw new Error(`${total} scenarios`);
});
