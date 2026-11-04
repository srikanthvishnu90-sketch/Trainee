// The research battery's oracles, shared by the pure run (tests/architect/scenarios-research.test.ts) and the Postgres run
// (tests/architect/flow-scenarios-research.test.ts): what a company answer may say, judged independently of the product.
import { type AskCase, subjectViolation } from "./research-generator.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;
// ------------------------------------------------------------------------------------------------ the sources on file
// Every number the product holds: the company files and the career library (packages/career-data), as written.
async function sourceNumbers(): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (/\.(json|jsonl|md|txt)$/.test(e.name)) for (const n of numbersOf(await Deno.readTextFile(p))) out.add(n);
    }
  };
  await walk(`${ROOT}packages/career-data`);
  return out;
}
export const numbersOf = (t: string) => (String(t).replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map((x) => x.replace(/\.0+$/, ""));
export const SOURCE_NUMBERS = await sourceNumbers();
// A number a reply states that no source holds (counts up to ten and the turn's own date are the product's arithmetic).
export function unsourcedNumbers(reply: string, input: string): string[] {
  const own = new Set(numbersOf(input));
  return numbersOf(reply).filter((n) => !(Number(n) <= 10 && Number.isInteger(Number(n))) && !own.has(n) && !SOURCE_NUMBERS.has(n) && !["2026", "29", "10", "2026-10-29"].includes(n));
}

const PLAINLY = /\bthe file says\b|\bholds no\b|\bno source on record gives\b|\bI give no number\b|\bnot giving one\b|\bhas no company file\b|\bcannot give you that number\b|\bno (?:compensation|pay) figure\b|\bno verified\b|\bnot something any source\b|\bnot published\b|\bno .{0,40}figure is (?:stated|published)\b|\brather than a pay figure\b/i;
export function turnViolations(c: AskCase, reply: string, intent: string): string[] {
  const out: string[] = [];
  const v = subjectViolation(c.input, reply);
  if (v) out.push(v);
  const nums = unsourcedNumbers(reply, c.input);
  if (nums.length) out.push(`numbers no source holds: ${nums.join(", ")}`);
  // A figure the file never holds, asked about a firm with a file: said plainly.
  if (intent === "company_intel" && c.expect && c.figure && c.figure !== "pay" && !PLAINLY.test(reply)) out.push(`the ${c.figure} figure is not on record, and the reply does not say so`);
  return out;
}
