// Approval scenarios at scale (owner rules, 2026-10-29): a deterministic, seeded generator of the texts a person sends in
// answer to a batch shown for approval (applications on a card, outreach drafts, follow-up/scheduling actions, a billing
// cancel, the employer question), each with what it must approve.
//
//   - one clear "yes" approves exactly the batch shown, any size;
//   - a subset ("1 and 3", "the first two", "all but 2", "2-4") approves only what it states. A path that cannot read a
//     subset form may approve nothing (and ask); it may never approve anything else;
//   - anything ambiguous, deferred, negated, a question, a hedge, sarcasm, noise or another language approves NOTHING.
//
// Expectations are derived per path from `cls` (tests/architect/scenarios-approvals.test.ts). Synthetic only.

export type Cls =
  | "yes" // a clear yes ("yes", "yep", "y", "👍", "yes please", "go ahead", "do it", "yess")
  | "yes_batch" // a clear yes worded about a batch ("send them", "approve all", "send all")
  | "no" // a plain no ("no", "nope", "nah", "no thanks")
  | "no_batch" // a no worded about a batch ("send none", "don't send", "cancel", "skip all", "none")
  | "subset" // a stated subset: approves exactly `pick(n)` or nothing
  | "ambiguous" // a hedge, deferral, question, negation, condition or sarcasm: nothing
  | "noise"; // emoji, empty, very long, another language: nothing

export interface Scenario {
  id: number;
  text: string; // what the person sends
  base: string; // the canonical form before case, spacing and punctuation variation
  cls: Cls;
  category: string; // the report's bucket
  // For a subset: what it states, for a batch of n (null: not satisfiable, e.g. out of range: nothing).
  pick?: (n: number) => number[] | null;
}

// mulberry32: a small seeded PRNG, so every run generates the same scenarios.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
const ORDW = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const within = (ns: number[], n: number) => (ns.length && ns.every((x) => x >= 1 && x <= n) ? [...new Set(ns)].sort((x, y) => x - y) : null);
const except = (ex: number[], n: number) => (ex.every((x) => x >= 1 && x <= n) ? range(1, n).filter((x) => !ex.includes(x)) : null);
const joinList = (xs: string[], sep: string) => (xs.length === 1 ? xs[0] : sep === "and" ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs.join(sep));

// ------------------------------------------------------------------------------------------------ the bases
const YES = ["yes", "yep", "yeah", "y", "yes please", "go ahead", "do it", "👍", "👍🏽", "👍👍", "yup", "yes, go ahead", "yes do it", "yess", "yesss", "yse"];
const YES_BATCH = ["send them", "approve all", "send all", "send them all", "yes, send them", "yes send them all", "approve them all", "yes approve all", "yes to all", "send", "approve"];
const NO = ["no", "nope", "nah", "no thanks", "no thank you"];
const NO_BATCH = ["send none", "none", "don't send", "don't send them", "do not send", "cancel", "skip all", "none of them", "no, don't send them"];
const AMBIGUOUS = [
  "later", "wait", "maybe", "not sure", "hmm", "hmmm", "ok?", "ok", "okay", "sure", "k", "i guess", "probably", "perhaps", "idk", "not yet", "not now",
  "no wait", "yes? ", "yes?", "should i?", "maybe tomorrow", "can you change 2 first", "yes but", "yes but wait", "yes, but", "yes, except", "yes except",
  "yeah right", "yeah, right", "yes no", "yes or no", "1 or 2", "send them?", "send all?", "approve all?", "yes, but not yet", "yes, later",
  "send them tomorrow", "send 1 later", "maybe send 1", "yes if you think so", "yes unless it's bad", "hold on", "let me think", "wait, don't send",
  "don't send yet", "send none of them yet", "nvm", "never mind", "yes... actually no", "yes jk", "lol no", "do i have to?", "what if i say yes?",
  "are you sure?", "yes but change 2 first", "send all except the bad ones", "send the good ones", "whatever you think", "up to you", "maybe later",
  "yes tomorrow", "approve them monday", "yes, after lunch", "not 2", "not them", "except 2", "only", "just", "all except",
  // contradictions, conditions, deferrals and hedges wrapped around a yes or a send
  "yes but not now", "send them all later", "approve all, but wait", "yes, hold on", "yes please wait", "no, send them", "nope, send them", "no yes",
  "yes. no.", "no. yes.", "yes and no", "send them... or not", "go ahead but not yet", "do it later", "yes!!! wait", "yes 👎", "👍?", "yes 🤔", "yes lol jk",
  "yes (not really)", "send them if ok", "send them unless something changed", "send all when you can", "yes if 2 is fixed", "approve all except 2?",
  "send them all? yes", "y?", "stop", "yes, but not yet", "send 1 2 3 maybe", "yes in an hour", "send them on friday", "send them next week",
  "yes, after i check", "maybe yes", "probably yes", "i think so", "yes i think", "yes?? ", "send all except none", "approve none", "send nothing",
  "yes to none", "yes except all", "don't approve", "do not approve them", "never", "no, don't", "approve all, no wait", "wait yes", "hmm yes",
  "ok fine", "fine", "whatever", "sure why not", "if you want", "yes but let me see them again", "show me them first", "change 2", "redo 3",
];
const NOISE = ["", " ", "\n", "sí, envíalos", "oui, envoie-les", "ja bitte", "да", "😀", "🙏", "👀", "❤️", "🤔", "👎", "🔥🔥", "...", "?", "!!!", "sí", "si", "oui", "ja", "da", "hai", "はい", "是", "sim", "evet", "si, claro"];

