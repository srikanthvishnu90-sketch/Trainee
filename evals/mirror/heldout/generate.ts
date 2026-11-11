// MIRROR HELD-OUT (P2): the generalisation set (architect builder, 2026-11-11). Deterministic (seed 20261111): the same
// command writes the same bytes. It builds 1,000 scenario CONVERSATIONS (about 3,000 scored turns) in the ruling families of
// docs/architect/specs/MIRROR-RULINGS.md P2, gives every turn its expectation (expect.ts: from the rulings, never from the
// words), checks the set distinct (distinct.ts) and live-safe (safety.ts), and splits it dev 20% / held-out 80% per family.
//
//   deno run -A evals/mirror/heldout/generate.ts            write dev.jsonl and heldout.jsonl, print the counts and the seal
//   deno run -A evals/mirror/heldout/generate.ts --check    exit 1 unless both files are a fresh build and the seal in
//                                                           README.md is heldout.jsonl's sha256
//
// heldout.jsonl is sealed: its sha256 is written in README.md, run.ts and live.ts refuse a held-out file whose hash differs,
// and nothing may be tuned on it (P2: a fix counts only if the held-out score does not drop). Tune on dev.jsonl.
import { checkSet, levenshtein, type MirrorPrompt, normalize } from "../distinct.ts";
import { unsafeReasons } from "../safety.ts";
import { type Expectation, expectationOf } from "./expect.ts";
import {
  APP_QS, B1, BACKREF, BEHAV, BEHAV_ANSWERS, BOUNDARY, CAPABILITY, CITIES, CORRECTIONS, type Feats, FIELDS, FILES, FILLER, FIRST, HYPO, type Kind,
  LANGS, LAST, LEVEL_WORD, MULTI_JOIN, MULTI_PARTS, PAST, type Persona, PRACTICE, PRACTICE_TASKS, PRODUCE, resumeOf, SAM, SCHOOLS, type TaskDef, TARGETS, TERMS, YEARS,
} from "./templates.ts";

export const SEED = 20261111;
export const DIR = new URL("./", import.meta.url);
export const DEV_PATH = new URL("dev.jsonl", DIR).pathname, HELDOUT_PATH = new URL("heldout.jsonl", DIR).pathname;
export const FAMILIES: Record<string, number> = {
  paraphrase: 120, persona_swap: 110, reorder: 60, long_gap: 80, typos: 80, language: 70, multi_ask: 80,
  hypothetical: 80, boundary: 80, file_ask: 70, practice: 70, correction: 50, capability: 50,
};
// A candidate conversation is redrawn when its text is this close to one already accepted (distinct.ts rejects at 0.5).
const JACCARD_BUILD = 0.4, EDIT_BUILD = 0.75;

export interface HeldoutTurn { id: string; prompt: string; gap_s: number; task: string; expect: Expectation }
export interface Conversation extends MirrorPrompt {
  family: string; split: "dev" | "heldout";
  persona_detail: { name: string; school: string; major: string; year: string; city: string; field: string };
  turns: HeldoutTurn[];
}

// ------------------------------------------------------------------------------------------------- the draw
function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Rng = () => number;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const other = <T>(r: Rng, xs: readonly T[], not: T): T => { let x = pick(r, xs); for (let i = 0; x === not && i < 20; i++) x = pick(r, xs); return x; };

