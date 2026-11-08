// RELEASE 9 (workstream B): what a posting asks for against what the tailored resume shows, before the file is sent.
//
//   missing    the posting asks for it and no confirmed fact on the record evidences it (123's computeGaps: knockouts,
//              must-have and nice-to-have skills, level). It is left off the resume; nothing is added to cover it.
//   weak       the record evidences it, but the resume shows it thinly: only in the skills line (no entry or bullet shows
//              it in use), or not on this resume at all (a fact that evidences it was not picked for this posting).
//   emphasise  the resume shows it in an entry or bullet: the line it is in, so the person sees where it is.
//
// Inputs are the posting's parsed asks, the person's CONFIRMED record (career_tailor.ts confirmedOnly) and the printed
// resume. Every name here is the posting's own skill word, and every line quoted is a printed line: nothing is invented,
// and a name the record does not evidence is only ever said to be missing.
import { CareerProfile, CareerTailor } from "./router_core.career.js";

export interface GapReport {
  missing: { name: string; required: boolean }[];
  weak: { name: string; why: "skills_line_only" | "not_on_this_resume" }[];
  emphasise: { name: string; line: string }[];
  summary: string;
}
const lc = (s: string) => String(s).toLowerCase();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// deno-lint-ignore no-explicit-any
export function gapAnalysis(o: { jd: any; profile: any; doc: any; gaps: any[] }): GapReport {
  const T = CareerTailor as any;
  const asked: string[] = [...new Set<string>([...(o.jd?.mustHaveSkills || []), ...(o.jd?.niceToHaveSkills || [])])];
  const missing = (o.gaps || []).filter((g: any) => g && g.requirement && g.kind !== "level")
    .map((g: any) => ({ name: String(g.requirement), required: g.gapClass !== "preferred" }));
  const gone = new Set(missing.map((m: { name: string }) => lc(m.name)));
  const lines = ((o.doc?.lines || []) as any[]).filter((l) => l && String(l.text || "").trim());
  const shown = (name: string, pick: (l: any) => boolean) => lines.find((l) => pick(l) && (T.skillsInText(l.text) as string[]).some((s) => lc(s) === lc(name)));
  const onRecord = (name: string) => (CareerProfile.confirmedFacts(o.profile) as any[]).some((f) =>
    (T.skillsInText([f.title, f.text, f.name, ...(f.bullets || []), ...(f.skills || [])].filter(Boolean).join(" ")) as string[]).some((s) => lc(s) === lc(name)));
  const weak: GapReport["weak"] = [], emphasise: GapReport["emphasise"] = [];
  for (const name of asked) {
    if (gone.has(lc(name))) continue;
    const inUse = shown(name, (l) => l.type === "entry" || l.type === "bullet");
    if (inUse) { emphasise.push({ name, line: clip(String(inUse.text), 90) }); continue; }
    if (shown(name, () => true)) weak.push({ name, why: "skills_line_only" });
    else if (onRecord(name)) weak.push({ name, why: "not_on_this_resume" });
  }
  const out: string[] = [];
  if (emphasise.length) out.push(`Shows: ${join(emphasise.map((e) => e.name))}.`);
  const thin = weak.filter((w) => w.why === "skills_line_only").map((w) => w.name), notHere = weak.filter((w) => w.why === "not_on_this_resume").map((w) => w.name);
  if (thin.length) out.push(`Thin: ${join(thin)} (only in your skills line; no bullet shows ${thin.length === 1 ? "it" : "them"} in use).`);
  if (notHere.length) out.push(`On your record but not on this one: ${join(notHere)}.`);
  if (missing.length) out.push(`Not on your record: ${join(missing.map((m: { name: string }) => m.name))} (left off; nothing you confirmed shows ${missing.length === 1 ? "it" : "them"}).`);
  if (!out.length) out.push("The posting names no skill this check reads, so there is nothing to compare.");
  return { missing, weak, emphasise, summary: out.join("\n") };
}

// The top of the resume as it will print, for the chat before the file goes: the first lines, then how many more.
export function previewText(printed: string[], max = 8): string {
  const lines = printed.map((l) => String(l).trim()).filter((l) => l && l !== "•");
  const head = lines.slice(0, max).map((l) => clip(l, 100));
  return lines.length > max ? `${head.join("\n")}\n(${lines.length - max} more lines)` : head.join("\n");
}