// ------------------------------------------------------------------------------------------------ subsets
type Form = { render: (r: () => number) => { text: string; pick: (n: number) => number[] | null; category: string } };
const pickSet = (r: () => number, max = 5): number[] => {
  const k = 1 + Math.floor(r() * 3);
  const s = new Set<number>();
  while (s.size < k) s.add(1 + Math.floor(r() * max));
  return [...s].sort((a, b) => a - b);
};
const sepOf = (r: () => number) => ["and", ", ", ",", " & ", " and "][Math.floor(r() * 5)];
const listText = (ns: number[], sep: string, f: (x: number) => string = String) => joinList(ns.map(f), sep === " and " ? "and" : sep);
const SUBSET_FORMS: Form[] = [
  // numerals
  ...["", "send ", "approve ", "only ", "just ", "send only ", "only send ", "yes to ", "approve only ", "numbers ", "send numbers "].map((lead) => ({
    render: (r: () => number) => {
      const ns = pickSet(r);
      if (ns.length === 1 && lead === "") ns.push(ns[0] === 5 ? 4 : ns[0] + 1);
      const ss = [...new Set(ns)].sort((a, b) => a - b);
      return { text: `${lead}${listText(ss, sepOf(r))}`, pick: (n: number) => within(ss, n), category: `subset:numerals${lead ? `:${lead.trim()}` : ""}` };
    },
  })),
  { render: (r) => { const ns = pickSet(r).length > 1 ? pickSet(r) : [1, 3]; return { text: listText(ns, " and ", (x) => `#${x}`), pick: (n) => within(ns, n), category: "subset:hash" }; } },
  // words
  ...["", "send ", "only ", "just "].map((lead) => ({
    render: (r: () => number) => {
      const ns = pickSet(r);
      if (ns.length === 1 && lead === "") ns.push(ns[0] === 5 ? 4 : ns[0] + 1);
      return { text: `${lead}${listText(ns, " and ", (x) => WORDS[x])}`, pick: (n: number) => within(ns, n), category: "subset:words" };
    },
  })),
  // ordinals
  { render: (r) => { const ns = pickSet(r); return { text: `${["", "send ", "only "][Math.floor(r() * 3)]}${listText(ns, " and ", (x) => ORD[x])}`, pick: (n) => within(ns, n), category: "subset:ordinals" }; } },
  { render: (r) => { const ns = pickSet(r); return { text: `${["", "send ", "only "][Math.floor(r() * 3)]}the ${listText(ns, " and ", (x) => ORDW[x])}${ns.length > 1 ? " ones" : " one"}`, pick: (n) => within(ns, n), category: "subset:ordinal-words" }; } },
  { render: (r) => { const k = 2 + Math.floor(r() * 2); return { text: `${["", "send ", "just "][Math.floor(r() * 3)]}the first ${WORDS[k]}`, pick: (n) => within(range(1, k), n), category: "subset:first-k" }; } },
  { render: (r) => { const k = 2 + Math.floor(r() * 2); return { text: `${["", "send ", "just "][Math.floor(r() * 3)]}the last ${WORDS[k]}`, pick: (n) => (k <= n ? range(n - k + 1, n) : null), category: "subset:last-k" }; } },
  // ranges
  ...["-", " - ", "–", " through ", " to ", " thru "].map((dash) => ({
    render: (r: () => number) => {
      const a = 1 + Math.floor(r() * 3), b = a + 1 + Math.floor(r() * 2);
      return { text: `${["", "send ", "approve ", "only "][Math.floor(r() * 4)]}${a}${dash}${b}`, pick: (n: number) => within(range(a, b), n), category: `subset:range${dash.trim() ? `:${dash.trim()}` : ""}` };
    },
  })),
  // except
  ...["all except ", "yes except ", "all but ", "send all but ", "send all except ", "yes but not ", "yes, except ", "everything except ", "approve all except ", "yes, all but ", "send all except number "].map((lead) => ({
    render: (r: () => number) => {
      const ex = pickSet(r).slice(0, 2);
      return { text: `${lead}${listText(ex, " and ")}`, pick: (n: number) => except(ex, n), category: `subset:except:${lead.trim()}` };
    },
  })),
  { render: (r) => ({ text: ["all but the last", "send all but the last", "all except the last one", "everything but the last"][Math.floor(r() * 4)], pick: (n) => range(1, n - 1), category: "subset:all-but-last" }) },
  { render: (r) => ({ text: ["all except the first", "all but the first", "send all but the first one"][Math.floor(r() * 3)], pick: (n) => range(2, n), category: "subset:all-but-first" }) },
  // a single number with a clear marker
  { render: (r) => { const x = 1 + Math.floor(r() * 5); return { text: `${["just ", "only ", "just send ", "send only ", "send #", "send number "][Math.floor(r() * 6)]}${x}`, pick: (n) => within([x], n), category: "subset:single" }; } },
  // mixed yes + subset
  { render: (r) => { const ns = pickSet(r); return { text: `${["yes to ", "yes, ", "yes ", "yes only ", "yes, just "][Math.floor(r() * 5)]}${listText(ns, " and ")}`, pick: (n) => within(ns, n), category: "subset:mixed-yes" }; } },
  // duplicates
  { render: (r) => { const x = 1 + Math.floor(r() * 5); return { text: `${["", "send ", "only "][Math.floor(r() * 3)]}${x}, ${x}`, pick: (n) => within([x], n), category: "subset:duplicate" }; } },
  { render: (r) => { const ns = pickSet(r); const d = [...ns, ns[0]]; return { text: `send ${listText(d, ", ")}`, pick: (n) => within(ns, n), category: "subset:duplicate" }; } },
  // out of range: nothing
  { render: (r) => { const x = 6 + Math.floor(r() * 5); return { text: `${["send ", "only ", "just ", "", "approve "][Math.floor(r() * 5)]}${x}${r() < 0.5 ? "" : ` and 1`}`, pick: () => null, category: "subset:out-of-range" }; } },
  { render: (r) => { const x = 6 + Math.floor(r() * 5); return { text: `${["all except ", "yes except ", "all but "][Math.floor(r() * 3)]}${x}`, pick: () => null, category: "subset:out-of-range" }; } },
  { render: (r) => ({ text: ["send 0", "only 0", "send 0 and 1", "send -1", "only 3-1", "send 4-2"][Math.floor(r() * 6)], pick: () => null, category: "subset:out-of-range" }) },
];