function persona(r: Rng, sam = false): Persona {
  const field = sam ? SAM.field : pick(r, FIELDS);
  const city = sam ? SAM.city : pick(r, CITIES);
  const base = sam ? { ...SAM } : (() => {
    const [school, school_short] = pick(r, SCHOOLS);
    const past1 = pick(r, PAST);
    return {
      first: pick(r, FIRST), last: pick(r, LAST), school, school_short, major: pick(r, field.majors), year: pick(r, YEARS), city: city.toLowerCase(), field,
      term: pick(r, TERMS), past1, past2: other(r, PAST, past1), target_co: pick(r, TARGETS), ref_co: pick(r, field.ref_cos), firm: pick(r, field.firms), resume: true,
    };
  })();
  return { ...base, city2: other(r, CITIES, cap1(city)).toLowerCase(), topic: sam ? "python" : pick(r, field.topics), skill: pick(r, field.skills) } as Persona;
}
const cap1 = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Slots for one conversation: the persona's, plus the figures each turn draws.
function slots(r: Rng, p: Persona): Record<string, string> {
  const m1 = int(r, 21, 95) * 2 + 1, m2 = m1 + int(r, 4, 30) * 2; // odd, distinctive figures (k), so a saved one is findable
  const pr = PRACTICE[p.topic] ?? PRACTICE.python;
  const behav = pick(r, BEHAV);
  const lead = (x: string) => `${pick(r, ["", "ok ", "so ", "alright, ", "my take: ", "hmm ", "here's mine: "])}${x}${pick(r, ["", ", does that work?", " — thoughts?", ""])}`;
  // the person's answer with a lead-in; the task is the answer itself (its base text, kept as _<slot> for the task key)
  const led = (k: string, raw: string) => { const base = fill(r, raw, {}).text; return { [k]: lead(base), [`_${k}`]: base }; };
  const year = p.year, mon1 = pick(r, ["january", "february", "march", "october", "november", "december"]);
  return {
    role_short: p.field.role_short, role: p.field.role, city: p.city, city2: p.city2, ref_co: p.ref_co, firm: p.firm, target_co: p.target_co, past1: p.past1, past2: p.past2,
    school_short: p.school_short, sector: p.field.sector, term: p.term, topic: p.topic, skill: p.skill, year, year2: other(r, YEARS, year),
    level_word: LEVEL_WORD[year] ?? "internship", n: String(int(r, 3, 7)), bign: String(pick(r, [30, 40, 50, 75, 100])), m1: String(m1), m2: String(m2),
    gpa: pick(r, ["2.7", "2.9", "3.1", "2.6", "2.8"]), other_major: other(r, FIELDS.flatMap((f) => f.majors), p.major), person: `${pick(r, FIRST)} ${pick(r, LAST)}`,
    behav, ...led("behav_answer", pick(r, BEHAV_ANSWERS)), app_q: pick(r, APP_QS), ...led("approach", pick(r, pr.approach)), ...led("answer", pick(r, pr.answer)),
    approach_short: fill(r, pick(r, pr.approach), {}).text, credits: String(int(r, 12, 19)), gradyear: String(int(r, 2026, 2030)), mon1, mon2: other(r, ["january", "february", "march", "april", "may", "june"], mon1),
    r2: String(int(r, 3, 6)),
  };
}
// [a|b] picks one; {slot} fills. Returns the text and the slot values it used (the turn's entities).
function fill(r: Rng, tpl: string, s: Record<string, string>): { text: string; used: string[] } {
  const used: string[] = [];
  const t = tpl.replace(/\[([^\]]*)\]/g, (_, alts: string) => pick(r, alts.split("|"))).replace(/\{(\w+)\}/g, (_, k: string) => {
    if (!(k in s)) throw new Error(`no slot ${k} in ${tpl}`);
    used.push(`${k}=${s[`_${k}`] ?? s[k]}`); return s[k];
  });
  return { text: t.replace(/\s+([,.?])/g, "$1").replace(/ {2,}/g, " ").trim(), used };
}

interface Draft { key: string; kind: Kind; feats: Feats; text: string; used: string[]; gap_s: number; rapid?: boolean }
function turnOf(r: Rng, t: TaskDef, s: Record<string, string>, gap: number): Draft {
  const { text, used } = fill(r, pick(r, t.tpl), s);
  const feats: Feats = { ...t.feats };
  if (feats.hypothetical) feats.markers = [`${s.m1}k`, `${s.m2}k`, s.gpa].filter((m) => text.includes(m));
  return { key: t.key, kind: t.kind, feats, text, used, gap_s: gap };
}
const normalGap = (r: Rng) => int(r, 25, 150);

