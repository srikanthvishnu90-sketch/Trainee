// NO LIMITS (owner, 2026-10-27 19:55 CDT: "no person limit, never set a limit"; D-MS-2): no reply about applying presents
// a daily application cap as Trainee's own limit on the person. A daily pace the person set themselves may be named as
// theirs ("the daily pace you set yourself"); the older batch path's own count is named as that path's, never as a limit
// on applying. Checked two ways: every text the card answer can produce, and every string literal in the apply reply
// modules (comments stripped). Synthetic only.
import { answerText } from "../../supabase/functions/_shared/career_apply_cards.ts";

const ok = (v: unknown, m: string) => { if (!v) throw new Error(m); };
// A cap stated as Trainee's: "today's (application|daily) limit/cap", "daily (application) cap/limit", "application cap",
// "limit was/is reached" about applications, "N applications a day max".
const CAP = /\btoday'?s (?:daily |application )?(?:limit|cap)\b|\bdaily (?:application )?(?:cap|limit)\b(?! on AI)|\bapplication (?:cap|limit)\b|\b(?:application|daily) limit (?:was|is) (?:already )?(?:reached|used)\b|\bapplications? (?:a|per) day (?:max|maximum|at most)\b/i;

Deno.test("NO LIMITS: no card answer says a daily application cap is Trainee's; the person's own pace is named as theirs", () => {
  const codes = ["queued", "declined", "daily_cap", "company_cooldown", "duplicate", "stale", "changed", "pace_unreadable", "refused", "no_resume", "something_new"];
  for (const declined of [undefined, "left_out", "said_no"] as const) {
    const t = answerText(codes.map((result, i) => ({ n: i + 1, company: `Co ${i + 1}`, result })), declined ? { declined } : {});
    ok(!CAP.test(t), `a card answer states a cap: ${t.match(CAP)?.[0]} in ${t}`);
    ok(/3\. Co 3: not sent: it is over the daily pace you set yourself/.test(t), t);
  }
});

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
const literals = (src: string) => [...strip(src).matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);

Deno.test("NO LIMITS: no reply text in the apply modules or the batch stack states a daily application cap", async () => {
  const files = [
    "supabase/functions/_shared/career_apply_cards.ts",
    "supabase/functions/_shared/career_apply_chat.ts",
    "supabase/functions/_shared/career_apply_want.ts",
    "supabase/functions/_shared/career_apply_from_chat.ts",
    "supabase/functions/_shared/channel_card_tap.ts",
    "packages/domain/155-career-batch-apply.js",
  ];
  // Not replies: the run's own records (a deferred item's `reason`, kept for the audit with 149's exact refusal), which
  // no reply prints (the replies print plainStop(code) and the summary lines below). Excluded by the field they set.
  const RECORD = /\breason:\s*(?:res|out)\.reason \|\||o\.reason = `/;
  const bad: string[] = [];
  for (const f of files) {
    const src = await Deno.readTextFile(new URL(`../../${f}`, import.meta.url));
    for (const line of strip(src).split("\n")) {
      if (RECORD.test(line)) continue;
      for (const lit of literals(line)) if (CAP.test(lit)) bad.push(`${f}: ${lit.slice(0, 160)}`);
    }
  }
  ok(!bad.length, `reply text states a daily application cap:\n${bad.join("\n")}`);
  // The bundles carry the same batch-stack text the source does (the bundle check keeps them equal).
  for (const b of ["supabase/functions/_shared/router_core.career.js", "supabase/functions/_shared/router_core.js"]) {
    const src = await Deno.readTextFile(new URL(`../../${b}`, import.meta.url));
    ok(!/today's application limit was reached|hit today's application cap/.test(src), `${b} still carries the old cap wording`);
  }
});