// ------------------------------------------------------------------------------------------------ variation
// Meaning-preserving variation: case, spacing, newlines, trailing . or ! (never ? or ..., which change the meaning).
function vary(base: string, r: () => number, cls: Cls): string {
  let t = base;
  const c = r();
  if (c < 0.2) t = t.toUpperCase();
  else if (c < 0.45) t = t.charAt(0).toUpperCase() + t.slice(1);
  else if (c < 0.55) t = [...t].map((ch) => (r() < 0.5 ? ch.toUpperCase() : ch)).join("");
  if (cls !== "noise" && !/[?]\s*$/.test(t)) {
    const p = r();
    if (p < 0.15) t += ".";
    else if (p < 0.3) t += "!";
    else if (p < 0.35) t += "!!";
    else if (p < 0.38) t += " .";
  }
  const s = r();
  if (s < 0.1) t = `  ${t}`;
  else if (s < 0.2) t = `${t}  `;
  else if (s < 0.25) t = `\n${t}\n`;
  else if (s < 0.3) t = `${t}\n`;
  else if (s < 0.33) t = `\t${t} `;
  if (r() < 0.1) t = t.replace(/ /g, "  ");
  if (r() < 0.2) t = t.replace(/'/g, "’");
  return t;
}

// The question form of any answer: never an approval.
const asQuestion = (t: string) => `${t.replace(/[.!\s]+$/, "")}?`;

export function generate(o: { seed?: number; count?: number } = {}): Scenario[] {
  const r = rng(o.seed ?? 20261029);
  const count = o.count ?? 10_000;
  const out: Scenario[] = [];
  const push = (s: Omit<Scenario, "id">) => out.push({ ...s, id: out.length + 1 });
  // Every base once as written, so each is covered whatever the sample.
  for (const b of YES) push({ text: b, base: b, cls: "yes", category: "yes" });
  for (const b of YES_BATCH) push({ text: b, base: b, cls: "yes_batch", category: "yes_batch" });
  for (const b of NO) push({ text: b, base: b, cls: "no", category: "no" });
  for (const b of NO_BATCH) push({ text: b, base: b, cls: "no_batch", category: "no_batch" });
  for (const b of AMBIGUOUS) push({ text: b, base: b, cls: "ambiguous", category: /\?\s*$/.test(b) ? "ambiguous:question" : "ambiguous" });
  for (const b of NOISE) push({ text: b, base: b, cls: "noise", category: "noise" });
  push({ text: `yes ${"and I also wanted to say thanks for all the help with this, it's been a long week ".repeat(8)}`, base: "long", cls: "noise", category: "noise:long" });
  push({ text: "x".repeat(5000), base: "long", cls: "noise", category: "noise:long" });
  while (out.length < count) {
    const k = r();
    if (k < 0.16) {
      const b = YES[Math.floor(r() * YES.length)];
      push({ text: vary(b, r, "yes"), base: b, cls: "yes", category: "yes" });
    } else if (k < 0.24) {
      const b = YES_BATCH[Math.floor(r() * YES_BATCH.length)];
      push({ text: vary(b, r, "yes_batch"), base: b, cls: "yes_batch", category: "yes_batch" });
    } else if (k < 0.29) {
      const b = NO[Math.floor(r() * NO.length)];
      push({ text: vary(b, r, "no"), base: b, cls: "no", category: "no" });
    } else if (k < 0.34) {
      const b = NO_BATCH[Math.floor(r() * NO_BATCH.length)];
      push({ text: vary(b, r, "no_batch"), base: b, cls: "no_batch", category: "no_batch" });
    } else if (k < 0.66) {
      const f = SUBSET_FORMS[Math.floor(r() * SUBSET_FORMS.length)].render(r);
      push({ text: vary(f.text, r, "subset"), base: f.text, cls: "subset", category: f.category, pick: f.pick });
    } else if (k < 0.82) {
      const b = AMBIGUOUS[Math.floor(r() * AMBIGUOUS.length)];
      push({ text: vary(b, r, "ambiguous"), base: b, cls: "ambiguous", category: /\?\s*$/.test(b) ? "ambiguous:question" : "ambiguous" });
    } else if (k < 0.92) {
      // Any answer asked as a question approves nothing.
      const pool = r() < 0.5 ? YES.concat(YES_BATCH) : SUBSET_FORMS.map((f) => f.render(r).text);
      const b = asQuestion(pool[Math.floor(r() * pool.length)]);
      push({ text: vary(b, r, "ambiguous"), base: b, cls: "ambiguous", category: "ambiguous:question" });
    } else {
      const b = NOISE[Math.floor(r() * NOISE.length)];
      push({ text: vary(b, r, "noise"), base: b, cls: "noise", category: "noise" });
    }
  }
  return out;
}

// A seeded sample of the scenarios, every class represented in proportion.
export function sample(all: Scenario[], k: number, seed = 7): Scenario[] {
  const r = rng(seed), pool = [...all], out: Scenario[] = [];
  while (out.length < k && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}
