// MIRROR-1000 builder (architect builder, 2026-11-11). Writes evals/mirror/prompts.v1.jsonl: 1,000 prompts for the Instinct
// and Trainee mirror run, each with its task (must_do, must_not, a machine-checkable outcome_check) and safe to send to a live
// agent that acts. Deterministic (one seed), $0, no model.
//
//   deno run -A evals/mirror/build.ts [--check]      (--check: rebuild in memory and fail if the committed file differs)
//
// How a prompt is made (README.md "How the 1,000 stay distinct"):
//   * hand-written prompts (specs.ts HAND entries), each with its own task;
//   * composed prompts: one intent of a category (its frames, must_do, must_not, check) plus zero, one or two constraints from
//     that category's constraint list (each adds its own must_do item and check). The (intent, constraints) combination is the
//     task, and each combination is used at most once in the whole set, so two prompts never share a task, whatever their words;
//   * style categories (typos, long, multi_part) take combinations no base category used, and change the words (typo noise,
//     a long message of context, two asks in one message);
//   * every candidate is checked against the prompts accepted so far (distinct.ts thresholds) and redrawn when too close.
import { checkSet, editRatio, grams4, jaccard, JACCARD_MAX, EDIT_MAX, type MirrorPrompt } from "./distinct.ts";
import { BASE, STYLE, type Hand, type Intent, type Mod, type Spec } from "./specs.ts";
import * as V from "./vocab.ts";
import { unsafeReasons } from "./safety.ts";

export const SEED = 20261111, TOTAL = 1000;
export function rng(seed = SEED) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const shuffle = <T>(xs: T[]): T[] => { const c = [...xs]; for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; };
  return { next, pick, shuffle, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}
export type R = ReturnType<typeof rng>;

