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

// Each kind of claim: how a reply says it, and which checks in the report can back it.
const CLAIMS: { kind: string; says: RegExp; backedBy: RegExp | null }[] = [
  { kind: "tests", says: /\btests?\b.*\b(pass(es|ed|ing)?|green|succeed(s|ed)?|ran clean)\b|\bpass(es|ed)?\b.*\btests?\b/i, backedBy: /\btests?\b/ },
  { kind: "recomputed", says: /\bre-?(comput|calculat|calc|evaluat)\w*/i, backedBy: /\bre-?(comput|calculat|calc|evaluat)|\bevaluat|\bindependent/ },
  { kind: "one page", says: /\bfits?\b.*\bpages?\b|\b(one|single|1)[- ]page\b|\bno (clipping|overflow)\b/i, backedBy: /\bpages?\b|\bclip/ },
  { kind: "no errors", says: /\bno (errors?|issues|problems|warnings)\b|\berror[- ]free\b|\bwithout (any )?errors?\b|\blints? clean\b/i, backedBy: /\berrors?\b|\blint/ },
  { kind: "verified", says: /\b(verif(y|ied|ies)|validated|double[- ]checked|checks? out|checked out|confirmed correct)\b/i, backedBy: null },
];
const STOP = new Set(["the", "and", "all", "are", "was", "has", "its", "that", "this", "they", "them", "with", "were", "have", "been", "every", "from", "into", "each", "checks", "check", "checked", "verified", "validated", "match", "matches", "correct"]);
const words = (s: string) => (s.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w));

// Clauses split at sentence ends, semicolons, commas that end a phrase, and "and"/"but".
function clauses(reply: string): string[] {
  return reply.split(/[.!?;]+(?=\s|$)|,\s+|\s+(?:and|but)\s+/i).map((s) => s.trim()).filter(Boolean);
}

export function boundClaims(reply: string, rep: string): { refused: string[]; ok: boolean } {
  const checks = parseReport(rep);
  const refused: string[] = [];
  for (const clause of clauses(reply)) {
    for (const claim of CLAIMS) {
      if (!claim.says.test(clause)) continue;
      // A generic "verified" is backed only by a check about the same thing (sharing a content word).
      const cw = words(clause);
      const backing = checks.filter((c) => claim.backedBy ? claim.backedBy.test(c.name) : words(c.name).some((w) => cw.includes(w)));
      const all = /\b(all|every|each)\b/i.test(clause);
      const backed = backing.some((c) => c.status === "ok") && !backing.some((c) => c.status === "failed") &&
        !(all && backing.some((c) => c.status === "not run"));
      if (!backed) { refused.push(clause); break; }
    }
  }
  return { refused, ok: refused.length === 0 };
}
