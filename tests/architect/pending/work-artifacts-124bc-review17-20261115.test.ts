// WO-124c seventeenth review (2026-11-15, FIT with non-blocking notes): lintIcs reads component names case-insensitively,
// flags DTEND not after DTSTART and duplicate UIDs; writeIcs refuses an event that is zero length once written in seconds.
import { lintIcs, writeIcs } from "../../../supabase/functions/_shared/work/ics.ts";

function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }
const ok = { uid: "a@t", start: "2026-11-20T10:00:00Z", end: "2026-11-20T11:00:00Z", summary: "Hold" };
const NOW = { now: "2026-11-15T00:00:00Z" };
const has = (f: string[], s: string, m: string) => { if (!f.some((x) => x.includes(s))) throw new Error(`${m}: ${JSON.stringify(f)}`); };

Deno.test("124c review 17: VALARM is refused in any case and with trailing blanks", () => {
  const base = writeIcs([ok], NOW);
  for (const v of ["begin:valarm", "BEGIN:VALARM ", "Begin:VAlarm"]) {
    const t = base.replace("END:VEVENT", `${v}\r\nACTION:DISPLAY\r\nend:valarm\r\nEND:VEVENT`);
    has(lintIcs(t), "VALARM", v);
  }
});

Deno.test("124c review 17: a sub-second event that writes as zero length is refused", () => {
  throws(() => writeIcs([{ ...ok, start: "2026-11-20T10:00:00.4Z", end: "2026-11-20T10:00:00.6Z" }], NOW), "same second");
  if (lintIcs(writeIcs([ok], NOW)).length) throw new Error("clean hold must lint clean");
});

Deno.test("124c review 17: reversed times and duplicate UIDs are lint findings", () => {
  const rev = writeIcs([ok], NOW).replace("DTSTART:20261120T100000Z", "DTSTART:20261120T120000Z");
  has(lintIcs(rev), "DTEND is not after DTSTART", "reversed");
  has(lintIcs(writeIcs([ok, { ...ok }], NOW)), "duplicate UID", "duplicate");
});
