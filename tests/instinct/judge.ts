// Instinct harness: the judge. Every step of every scenario is recorded, never skipped: PASS with its evidence, FAIL with
// what the state showed, or NOT_BUILT when the thing the step needs does not exist in this tree (a function, a table, a
// connector) — named, so the scorecard says what each failing step needs. A step is judged ONLY by state: database rows,
// the outbox, and what the fake outside systems received (exactly what, how many times). Replies are judged too, but only
// against that state (true to it) and for plain words (no internal codes).
// deno-lint-ignore-file no-explicit-any

export type Status = "PASS" | "FAIL" | "NOT_BUILT";
export interface Step { name: string; status: Status; evidence: string; needs?: string; ms: number }
export interface Card { feature: string; scenario: string; channel: string; steps: Step[]; notes: string[] }

export class Fail extends Error { constructor(msg: string, readonly needs?: string) { super(msg); } }
export class NotBuilt extends Error { constructor(msg: string, readonly needs?: string) { super(msg); } }

export function check(cond: unknown, evidence: string, needs?: string): asserts cond {
  if (!cond) throw new Fail(evidence, needs);
}
export function notBuilt(what: string, needs?: string): never { throw new NotBuilt(what, needs); }

// A step that cannot be reached because an earlier one left nothing to act on is recorded as FAIL with that reason
// (never skipped): run.block(reason) makes every later step of the scenario say so, without running it.
export class Scorecard {
  cards: Card[] = [];
  started = new Date().toISOString();
  meta: Record<string, unknown> = {};
  scenario(feature: string, scenario: string, channel: string) {
    const card: Card = { feature, scenario, channel, steps: [], notes: [] };
    this.cards.push(card);
    let blocked: string | null = null;
    const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
      const t0 = performance.now();
      if (blocked) {
        card.steps.push({ name, status: "FAIL", evidence: `not reached: ${blocked}`, ms: 0 });
        console.log(`    FAIL ${name}: not reached: ${blocked}`);
        return false;
      }
      try {
        const ev = await fn();
        card.steps.push({ name, status: "PASS", evidence: clip(ev ?? "ok"), ms: Math.round(performance.now() - t0) });
        return true;
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        if (e instanceof NotBuilt) card.steps.push({ name, status: "NOT_BUILT", evidence: clip(e.message), needs: e.needs, ms });
        else if (e instanceof Fail) card.steps.push({ name, status: "FAIL", evidence: clip(e.message), needs: e.needs, ms });
        else card.steps.push({ name, status: "FAIL", evidence: clip(`the step threw: ${e instanceof Error ? `${e.message}\n${(e.stack ?? "").split("\n").slice(1, 4).join("\n")}` : String(e)}`), ms });
        console.log(`    ${card.steps.at(-1)!.status} ${name}: ${card.steps.at(-1)!.evidence.split("\n")[0].slice(0, 200)}`);
        return false;
      } finally {
        const s = card.steps.at(-1);
        if (s && s.status === "PASS") console.log(`    PASS ${name}`);
      }
    };
    return { card, step, note: (s: string) => card.notes.push(s), block: (why: string) => { blocked ??= why; }, blocked: () => blocked };
  }
  summary() {
    const by = new Map<string, { pass: number; fail: number; notBuilt: number }>();
    for (const c of this.cards) for (const key of [`${c.feature}`, `${c.feature} / ${c.channel}`]) {
      const s = by.get(key) ?? { pass: 0, fail: 0, notBuilt: 0 };
      for (const st of c.steps) st.status === "PASS" ? s.pass++ : st.status === "FAIL" ? s.fail++ : s.notBuilt++;
      by.set(key, s);
    }
    return by;
  }
  markdown(): string {
    const out: string[] = [];
    out.push(`# Instinct scorecard`, "", `Started ${this.started}.`, "");
    for (const [k, v] of Object.entries(this.meta)) out.push(`- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    out.push("", "## Summary (steps)", "", "| feature / channel | pass | fail | not built |", "|---|---|---|---|");
    for (const [k, v] of this.summary()) out.push(`| ${k} | ${v.pass} | ${v.fail} | ${v.notBuilt} |`);
    for (const c of this.cards) {
      const p = c.steps.filter((s) => s.status === "PASS").length;
      out.push("", `## ${c.feature}: ${c.scenario} (${c.channel}): ${p}/${c.steps.length} pass`, "");
      out.push("| step | result | evidence | needs |", "|---|---|---|---|");
      for (const s of c.steps) out.push(`| ${md(s.name)} | ${s.status} | ${md(s.evidence)} | ${md(s.needs ?? "")} |`);
      for (const n of c.notes) out.push("", `> ${md(n)}`);
    }
    return out.join("\n") + "\n";
  }
}
const clip = (s: string, n = 1500) => (s.length > n ? `${s.slice(0, n)}…` : s);
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " <br> ");

// -------------------------------------------------------------------------------------------------------- plain words
// The scan of tests/architect/reply-jargon-guard.test.ts (SCREAMING_SNAKE tokens, a doubled noun, internal phrases), plus
// what else is an internal code to a person: a state name with underscores, a uuid, a long hex hash, a raw JSON blob.
const SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const DOUBLED = /\b([a-z]+) \1s\b/gi;
const INTERNAL = /\b(from this handler|board adapter|served board list|wiring exists|in this run|request key|owned conversation|career context|MI-\d+|host record|host writer|record write|model judge|saved snapshot|live board)\b/gi;
const STATES = /\b(needs_user|submitted_unconfirmed|not_submitted|unknown_outcome|not_wired|do_not_contact|daily_cap|recipient_cap|payload_hash|approval_hash|card_outdated|needs_reply|no_list|rate_limited)\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{32,}\b/gi;
const JSONISH = /[{[]\s*"[a-z_]+"\s*:/;
export function jargonIn(raw: string): string[] {
  // A link is the person's to open (a posting's own URL may carry an id); only the words around it are judged.
  const text = raw.replace(/\bhttps?:\/\/\S+/g, " ");
  return [...new Set([...(text.match(SNAKE) ?? []), ...(text.match(DOUBLED) ?? []), ...(text.match(INTERNAL) ?? []), ...(text.match(STATES) ?? []),
    ...(text.match(UUID) ?? []), ...(text.match(HEX) ?? []), ...(JSONISH.test(text) ? ["raw JSON"] : [])])];
}
export function plainWords(turns: { said: string; text: string }[]): string {
  const bad = turns.map((t) => ({ t, j: jargonIn(t.text) })).filter((x) => x.j.length);
  check(!bad.length, `${bad.length} of ${turns.length} replies carry internal codes: ${bad.slice(0, 5).map((x) => `"${x.t.said.slice(0, 40)}" -> ${x.j.join(", ")}`).join("; ")}`,
    "replies that say these in the person's words");
  const empty = turns.filter((t) => !t.text.trim());
  return `${turns.length} replies read, none with an internal code${empty.length ? ` (${empty.length} sent no reply text: ${empty.slice(0, 3).map((t) => `"${t.said.slice(0, 30)}"`).join(", ")})` : ""}`;
}
// Every whole number a reply states.
export const numbersIn = (text: string) => [...text.matchAll(/(?<![\w.])(\d{1,6})(?![\w.])/g)].map((m) => Number(m[1]));
export const mentions = (text: string, n: number) => numbersIn(text).includes(n);
// The router's catch-all: the message was not understood.
export const NOT_UNDERSTOOD = /I did not catch what to do with that one|Yes to what\?/i;
