// WO-124a: proof and limits written by code (spec D8, D2, D-024). The report lists each check run with its result,
// each check not run with the reason, and the remaining limits. boundClaims refuses any clause of a reply that claims a
// check the report does not show as run and passed.

export interface Check { name: string; ran: boolean; ok?: boolean; why?: string }

const one = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

export function report(checks: Check[], limits: string[]): string {
  const ran = checks.filter((c) => c.ran), notRun = checks.filter((c) => !c.ran);
  const lines = ["Checks run:"];
  if (!ran.length) lines.push("- none");
  for (const c of ran) lines.push(`- ${c.ok === true ? "ok" : "failed"}: ${one(c.name)}${c.why ? ` (${one(c.why)})` : ""}`);
  lines.push("Checks not run:");
  if (!notRun.length) lines.push("- none");
  for (const c of notRun) lines.push(`- not run: ${one(c.name)}${c.why ? ` (${one(c.why)})` : ""}`);
  lines.push("Limits:");
  if (!limits.length) lines.push("- none recorded");
  for (const l of limits) lines.push(`- ${one(l)}`);
  return lines.join("\n");
}

type Status = "ok" | "failed" | "not run";
function parseReport(r: string): { name: string; status: Status }[] {
  const out: { name: string; status: Status }[] = [];
  for (const line of r.split("\n")) {
    const m = line.match(/^- (ok|failed|not run): (.+?)(?: \(.*\))?$/);
    if (m) out.push({ status: m[1] as Status, name: m[2].toLowerCase() });
  }
  return out;
}

// Each check in the report belongs to one named category, read from its name. A name that fits no category is "other":
// it can back only a whole-report claim, never a specific one. Categories are narrow on purpose (review of WO-124a:
// "Tests pass." must not be backed by "test fixture loaded", which shares a word but is not a test run).
export type Category = "tests" | "recompute" | "pages" | "lint" | "counts" | "revoke" | "invariants" | "mutants" | "other";
const CATEGORY_OF: [Category, RegExp][] = [
  ["mutants", /\bmutants?\b|\bmutation\b/i],
  ["tests", /\b(?:unit |integration )?tests? (?:run|ran|executed|passed|pass)\b|\b(?:run|ran|execut\w*) (?:the |all |its )?(?:unit )?tests?\b|\btest suite\b/i],
  ["recompute", /\bre-?(?:comput|calculat|calc|evaluat)\w*|\bformulas?\b.*\b(?:evaluat|comput)\w*|\bindependent(?:ly)? (?:evaluat|comput)\w*/i],
  ["pages", /\bclip\w*|\bpages?\b.*\b(?:render\w*|count\w*|fit\w*|check\w*)|\brender\w*\b.*\bpages?\b/i],
  ["lint", /\blint\w*/i],
  ["counts", /\b(?:word|character|char|speaking)[- ]?(?:counts?|time|length)\b|\bcounts? computed\b/i],
  ["revoke", /\brevoke\w*\b.*\bscan\w*|\bscan\w*\b.*\brevoke\w*/i],
  ["invariants", /\binvariants?\b/i],
];
export function categoryOf(name: string): Category {
  for (const [c, re] of CATEGORY_OF) if (re.test(name)) return c;
  return "other";
}

