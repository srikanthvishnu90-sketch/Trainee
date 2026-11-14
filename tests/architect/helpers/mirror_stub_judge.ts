// The mirror test's stub support judge (architect amendments, owner decision 2026-11-13: research support check switched on).
import { supportsClaim } from "../support-test-judge.ts";
import { C4_ANSWER } from "./mirror_wa_script.ts";
// Architect amendment (ruling 2026-11-14 on 69ad43a79): a scripted-truth table, like group B's pageTruthJudge. C4's two advice
// sentences are recorded as supported by the joint guide and record passage (the real judge reads the paraphrase "a compact skills
// line" for the guide's "a short technical skills section"; this stub reads words only). Every other claim keeps the word rule below.
export const SCRIPTED_TRUE = new Set(C4_ANSWER.replace("your SWE resume", "your resume").split(/(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim()));
// Architect amendment (owner decision 2026-11-13: research support check switched on; architect ruling 2026-11-14 on 5e7b9fa95): this
// test's stub judge reads an advice sentence's fixed instruction words (its leading imperative verb, and leave/keep/move/put/cut/drop/
// remove/list/lead, off/out/in/up/first/top/above/below, outdated/old/current) as needing no support; every other word of the sentence
// must still be in the one source passage it is judged against (support-test-judge.ts supportsClaim); the joint passage (the guide and
// the record) is read whole, with no role joined to another line's employer. The product is unchanged.
const INSTRUCTION_WORDS = /(?<![\p{L}])(?:leave|keep|move|put|cut|drop|remove|list|lead|off|out|in|up|first|top|above|below|outdated|old|current)(?![\p{L}])/giu;
export const mirrorJudgeAnswer = (user: string) => {
  let items: { claim: string; source: string }[] = [];
  try { items = JSON.parse(user); } catch { /* empty */ }
  return JSON.stringify(items.map((x) => { if (SCRIPTED_TRUE.has(String(x.claim ?? "").trim())) return "yes";
    const c = String(x.claim ?? ""), lead = /^\s*([\p{L}]+)/u.exec(c)?.[1] ?? "";
    const rest = /^The marked text "/.test(c) ? c : c.replace(new RegExp(`^\\s*${lead}\\b`, "u"), "").replace(INSTRUCTION_WORDS, " ");
    const src = String(x.source ?? ""), m = /^>>> (.*) <<<$/m.exec(src)?.[1] ?? "";
    // The joint passage (the cited guide and the person's record, a fact per line): every word in the guide or the record, and no
    // role joined to an employer from another line ("Software engineering intern at Stripe").
    if (/^Two passages, read together/.test(src)) {
      const lines = src.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      const joined = src.replace(`>>> ${m} <<<`, `>>> ${m} ${lines.join(" ")} <<<`);
      const at = /([\p{L}][\p{L} -]*?)\s+at\s+(\p{Lu}[\p{L}&.-]*(?:\s\p{Lu}[\p{L}&.-]*)*)/u.exec(rest);
      const sameLine = !at || lines.some((l) => l.includes(at[2]) && at[1].trim().split(/\s+/).slice(-3).every((w) => l.toLowerCase().includes(w.toLowerCase())));
      return sameLine && supportsClaim(rest, joined) ? "yes" : "no";
    }
    // A record passage (its facts apart by " | ") is read line by line: a sentence must be stated by one fact, never two recombined.
    const lines = m.includes(" | ") ? m.split(" | ").map((l) => src.replace(`>>> ${m} <<<`, `>>> ${l} <<<`)) : [src];
    return lines.some((l) => supportsClaim(rest, l)) ? "yes" : "no"; }));
};