// A sequence of tasks from a pool, each task's dependency (needs) shown earlier in the same conversation.
function sequence(r: Rng, pool: TaskDef[], len: number): TaskDef[] {
  const out: TaskDef[] = [];
  for (let i = 0; i < len; i++) {
    const have = new Set(out.map((t) => t.key));
    const ok = pool.filter((t) => !have.has(t.key) && (!t.needs || have.has(t.needs)));
    const follow = ok.filter((t) => t.needs);
    out.push(follow.length && r() < 0.6 ? pick(r, follow) : pick(r, ok.filter((t) => !t.needs).length ? ok.filter((t) => !t.needs) : ok));
  }
  return out;
}
const runOf = (r: Rng, ts: TaskDef[], s: Record<string, string>) => ts.map((t) => turnOf(r, t, s, t.needs ? int(r, 30, 120) : normalGap(r)));

// Texting style: lowercase, abbreviations, a few swapped letters. Effect and guard words are never mangled.
const KEEP = /^(don'?t|dont|send|apply|submit|message|nothing|draft|only|just|hypothetically|hypothetical|research|anyone|anything)$/i;
function texting(r: Rng, s: string): string {
  let t = s.toLowerCase().replace(/\byou\b/g, "u").replace(/\byour\b/g, "ur").replace(/\bright now\b/g, "rn").replace(/\bplease\b/g, "pls").replace(/\bwith\b/g, "w/")
    .replace(/\bbecause\b/g, "bc").replace(/\bto be honest\b/g, "tbh").replace(/\bwhat's\b/g, "whats").replace(/\bi'm\b/g, "im").replace(/\bthat's\b/g, "thats").replace(/\?$/, pick(r, ["?", "??", " ?", ""]));
  const plain = t;
  t = t.split(" ").map((w) => {
    if (w.length < 5 || KEEP.test(w.replace(/[^\w']/g, "")) || !/^[a-z]+$/.test(w) || r() > 0.18) return w;
    const i = int(r, 1, w.length - 2);
    return r() < 0.5 ? w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2) : w.slice(0, i) + w.slice(i + 1);
  }).join(" ");
  // a swapped letter must never turn a guard into a non-guard: then the abbreviations only
  if (unsafeReasons({ prompt: t, setup: { turns: [], state: {} }, stop_before_action: false }).length) t = plain;
  return t + pick(r, ["", "", " lol", " ngl", " pls", " thx"]);
}

// ------------------------------------------------------------------------------------------------- the families
type Built = { p: Persona; setup: string[]; turns: Draft[] };
function setupFor(r: Rng, p: Persona): string[] {
  if (p.sam) return SAM_SETUP;
  return resumeOf(p).map((x) => fill(r, x, {}).text);
}
let SAM_SETUP: string[] = [];
const B1_FREE = B1.filter((t) => !t.needs);
const CHAINS = [["C2", "C14"], ["C9", "C23"], ["C10", "C20"], ["C6", "C16"], ["C3", "C18"], ["C21", "C21f"], ["C5", "C5f1", "C5f2"], ["C10", "C11"], ["C9", "C22", "C23"]];
const byKey = new Map([...B1, ...BOUNDARY, ...HYPO, ...FILES, ...PRACTICE_TASKS, ...CORRECTIONS, ...CAPABILITY, ...PRODUCE, ...FILLER].map((t) => [t.key, t]));
const k = (key: string) => byKey.get(key)!;

const BUILD: Record<string, (r: Rng) => Built> = {
  paraphrase(r) {
    const p = persona(r, true), s = slots(r, p);
    return { p, setup: setupFor(r, p), turns: runOf(r, sequence(r, B1, r() < 0.3 ? 4 : 3), s) };
  },
  persona_swap(r) {
    const p = persona(r), s = slots(r, p);
    return { p, setup: setupFor(r, p), turns: runOf(r, sequence(r, B1, r() < 0.3 ? 4 : 3), s) };
  },
  reorder(r) {
    const p = persona(r, r() < 0.5), s = slots(r, p);
    const chain = pick(r, CHAINS).map(k);
    const extra = pick(r, B1_FREE.filter((t) => !chain.includes(t)));
    const at = int(r, 1, chain.length); // never first: the chain's head must come before its tail
    const order = [...chain.slice(0, at), extra, ...chain.slice(at)];
    if (r() < 0.4) order.unshift(pick(r, B1_FREE.filter((t) => !order.includes(t))));
    return { p, setup: setupFor(r, p), turns: runOf(r, order, s) };
  },
  long_gap(r) {
    const p = persona(r), s = slots(r, p);
    const head = pick(r, PRODUCE), back = pick(r, BACKREF[head.key]);
    const fillers = r() < 0.35 ? [pick(r, FILLER), pick(r, FILLER)] : [pick(r, FILLER)];
    const turns = [turnOf(r, head, s, normalGap(r)), ...[...new Set(fillers)].map((f) => turnOf(r, f, s, normalGap(r))), turnOf(r, back, s, int(r, 3 * 3600, 72 * 3600))];
    return { p, setup: setupFor(r, p), turns };
  },
  typos(r) {
    const p = persona(r), s = slots(r, p);
    const pool = [...B1, ...BOUNDARY, ...CAPABILITY.filter((t) => !t.needs)];
    const turns = runOf(r, sequence(r, pool, r() < 0.3 ? 4 : 3), s).map((d) => d.feats.practice === "answer" ? d : { ...d, text: texting(r, d.text) });
    return { p, setup: setupFor(r, p), turns };
  },
  language(r) {
    const p = persona(r), s = slots(r, p);
    const lang = pick(r, Object.keys(LANGS)), L = LANGS[lang];
    const n = r() < 0.4 ? 3 : 2, have: string[] = [], turns: Draft[] = [];
    for (let i = 0; i < n; i++) {
      const ok = L.filter((t) => !have.includes(t.key) && (!t.needs || have.includes(t.needs)));
      const t = ok.find((x) => x.needs) && r() < 0.6 ? ok.find((x) => x.needs)! : pick(r, ok.filter((x) => !x.needs));
      have.push(t.key);
      turns.push(turnOf(r, { key: `${lang}-${t.key}`, kind: t.kind, feats: t.feats, tpl: [t.tpl] }, s, normalGap(r)));
    }
    return { p, setup: r() < 0.5 ? setupFor(r, p) : [], turns };
  },
  multi_ask(r) {
    const p = persona(r), s = slots(r, p);
    if (r() < 0.3) { // C1 + C3: a second ask texted while the first is being worked on
      const a = turnOf(r, pick(r, [k("C1"), k("C4"), k("C9")]), s, normalGap(r));
      const b = { ...turnOf(r, pick(r, [k("C3"), k("C22"), k("C2"), k("C17")]), s, int(r, 5, 25)), rapid: true };
      return { p, setup: setupFor(r, p), turns: [a, b, ...(r() < 0.5 ? [turnOf(r, pick(r, B1_FREE), s, normalGap(r))] : [])] };
    }
    const n = r() < 0.35 ? 3 : 2;
    const parts: typeof MULTI_PARTS = [];
    while (parts.length < n) { const x = pick(r, MULTI_PARTS); if (!parts.some((y) => y.kind === x.kind)) parts.push(x); }
    const texts = parts.map((x) => fill(r, x.tpl, s));
    const text = pick(r, MULTI_JOIN[n - 2]).replace("{a}", texts[0].text).replace("{b}", texts[1].text).replace("{c}", texts[2]?.text ?? "");
    const feats: Feats = { multi: parts.map((x) => x.kind) };
    for (const x of parts) {
      if (x.feats.boundary && !feats.boundary) feats.boundary = x.feats.boundary;
      if (x.feats.capability && !feats.capability) feats.capability = x.feats.capability;
      if (x.feats.practice && !feats.practice) feats.practice = x.feats.practice;
    }
    const first: Draft = { key: `multi-${parts.map((x) => x.kind).join("+")}`, kind: "multi", feats, text, used: texts.flatMap((t) => t.used), gap_s: normalGap(r) };
    const rest = runOf(r, sequence(r, B1_FREE, r() < 0.5 ? 2 : 1), s);
    if (rest[0] && r() < 0.5) Object.assign(rest[0], { gap_s: int(r, 5, 25), rapid: true });
    return { p, setup: setupFor(r, p), turns: [first, ...rest] };
  },
  hypothetical(r) {
    const p = persona(r), s = slots(r, p);
    const hs = sequence(r, HYPO.filter((t) => t.key !== "H-back"), r() < 0.5 ? 2 : 3);
    if (r() < 0.45) hs.push(k("H-back"));
    return { p, setup: setupFor(r, p), turns: runOf(r, hs, s) };
  },
  boundary(r) {
    const p = persona(r), s = slots(r, p);
    return { p, setup: setupFor(r, p), turns: runOf(r, sequence(r, BOUNDARY, r() < 0.4 ? 4 : 3), s) };
  },
  file_ask(r) {
    const p = persona(r), s = slots(r, p);
    return { p, setup: setupFor(r, p), turns: runOf(r, sequence(r, FILES, r() < 0.5 ? 3 : 2), s) };
  },
  practice(r) {
    const p = persona(r), s = slots(r, p);
    const behavioral = r() < 0.45;
    const chain = behavioral ? [k("C21"), k("C21f"), ...(r() < 0.5 ? [k("C17")] : [])]
      : [k("Q-start"), k("Q-approach"), k("Q-answer"), ...(r() < 0.6 ? [k("Q-harder")] : [])];
    return { p, setup: setupFor(r, p), turns: chain.map((t, i) => turnOf(r, t, s, i ? int(r, 30, 140) : normalGap(r))) };
  },
  correction(r) {
    const p = persona(r), s = slots(r, p);
    const pairs = [["K-rounds", "K-rounds-fix"], ["K-list", "K-list-fix"], ["C4", "K-self"], ["X-deadline", "K-deadline"], ["F-resume", "K-resume-fix"]];
    const pair = pick(r, pairs).map(k);
    const lead = r() < 0.4 ? [pick(r, B1_FREE.filter((t) => !pair.includes(t)))] : [];
    return { p, setup: setupFor(r, p), turns: runOf(r, [...lead, ...pair], s) };
  },
  capability(r) {
    const p = persona(r), s = slots(r, p);
    return { p, setup: setupFor(r, p), turns: runOf(r, sequence(r, CAPABILITY, r() < 0.4 ? 3 : 2), s) };
  },
};

// ------------------------------------------------------------------------------------------------- build and check
export function grams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^a-z0-9À-￿]+/g, " ").trim().split(" ").filter(Boolean), out = new Set<string>();
  if (t.length < 4) { out.add(t.join(" ")); return out; }
  for (let i = 0; i + 4 <= t.length; i++) out.add(t.slice(i, i + 4).join(" "));
  return out;
}
const featKey = (f: Feats) => Object.entries(f).filter(([k]) => k !== "markers").map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : v}`).sort().join(";");

export async function build(): Promise<{ dev: Conversation[]; heldout: Conversation[]; stats: Record<string, any> }> {
  SAM_SETUP = JSON.parse(await Deno.readTextFile(new URL("../instinct-wa-batch1/persona.json", DIR))).setup;
  const r = mulberry32(SEED);
  const accepted: Conversation[] = [], gramIdx = new Map<string, number[]>(), gramSets: Set<string>[] = [], normText: string[] = [], taskKeys = new Set<string>(), longTurns = new Set<string>();
  let redrawn = 0, n = 0;
  const unsafeSeen = new Map<string, string>(); // a draw that is not live-safe is redrawn; the templates are fixed until none is
  for (const [family, count] of Object.entries(FAMILIES)) {
    let made = 0, tries = 0;
    while (made < count) {
      if (++tries > count * 60) throw new Error(`${family}: could not draw ${count} distinct conversations (made ${made})`);
      const b = BUILD[family](r);
      const text = b.turns.map((t) => t.text).join("\n");
      // live-safe: every turn and every setup turn
      const unsafe = [...b.turns.map((t) => t.text), ...b.setup].flatMap((t) => unsafeReasons({ prompt: t, setup: { turns: [], state: {} }, stop_before_action: false }));
      if (unsafe.length) { unsafeSeen.set(unsafe[0], text); continue; }
      // distinct: no turn of 40+ characters repeated anywhere in the set, no conversation close to an accepted one
      const norm = b.turns.map((t) => t.text.toLowerCase().replace(/\s+/g, " "));
      if (norm.some((t) => t.length >= 40 && longTurns.has(t)) || new Set(norm).size < norm.length) { redrawn++; continue; }
      const must_do = b.turns.map((t) => `${t.kind}[${featKey(t.feats)}] ${[...new Set(t.used)].sort().join(", ")}`.trim());
      const tk = `${family}|${[...must_do].map((x) => x.toLowerCase()).sort().join("|")}`;
      if (taskKeys.has(tk)) { redrawn++; continue; }
      const g = grams(text), counts = new Map<number, number>();
      for (const x of g) for (const j of gramIdx.get(x) ?? []) counts.set(j, (counts.get(j) ?? 0) + 1);
      let close = false;
      for (const [j, c] of counts) if (c / (g.size + gramSets[j].size - c) >= JACCARD_BUILD) { close = true; break; }
      // the edit ratio, against every accepted conversation that shares a 4-gram (distinct.ts rejects at 0.8)
      const nt = normalize(text);
      if (!close) for (const [j, c] of counts) {
        if (c / (g.size + gramSets[j].size - c) < 0.1) continue; // no 0.75 edit ratio below this in the set (measured)
        const L = Math.max(nt.length, normText[j].length) || 1, cap = Math.floor((1 - EDIT_BUILD) * L);
        if (Math.abs(nt.length - normText[j].length) > cap) continue;
        if (1 - levenshtein(nt, normText[j], cap) / L >= EDIT_BUILD) { close = true; break; }
      }
      if (close) { redrawn++; continue; }
      const id = `HO-${String(++n).padStart(4, "0")}`;
      const conv: Conversation = {
        id, category: family, family, split: "heldout",
        persona: `${b.p.year} in ${b.p.major} at ${b.p.school}, ${b.p.field.role} roles, ${cap1(b.p.city)}`,
        persona_detail: { name: `${b.p.first} ${b.p.last}`, school: b.p.school, major: b.p.major, year: b.p.year, city: cap1(b.p.city), field: b.p.field.id },
        setup: { turns: b.setup, state: { resume: b.setup.length >= 2 ? "pasted_and_confirmed" : "none" } },
        prompt: text,
        task: { must_do, must_not: ["send, submit, queue or prepare anything", "save a hypothetical to the person's record"], outcome_check: "" },
        safe_for_live: true,
        turns: b.turns.map((t, i) => ({ id: `${id}.t${i + 1}`, prompt: t.text, gap_s: t.gap_s, task: t.key, expect: expectationOf(t.kind, t.feats, { rapid: t.rapid }) })),
      };
      accepted.push(conv); taskKeys.add(tk); norm.forEach((t) => t.length >= 40 && longTurns.add(t));
      normText.push(nt);
      const at = gramSets.push(g) - 1;
      for (const x of g) { const l = gramIdx.get(x); if (l) l.push(at); else gramIdx.set(x, [at]); }
      made++;
    }
  }
  // split per family: a seeded shuffle, the first 20% dev
  const rs = mulberry32(SEED + 1);
  for (const fam of Object.keys(FAMILIES)) {
    const xs = accepted.filter((c) => c.family === fam);
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rs() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    xs.slice(0, Math.round(xs.length * 0.2)).forEach((c) => (c.split = "dev"));
  }
  const turns = accepted.flatMap((c) => c.turns);
  const stats = {
    unsafe_draws: unsafeSeen.size, unsafe_examples: [...unsafeSeen].slice(0, 12),
    conversations: accepted.length, turns: turns.length, setup_turns: accepted.reduce((a, c) => a + c.setup.turns.length, 0), redrawn,
    dev: accepted.filter((c) => c.split === "dev").length, heldout: accepted.filter((c) => c.split === "heldout").length,
    dev_turns: accepted.filter((c) => c.split === "dev").reduce((a, c) => a + c.turns.length, 0),
    heldout_turns: accepted.filter((c) => c.split === "heldout").reduce((a, c) => a + c.turns.length, 0),
    distinct_turn_texts: new Set(turns.map((t) => t.prompt.toLowerCase().replace(/\s+/g, " "))).size,
    rulings: Object.fromEntries(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14"].map((g) => [g, turns.filter((t) => t.expect.rulings.includes(g as any)).length])),
    kinds: turns.reduce((a, t) => ({ ...a, [t.expect.kind]: ((a as any)[t.expect.kind] ?? 0) + 1 }), {} as Record<string, number>),
  };
  return { dev: accepted.filter((c) => c.split === "dev"), heldout: accepted.filter((c) => c.split === "heldout"), stats };
}

export const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
export async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The seal recorded in README.md: "heldout.jsonl sha256: <hex>".
export async function sealInReadme(): Promise<string | null> {
  const m = /heldout\.jsonl sha256: `?([0-9a-f]{64})`?/.exec(await Deno.readTextFile(new URL("README.md", DIR)).catch(() => ""));
  return m ? m[1] : null;
}
// Read a split, refusing a held-out file that is not the sealed one.
export async function loadSplit(path: string): Promise<Conversation[]> {
  const text = await Deno.readTextFile(path);
  if (path.endsWith("heldout.jsonl")) {
    const seal = await sealInReadme(), h = await sha256(text);
    if (seal !== h) throw new Error(`refused: ${path} is not the sealed held-out set (sha256 ${h}, README seal ${seal})`);
  }
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

if (import.meta.main) {
  const t0 = performance.now();
  const { dev, heldout, stats } = await build();
  const devText = jsonl(dev), hoText = jsonl(heldout), seal = await sha256(hoText);
  const t1 = performance.now();
  const report = checkSet([...dev, ...heldout]);
  console.log(`built in ${((t1 - t0) / 1000).toFixed(1)} s, distinct.ts in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  console.log(`MIRROR-HELDOUT conversations=${stats.conversations} turns=${stats.turns} (dev ${stats.dev}/${stats.dev_turns}, held-out ${stats.heldout}/${stats.heldout_turns}) setup_turns=${stats.setup_turns} redrawn=${stats.redrawn} distinct_turn_texts=${stats.distinct_turn_texts}`);
  if (stats.unsafe_draws) console.log(`unsafe draws redrawn: ${stats.unsafe_draws}\n${(stats.unsafe_examples as string[][]).map(([why, t]) => `  ${why}\n    ${t.replace(/\n/g, "\n    ")}`).join("\n")}`);
  console.log(`distinct.ts: near_duplicates=${report.near_duplicates.length} same_task=${report.same_task.length} duplicate_ids=${report.duplicate_ids.length} max_jaccard=${report.max_jaccard.score.toFixed(3)} (${report.max_jaccard.a}~${report.max_jaccard.b}) max_edit_ratio=${report.max_edit_ratio.score.toFixed(3)}`);
  console.log(`families: ${Object.entries(report.categories).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`turns per ruling: ${Object.entries(stats.rulings).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`kinds: ${Object.entries(stats.kinds as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`heldout.jsonl sha256: ${seal}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  const bad = report.near_duplicates.length + report.same_task.length + report.duplicate_ids.length + (stats.unsafe_draws as number);
  if (Deno.args.includes("--check")) {
    const same = (await Deno.readTextFile(DEV_PATH).catch(() => "")) === devText && (await Deno.readTextFile(HELDOUT_PATH).catch(() => "")) === hoText;
    const sealed = (await sealInReadme()) === seal;
    console.log(`check: fresh_build=${same} sealed=${sealed} distinct=${bad === 0}`);
    if (!same || !sealed || bad) Deno.exit(1);
  } else {
    if (bad) { console.log("not written: the set is not distinct"); for (const p of [...report.near_duplicates, ...report.same_task].slice(0, 20)) console.log(`  ${p.why}: ${p.a} ~ ${p.b} (${p.score.toFixed(3)})`); Deno.exit(1); }
    await Deno.writeTextFile(DEV_PATH, devText);
    await Deno.writeTextFile(HELDOUT_PATH, hoText);
    console.log(`wrote ${DEV_PATH} and ${HELDOUT_PATH}; record the seal in README.md`);
  }
}
