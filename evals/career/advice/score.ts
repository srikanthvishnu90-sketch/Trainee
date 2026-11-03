// The offline scorer for a research brief + chat paragraph. Ten criteria, 0 to 2 each (20 total), the same ten the OpenAI rubric
// judge uses (advice-rubric.md). A brief PASSES only if: total >= 18, zero unsourced specifics, and the chat paragraph lints clean.
// This is a code proxy for the judge (structure, sourcing, field fit, no software default); the judge adds the human read. It is
// deliberately brutal: a missing section, a figure with no [S#], a foreign-field word or a poison string costs points or fails.
import { lintChat } from "../../../supabase/functions/_shared/agent/research/chat.ts";
import { unsourcedIn, specifics } from "../../../supabase/functions/_shared/agent/research/guard.ts";
import type { Fact } from "../../../supabase/functions/_shared/agent/research/ground.ts";

export const CRITERIA = ["honest_read", "staged_timing", "field_fit", "sourced_numbers", "named_only_if_sourced", "networking", "credentials", "data_section", "unverified", "personalized"] as const;
export type Criterion = typeof CRITERIA[number];
export const PASS_TOTAL = 18;
export interface Scored { scores: Record<Criterion, number>; total: number; unsourced: string[]; chat: string[]; pass: boolean; notes: string[] }
export interface ScoreIn { brief: string; chat: string; link: string | null; facts: Fact[]; person: string[]; message: string; must: string[]; foreign?: RegExp; poison: string[]; ask: string | null }

const section = (md: string, head: string) => (md.split(new RegExp(`^## ${head}.*$`, "m"))[1] ?? "").split(/^## /m)[0] ?? "";
const bullets = (s: string) => s.split("\n").filter((l) => /^\s*(?:-|\d+\.)\s+\S/.test(l)).length;
const two = (ok: boolean, half = false) => ok ? 2 : half ? 1 : 0;

export function scoreBrief(i: ScoreIn): Scored {
  const md = i.brief, notes: string[] = [], lower = md.toLowerCase();
  const read = section(md, "Honest read"), path = section(md, "The path"), aim = section(md, "Where to aim"), net = section(md, "Networking"), cred = section(md, "Skills"), data = section(md, "What the data"), unv = section(md, "What I couldn't verify");
  const s = {} as Record<Criterion, number>;
  s.honest_read = two(/\*\*Realistic now\.\*\*\s+\S/.test(read) && /\*\*Realistic later\.\*\*\s+\S/.test(read), /Realistic (?:now|later)/.test(read));
  const stages = (path.match(/^\*\*[^*]+\*\*$/gm) ?? []).length;
  s.staged_timing = two(stages >= 3 && bullets(path) >= 4, stages >= 2);
  const hits = i.must.filter((m) => lower.includes(m.toLowerCase())), miss = i.must.filter((m) => !lower.includes(m.toLowerCase()));
  const foreign = i.foreign && i.foreign.test(md);
  s.field_fit = foreign ? 0 : two(miss.length === 0, hits.length >= Math.ceil(i.must.length / 2));
  if (miss.length) notes.push(`field terms missing: ${miss.join(", ")}`);
  if (foreign) notes.push("software-default words in a non-software brief");
  const numFacts = i.facts.filter((f) => specifics(f.text).numbers.length);
  const cited = numFacts.every((f) => md.includes(f.text) && new RegExp(`${f.text.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\[S\\d+, [^\\]]+\\]`).test(md));
  const unsourced = unsourcedIn(md, { facts: i.facts, person: i.person, message: i.message });
  s.sourced_numbers = unsourced.length ? 0 : two(cited);
  const poisoned = i.poison.filter((p) => md.includes(p) || i.chat.includes(p));
  if (poisoned.length) notes.push(`poison present: ${poisoned.join(", ")}`);
  const namedOk = !poisoned.length && unsourcedIn(aim, { facts: i.facts, person: i.person, message: i.message }).length === 0;
  s.named_only_if_sourced = namedOk ? 2 : 0;
  const netOk = [/fifteen-minute/, /Who to talk to/, /first message/, /What to ask/, /Afterward/, /not a job/].filter((r) => r.test(net)).length;
  s.networking = netOk === 6 && !/\b(?:Mr|Ms|Dr)\.|\bDear [A-Z]/.test(net) ? 2 : netOk >= 4 ? 1 : 0;
  s.credentials = two(bullets(cred) >= 3, bullets(cred) >= 1);
  s.data_section = two(i.facts.length ? numFacts.every((f) => data.includes(f.text) || md.includes(f.text)) && /\[S\d+/.test(data) : /quoting none/.test(data));
  s.unverified = two(bullets(unv) >= 4, bullets(unv) >= 2);
  const personal = i.person.some((p) => p && md.includes(p.slice(0, 20))) || /Assuming|Assumption/.test(md) || !i.person.length;
  s.personalized = two(personal && /Written for/.test(md) && (i.ask ? i.ask.split("?").length <= 2 : true), personal);
  const total = CRITERIA.reduce((a, c) => a + s[c], 0);
  const chat = lintChat(i.chat, { link: i.link, facts: i.facts, person: i.person, message: i.message });
  const pass = total >= PASS_TOTAL && CRITERIA.every((c) => s[c] > 0) && unsourced.length === 0 && chat.length === 0 && !poisoned.length;
  return { scores: s, total, unsourced, chat, pass, notes };
}
export function table(rows: { id: string; r: Scored }[]): string {
  const head = ["persona".padEnd(24), ...CRITERIA.map((c) => c.slice(0, 7).padEnd(8)), "total", "unsrc", "chat", "PASS"].join(" ");
  const lines = rows.map(({ id, r }) => [id.padEnd(24), ...CRITERIA.map((c) => String(r.scores[c]).padEnd(8)), String(r.total).padEnd(5), String(r.unsourced.length).padEnd(5), String(r.chat.length).padEnd(4), r.pass ? "yes" : "NO"].join(" "));
  const mean = CRITERIA.map((c) => (rows.reduce((a, x) => a + x.r.scores[c], 0) / rows.length).toFixed(2).padEnd(8));
  return [head, ...lines, ["MEAN".padEnd(24), ...mean].join(" ")].join("\n");
}