// How a reply claims each category. "generic" is a claim about the work as a whole ("all checks passed", "verified").
const CLAIMS: { cat: Category | "generic"; says: RegExp }[] = [
  { cat: "mutants", says: /\bmutants?\b|\bmutation\b/i },
  { cat: "tests", says: /\b(?:tests?|specs?|suites?|pytest|jest|unit tests?|ci|builds?)\b.*\b(?:pass(?:es|ed|ing)?|green|ok|okay|succeed(?:s|ed)?|ran clean|run clean|all good|\d+\s*\/\s*\d+)\b|\bpass(?:es|ed)?\b.*\btests?\b|\b(?:it|code|script|bundle|program|function|query)\b.*\b(?:works?|worked|runs?|ran|compiles?|compiled|executes?|executed)\b|\bi (?:ran|executed|tested|compiled) (?:it|the|this|that)\b/i },
  { cat: "recompute", says: /\bre-?(?:comput|calculat|calc|evaluat)\w*|\b(?:formulas?|totals?|figures|numbers|math|sums?)\b.*\b(?:check(?:s|ed)? out|add(?:s)? up|correct|tie out|match(?:es)?|verified)\b/i },
  { cat: "pages", says: /\bfits?\b.*\bpages?\b|\b(?:one|single|1)[- ]page\b|\bno (?:clipping|overflow)\b|\bnothing (?:is )?(?:clipped|cut off)\b/i },
  { cat: "lint", says: /\bno (?:errors?|issues|problems|warnings)\b|\berror[- ]free\b|\bwithout (?:any )?errors?\b|\blints? clean\b|\b(?:valid|well-formed) (?:ics|calendar|file)\b/i },
  { cat: "counts", says: /\b(?:under|within|below|at most|fits?)\b.*\b(?:words?|characters?|chars?|limit|minutes?|seconds?)\b/i },
  { cat: "revoke", says: /\b(?:removed|gone|scrubbed|no trace)\b.*\b(?:everywhere|every(?:where| part| file)|metadata|all files)\b|\bno (?:trace|mention) of\b/i },
  { cat: "invariants", says: /\b(?:baseline|everything else|other (?:rows|cells|figures))\b.*\bunchanged\b|\binvariants?\b/i },
  { cat: "generic", says: /\b(?:all|every) checks?\b|\beverything\b.*\b(?:checks? out|passed|verified|works)\b|\b(?:verif(?:y|ied|ies)|validated|double[- ]checked|checks? out|checked out|confirmed correct|fully tested|tested)\b/i },
];
// Third review of WO-124a: a list of assurance phrasings can never be complete ("Downstream figures stand." passed a
// failed recompute). So boundClaims reads each clause for its SUBJECT and its TONE, and is strict whenever the report is
// not all green:
//  - subject: which check category the clause is about, from the claim patterns above and a subject vocabulary
//    (figures, totals, formulas -> recompute; tests, code, script, n/n -> tests; pages -> pages; ...). A clause that
//    starts with "and"/"but" and names no subject of its own carries the previous clause's subject.
//  - tone: any word an assurance or a verdict is made of (CHECK_VOCAB), broad on purpose.
//  - When every check in the report ran and passed: a clause naming a subject needs that subject's checks in the report
//    (a page claim with no page check is refused); a generic assurance is allowed.
//  - When any check failed or did not run: a clause passes only if it has no check vocabulary at all, or every subject
//    it names has only passing checks, or it plainly reports a check as not run or failed (and holds no negated
//    failure such as "did not fail", which is a success claim).
const SUBJECT: [Category, RegExp][] = [
  ["recompute", /\b(?:formulas?|figures?|numbers?|totals?|sums?|math|maths|calc\w*|comput\w*|recomput\w*|reconcil\w*|tie(?:s|d)? out|ties?|add(?:s)? up|downstream|cells?|values?|amounts?|workbook|spreadsheet)\b/i],
  ["tests", /\b(?:tests?|specs?|suites?|pytest|jest|ci|code|script|bundle|program|build|compiles?|runs?|ran|executes?|executed|\d+\s*(?:\/|of)\s*\d+)\b/i],
  ["pages", /\b(?:pages?|clip\w*|overflow\w*|layout|margins?|cut off)\b/i],
  ["lint", /\b(?:lint\w*|ics|calendar|invite|hold file|well-formed)\b/i],
  ["counts", /\b(?:words?|characters?|chars?|length|limit|minutes?|seconds?|speaking)\b/i],
  ["revoke", /\b(?:revok\w*|removed|scrubbed|redact\w*|no trace|no mention)\b/i],
  ["invariants", /\b(?:baseline|invariants?|unchanged|untouched|same as before)\b/i],
];
const CHECK_VOCAB = /\b(?:works?|worked|working|functional|ok|okay|fine|good|great|perfect|flawless|solid|safe|sound|green|clean|pass\w*|correct\w*|right|accurate|exact\w*|valid\w*|verif\w*|confirm\w*|check\w*|prov(?:en|ed)|test\w*|qa\W?d?|succe\w*|ready|ship\w*|approv\w*|sign(?:ed)? off|all set|good to go|guarantee\w*|sure|certain|stand\w*|holds?|held|match\w*|tie\w*|reconcil\w*|adds? up|in order|discrepanc\w*|mismatch\w*|defect\w*|bugs?|regress\w*|broken|broke|wrong|issues?|problems?|errors?|fail\w*|mistakes?|nothing|none|zero|no)\b|\b\d+\s*(?:\/|of)\s*\d+\b/i;
const HONEST_MISS = /\b(?:not (?:run|tested|checked|verified|confirmed)|were(?:n't| not) (?:run|tested|checked)|(?:did|could)(?:n't| not) (?:run|test|check|verify)|unverified|untested|failed|not yet (?:run|tested))\b/i;
const NEGATED_FAIL = /\b(?:no|not|never|none|nothing|zero|without|didn't|did not|0)\b[^.]{0,20}\bfail\w*|\bfail\w*[^.]{0,12}\b(?:none|zero|nothing)\b/i;

// Clauses split at sentence ends, semicolons, commas that end a phrase, and "and"/"but" (kept as a marker).
function clauses(reply: string): { text: string; joined: boolean }[] {
  const out: { text: string; joined: boolean }[] = [];
  for (const sentence of reply.split(/[.!?;]+(?=\s|$)/)) {
    const parts = sentence.split(/(,\s+|\s+(?:and|but)\s+)/i);
    let joined = false;
    for (const p of parts) {
      if (/^(?:,\s+|\s+(?:and|but)\s+)$/i.test(p)) { joined = /and|but/i.test(p); continue; }
      const t = p.trim();
      if (t) out.push({ text: t, joined });
      joined = false;
    }
  }
  return out;
}

export function boundClaims(reply: string, rep: string): { refused: string[]; ok: boolean } {
  const checks = parseReport(rep).map((c) => ({ ...c, cat: categoryOf(c.name) }));
  const green = checks.length > 0 && checks.every((c) => c.status === "ok");
  const refused: string[] = [];
  let carried: Category[] = [];
  for (const { text: clause, joined } of clauses(reply)) {
    const all = /\b(?:all|every|each|fully)\b/i.test(clause);
    const named = new Set<Category>();
    for (const k of CLAIMS) if (k.cat !== "generic" && k.says.test(clause)) named.add(k.cat as Category);
    for (const [cat, re] of SUBJECT) if (re.test(clause)) named.add(cat);
    let cats = [...named];
    if (!cats.length && joined) cats = carried;
    carried = cats.length ? cats : carried;
    const vocab = CHECK_VOCAB.test(clause) || CLAIMS.some((k) => k.says.test(clause));
    if (!vocab && !cats.length) continue; // says nothing about the work's checks
    const catOk = (cat: Category) => {
      const b = checks.filter((c) => c.cat === cat);
      return b.some((c) => c.status === "ok") && !b.some((c) => c.status === "failed") && !(all && b.some((c) => c.status === "not run"));
    };
    // Honest only if, with the reported miss taken out, nothing else in the clause is a verdict (round 4: "Tests passed
    // while the page check was not run" hid a success claim behind the miss).
    const rest = clause.replace(new RegExp(HONEST_MISS.source, "gi"), " ").replace(/\b(?:the|a|an|check|checks|was|were|is|are|been|here|yet|so|i|have|has|it|this|that|one|two|earlier|on|cells?|page|pages?|tests?|recompute|formulas?|lint|scan|run)\b/gi, " ");
    const honest = HONEST_MISS.test(clause) && !NEGATED_FAIL.test(clause) && !CHECK_VOCAB.test(rest) && !/\b(?:passed|pass|works?|right|correct|fine|good)\b/i.test(clause.replace(new RegExp(HONEST_MISS.source, "gi"), " "));
    if (honest) continue;
    if (!vocab) continue; // a subject named with no verdict ("here is the workbook")
    if (cats.length) { if (!cats.every(catOk)) refused.push(clause); continue; }
    if (!green) refused.push(clause); // a generic assurance while something failed or did not run
  }
  return { refused, ok: refused.length === 0 };
}