// Slot values for one prompt: two of each kind, never the same twice.
function slots(r: R): Record<string, string> {
  const two = <T>(xs: readonly T[]) => { const a = r.pick(xs); let b = r.pick(xs); while (b === a) b = r.pick(xs); return [a, b] as const; };
  const [role, role2] = two(V.ROLES), [city, city2] = two(V.CITIES), [company, company2] = two(V.COMPANIES.slice(0, 40));
  const [person, person2] = two(V.PEOPLE), [skill, skill2] = two(V.SKILLS), [industry, industry2] = two(V.INDUSTRIES);
  const fake = V.COMPANIES.slice(40);
  const first = person.split(" ")[0], last = person.split(" ")[1];
  return {
    role, role2, city, city2, company, company2, person, person2, first, first2: person2.split(" ")[0], skill, skill2, industry, industry2,
    fake: r.pick(fake), school: r.pick(V.SCHOOLS), major: r.pick(V.MAJORS), level: r.pick(V.LEVELS), term: r.pick(V.TERMS),
    day: r.pick(V.WEEKDAYS), month: r.pick(V.MONTHS), n: String(r.int(3, 12)), k: String(r.int(2, 4)), pay: String(r.pick([55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 130])),
    hourly: String(r.pick([18, 20, 22, 25, 28, 30, 35])), year: r.pick(["2026", "2027", "2028"]),
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.test`, phone: `(312) 555-01${String(r.int(10, 99))}`,
    pos: String(r.int(1, 5)), pos2: String(r.int(6, 9)),
  };
}
const fill = (t: string, s: Record<string, string>) => t.replace(/\{([a-z][a-z0-9]*)\}/g, (_m, k) => { if (!(k in s)) throw new Error(`unknown slot {${k}} in "${t}"`); return s[k]; });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Joining a frame, its constraints and a guard in varied shapes (so the joins themselves do not repeat).
function compose(r: R, frame: string, mods0: string[], guard: string | null): string {
  const mods = mods0.map((m) => m.replace(/^and /, ""));
  const q = /\?\s*$/.test(frame);
  let body = frame.trim().replace(/[.?!]+$/, "");
  if (q) {
    // a question keeps its question mark; constraints follow as their own sentence
    body += "?";
    if (mods.length === 1) body += ` ${cap(mods[0])}.`;
    if (mods.length === 2) body += r.pick([` ${cap(mods[0])}, and ${mods[1]}.`, ` ${cap(mods[0])}; also ${mods[1]}.`]);
  } else {
    if (mods.length === 1) body = r.pick([`${body}, ${mods[0]}`, `${body}. ${cap(mods[0])}`, `${body} (${mods[0]})`, `${body} — ${mods[0]}`]);
    if (mods.length === 2) body = r.pick([`${body}, ${mods[0]}, and ${mods[1]}`, `${body}. ${cap(mods[0])}; ${mods[1]}`, `${body} — ${mods[0]}, also ${mods[1]}`, `${body}. Two things: ${mods[0]}, and ${mods[1]}`]);
    body = body.replace(/[.?!]?$/, (m) => (m === "?" ? "?" : "."));
  }
  if (!guard) return body;
  return r.next() < 0.7 ? `${body} ${cap(guard)}.` : `${cap(guard)}: ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
}

// Typo noise for the typos style: swaps, drops and doubles inside words, lowercase, no final punctuation.
function typo(r: R, s: string): string {
  const words = s.split(" ");
  const out = words.map((w) => {
    if (w.length < 4 || r.next() > 0.45 || /@|\d/.test(w)) return w;
    const i = r.int(1, w.length - 2), k = r.int(0, 2);
    if (k === 0) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    if (k === 1) return w.slice(0, i) + w.slice(i + 1);
    return w.slice(0, i) + w[i] + w.slice(i);
  });
  return out.join(" ").toLowerCase().replace(/[.]$/, "").replace(/\bdon't\b/g, () => r.pick(["dont", "don't", "do not"])).replace(/\byou\b/g, () => r.pick(["u", "you"]));
}

interface Combo { cat: string; intent: Intent; mods: Mod[] }
const comboKey = (c: Combo) => `${c.cat}|${c.intent.key}|${c.mods.map((m) => m.key).sort().join("+")}`;
function combosOf(spec: Spec): Combo[] {
  const out: Combo[] = [];
  for (const intent of spec.intents) {
    const ok = spec.mods.filter((m) => !(intent.noMods ?? []).includes(m.group ?? m.key) && !(m.only && !m.only.includes(intent.key)));
    out.push({ cat: spec.cat, intent, mods: [] });
    for (const m of ok) out.push({ cat: spec.cat, intent, mods: [m] });
    for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) if ((ok[i].group ?? ok[i].key) !== (ok[j].group ?? ok[j].key)) out.push({ cat: spec.cat, intent, mods: [ok[i], ok[j]] });
  }
  return out;
}

class Accepted {
  list: MirrorPrompt[] = [];
  grams: Set<string>[] = [];
  tooClose(text: string): boolean {
    const g = grams4(text);
    for (let i = 0; i < this.list.length; i++) {
      if (jaccard(g, this.grams[i]) >= JACCARD_MAX - 0.05) return true;
      const a = this.list[i].prompt;
      if (Math.abs(a.length - text.length) <= 0.25 * Math.max(a.length, text.length) && editRatio(a, text) >= EDIT_MAX - 0.05) return true;
    }
    return false;
  }
  add(p: MirrorPrompt) { this.list.push(p); this.grams.push(grams4(p.prompt)); }
}

interface Draft { prompt: string; setup: { turns: string[]; state: Record<string, unknown> }; persona: string; must_do: string[]; must_not: string[]; check: string; stop: boolean }

function fromCombo(r: R, spec: Spec, c: Combo): Draft {
  const s = slots(r);
  const frame = fill(r.pick(c.intent.frames), s);
  const mods = c.mods.map((m) => fill(r.pick(m.phrases), s));
  const guards = c.intent.guards ?? spec.guards;
  const guard = guards.length ? fill(r.pick(guards), s) : null;
  const setupSpec = c.intent.setup ?? spec.setup ?? null;
  const setup = setupSpec ? { turns: setupSpec.turns.map((t) => fill(t, s)), state: setupSpec.state } : { turns: [], state: { resume: spec.resume ?? "confirmed" } };
  return {
    prompt: compose(r, frame, mods, guard), setup, persona: fill(r.pick(spec.personas), s),
    must_do: [...c.intent.must_do, ...c.mods.map((m) => fill(m.must, s))].map((x) => fill(x, s)),
    must_not: [...new Set([...c.intent.must_not, ...(spec.must_not ?? []), ...c.mods.flatMap((m) => (m.not ? [m.not] : []))])],
    check: fill([...new Set([c.intent.check, ...c.mods.flatMap((m) => (m.check ? [m.check] : []))])].join(" && "), s),
    stop: !!(c.intent.stop || spec.stop),
  };
}
function fromHand(r: R, spec: Spec, h: Hand): Draft {
  return {
    prompt: h.prompt, setup: h.setup ?? (spec.setup ? { turns: [...spec.setup.turns], state: spec.setup.state } : { turns: [], state: { resume: spec.resume ?? "confirmed" } }),
    persona: h.persona ?? fill(r.pick(spec.personas), slots(r)), must_do: h.must_do, must_not: [...new Set([...h.must_not, ...(spec.must_not ?? [])])], check: h.check, stop: !!(h.stop || spec.stop),
  };
}

export function build(): MirrorPrompt[] {
  const r = rng();
  const acc = new Accepted(), used = new Set<string>();
  const counters: Record<string, number> = {};
  const push = (cat: string, d: Draft) => {
    const n = (counters[cat] = (counters[cat] ?? 0) + 1);
    const p: MirrorPrompt = {
      id: `${cat}-${String(n).padStart(3, "0")}`, category: cat, persona: d.persona, setup: d.setup, prompt: d.prompt,
      task: { must_do: d.must_do, must_not: d.must_not, outcome_check: d.check }, safe_for_live: true, ...(d.stop ? { stop_before_action: true } : {}),
    };
    const why = unsafeReasons(p);
    if (why.length) throw new Error(`${p.id} is not safe for a live agent: ${why.join("; ")} — "${p.prompt}"`);
    acc.add(p);
  };
  const tryDraft = (make: () => Draft, tries = 40): Draft | null => {
    for (let t = 0; t < tries; t++) { const d = make(); if (!acc.tooClose(d.prompt) && !unsafeReasonsDraft(d).length) return d; }
    return null;
  };
  // 1. base categories: hand-written first, then composed combinations
  for (const spec of BASE) {
    for (const h of spec.hand ?? []) {
      const d = fromHand(r, spec, h);
      if (acc.tooClose(d.prompt)) throw new Error(`hand-written prompt too close to an earlier one: ${h.prompt}`);
      push(spec.cat, d);
    }
    const all = combosOf(spec);
    // every intent once on its own first, then the rest (single and paired constraints) in shuffled order
    const order = [...spec.intents.map((i) => all.find((c) => c.intent === i && c.mods.length === 0)!), ...r.shuffle(all.filter((c) => c.mods.length))];
    for (const c of order) {
      if ((counters[spec.cat] ?? 0) >= spec.target) break;
      if (used.has(comboKey(c))) continue;
      const d = tryDraft(() => fromCombo(r, spec, c));
      if (!d) continue;
      used.add(comboKey(c));
      push(spec.cat, d);
    }
    if ((counters[spec.cat] ?? 0) < spec.target) throw new Error(`${spec.cat}: only ${counters[spec.cat]} of ${spec.target}`);
  }
  // 2. style categories
  const pool = (cats: string[]) => r.shuffle(BASE.filter((s) => cats.includes(s.cat)).flatMap((s) => combosOf(s).filter((c) => !used.has(comboKey(c))).map((c) => ({ spec: s, c }))));
  for (const st of STYLE) {
    for (const h of st.hand ?? []) {
      const d = fromHand(r, st, h);
      if (acc.tooClose(d.prompt)) throw new Error(`hand-written prompt too close to an earlier one: ${h.prompt}`);
      push(st.cat, d);
    }
    if (!st.from) { if ((counters[st.cat] ?? 0) !== st.target) throw new Error(`${st.cat}: ${counters[st.cat] ?? 0} hand prompts, target ${st.target}`); continue; }
    const items = pool(st.from);
    let at = 0;
    while ((counters[st.cat] ?? 0) < st.target && at < items.length) {
      const a = items[at++];
      if (used.has(comboKey(a.c))) continue;
      let d: Draft | null = null;
      let b: typeof a | undefined;
      if (st.cat === "multi_part") {
        b = items.slice(at).find((x) => x.spec.cat !== a.spec.cat && !used.has(comboKey(x.c)));
        if (!b) break;
        const bb = b;
        d = tryDraft(() => {
          const x = fromCombo(r, a.spec, a.c), y = fromCombo(r, bb.spec, bb.c);
          const join = r.pick(["Two things. First, {a} Second, {b}", "{a} Also, separately: {b}", "Quick pair of asks — {a} And {b}", "1) {a} 2) {b}", "{a} Then, unrelated: {b}"]);
          const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
          return { prompt: join.replace("{a}", x.prompt).replace("{b}", /^\d\)|And \{b\}/.test(join) ? lower(y.prompt) : y.prompt), setup: { turns: [...x.setup.turns, ...y.setup.turns], state: { ...y.setup.state, ...x.setup.state } },
            persona: x.persona, must_do: [...x.must_do, ...y.must_do, ...st.extra_must], must_not: [...new Set([...x.must_not, ...y.must_not])], check: `${x.check} && ${y.check}`, stop: x.stop || y.stop };
        });
      } else if (st.cat === "typos") {
        d = tryDraft(() => { const x = fromCombo(r, a.spec, a.c); return { ...x, prompt: typo(r, x.prompt), must_do: [...x.must_do, ...st.extra_must] }; });
      } else if (st.cat === "long") {
        d = tryDraft(() => {
          const x = fromCombo(r, a.spec, a.c), s = slots(r);
          const ctx = r.shuffle(st.context ?? []).slice(0, 4).map((c) => fill(c, s)).join(" ");
          return { ...x, prompt: `${ctx} ${r.pick(["Anyway, here is what I need:", "So my actual ask:", "Okay, the request:", "What I want from you now:", "Here's the thing I need help with:"])} ${x.prompt}`, must_do: [...x.must_do, ...st.extra_must] };
        });
      }
      if (!d) continue;
      used.add(comboKey(a.c)); if (b) used.add(comboKey(b.c));
      push(st.cat, d);
    }
    if ((counters[st.cat] ?? 0) < st.target) throw new Error(`${st.cat}: only ${counters[st.cat]} of ${st.target}`);
  }
  if (acc.list.length !== TOTAL) throw new Error(`built ${acc.list.length} prompts, want ${TOTAL}`);
  return acc.list;
}
function unsafeReasonsDraft(d: Draft) { return unsafeReasons({ prompt: d.prompt, setup: d.setup, stop_before_action: d.stop } as unknown as MirrorPrompt); }

export const toJsonl = (set: MirrorPrompt[]) => set.map((p) => JSON.stringify(p)).join("\n") + "\n";

if (import.meta.main) {
  const set = build();
  const out = new URL("./prompts.v1.jsonl", import.meta.url).pathname;
  const rep = checkSet(set);
  console.log(`built ${set.length}: near_duplicates=${rep.near_duplicates.length} same_task=${rep.same_task.length} max_jaccard=${rep.max_jaccard.score.toFixed(3)} max_edit=${rep.max_edit_ratio.score.toFixed(3)}`);
  for (const p of rep.near_duplicates.slice(0, 20)) console.log(" ", p);
  if (Deno.args.includes("--check")) {
    const now = await Deno.readTextFile(out);
    if (now !== toJsonl(set)) { console.log("prompts.v1.jsonl differs from a fresh build"); Deno.exit(1); }
    console.log("prompts.v1.jsonl matches a fresh build");
  } else await Deno.writeTextFile(out, toJsonl(set));
}
