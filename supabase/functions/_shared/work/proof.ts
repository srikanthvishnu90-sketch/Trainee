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
  { cat: "tests", says: /\btests?\b.*\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ran clean|run clean|all good)\b|\bpass(?:es|ed)?\b.*\btests?\b|\b(?:code|script|bundle)\b.*\b(?:works|runs (?:clean|fine|correctly))\b/i },
  { cat: "recompute", says: /\bre-?(?:comput|calculat|calc|evaluat)\w*|\b(?:formulas?|totals?|figures|numbers|math|sums?)\b.*\b(?:check(?:s|ed)? out|add(?:s)? up|correct|tie out|match(?:es)?|verified)\b/i },
  { cat: "pages", says: /\bfits?\b.*\bpages?\b|\b(?:one|single|1)[- ]page\b|\bno (?:clipping|overflow)\b|\bnothing (?:is )?(?:clipped|cut off)\b/i },
  { cat: "lint", says: /\bno (?:errors?|issues|problems|warnings)\b|\berror[- ]free\b|\bwithout (?:any )?errors?\b|\blints? clean\b|\b(?:valid|well-formed) (?:ics|calendar|file)\b/i },
  { cat: "counts", says: /\b(?:under|within|below|at most|fits?)\b.*\b(?:words?|characters?|chars?|limit|minutes?|seconds?)\b/i },
  { cat: "revoke", says: /\b(?:removed|gone|scrubbed|no trace)\b.*\b(?:everywhere|every(?:where| part| file)|metadata|all files)\b|\bno (?:trace|mention) of\b/i },
  { cat: "invariants", says: /\b(?:baseline|everything else|other (?:rows|cells|figures))\b.*\bunchanged\b|\binvariants?\b/i },
  { cat: "generic", says: /\b(?:all|every) checks?\b|\beverything\b.*\b(?:checks? out|passed|verified|works)\b|\b(?:verif(?:y|ied|ies)|validated|double[- ]checked|checks? out|checked out|confirmed correct|fully tested|tested)\b/i },
];

// Clauses split at sentence ends, semicolons, commas that end a phrase, and "and"/"but".
function clauses(reply: string): string[] {
  return reply.split(/[.!?;]+(?=\s|$)|,\s+|\s+(?:and|but)\s+/i).map((s) => s.trim()).filter(Boolean);
}

// D8, fail closed. A clause that claims a category is backed only when that category has a check that ran and passed,
// none that failed, and (when the clause says all/every) none that did not run. A generic claim is backed only when
// the report shows at least one check run, every check ok, and no check not run. A clause may claim several things;
// the first unbacked claim refuses it.
export function boundClaims(reply: string, rep: string): { refused: string[]; ok: boolean } {
  const checks = parseReport(rep).map((c) => ({ ...c, cat: categoryOf(c.name) }));
  const refused: string[] = [];
  for (const clause of clauses(reply)) {
    const all = /\b(?:all|every|each|fully)\b/i.test(clause);
    const claimed = CLAIMS.filter((k) => k.says.test(clause)).map((k) => k.cat);
    // A specific claim settles the clause; "generic" counts only when no specific category was named.
    const cats = claimed.some((c) => c !== "generic") ? claimed.filter((c) => c !== "generic") : claimed;
    for (const cat of cats) {
      const backing = cat === "generic" ? checks : checks.filter((c) => c.cat === cat);
      const backed = cat === "generic"
        ? backing.length > 0 && backing.every((c) => c.status === "ok")
        : backing.some((c) => c.status === "ok") && !backing.some((c) => c.status === "failed") &&
          !(all && backing.some((c) => c.status === "not run"));
      if (!backed) { refused.push(clause); break; }
    }
  }
  return { refused, ok: refused.length === 0 };
}
