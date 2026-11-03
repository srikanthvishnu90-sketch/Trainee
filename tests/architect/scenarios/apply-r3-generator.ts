// Apply flow round 3 (architect, 2026-10-30): the scenario generator. Seeded (mulberry32), pure data, no product code.
// The categories round 1 and round 2 never drew (scenarios-apply*, scenarios-file-apply*, scenarios-file-journey-r2*,
// scenarios-file-signin*, flow-*): what changes BETWEEN the page drawing a row and the person's yes, and what the yes must then
// never approve:
//   expiry     the prepared payload's own expires_at around the tap (past, at the margin, ahead), the database's clock ahead of or
//              behind the page's by up to a minute, time passing between the draw and the tap
//   account    the account record moving under a drawn row: paused, "forget everything" (a new privacy epoch), the authority fence
//              moving past the payload's version, a harmless version bump, the record erased
//   answers    answers no confirmed fact supports: the owner's quarantined bank (F-027..F-079 in every spelling), an answer-all
//              delegation, derived from a quarantined fact or with malformed derivation metadata, a texted answer with no question,
//              other quarantine rules, an answer carrying ANOTHER account's fact, EEO / demographic questions answered from those
//   resume     the resume replaced or deleted between the draw and the tap
//   elsewhere  the same posting already sent another way: the browser extension's report, an application under another id whose
//              link is the same posting (tracking parameters, the other Greenhouse board, a trailing /apply), appearing before
//              the draw or between the draw and the tap
//   devices    two signed-in devices and Telegram's Confirm at once on one posting, Apply and Apply to all crossing, a stale tag
//   session    sign-out everywhere between the draw and the tap, a session at exactly its expiry instant, a link minted by a
//              clock ahead of this one, another account's ref posted with this session
//   scale      lists of 31-120 postings with Unicode company names (NFC and NFD, right-to-left, zero-width, full-width, ZWJ
//              emoji, markup), Apply to all, and Apply on a row past the page's first 30
export type Cat = "expiry" | "account" | "answers" | "resume" | "elsewhere" | "devices" | "session" | "scale";
export const CATS: Cat[] = ["expiry", "account", "answers", "resume", "elsewhere", "devices", "session", "scale"];

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

export type Provider = "greenhouse" | "lever" | "ashby";
export type FieldKind =
  | "plain" | "eeo_decline" | "eeo_value"
  | "q_bank" | "q_bank_padded" | "q_answer_all" | "q_delegated" | "q_derived" | "q_derived_alias" | "derived_ok" | "derived_bad" | "text_no_key" | "text_keyed"
  | "other_owner" | "own_owner";
export const UNTRUSTED: ReadonlySet<FieldKind> = new Set(["q_bank", "q_bank_padded", "q_answer_all", "q_delegated", "q_derived", "q_derived_alias", "derived_bad", "text_no_key", "other_owner"]);
export interface PrepSpec {
  expiresIn: number | "invalid"; // ms after the page's clock at the start
  stamp: "current" | "old_epoch" | "behind_fence" | "ahead"; // the payload's privacy_epoch / account_version against the record
  fields: FieldKind[];
  quarantine: "none" | "current" | "other";
}
export interface PostSpec { n: number; company: string; provider: Provider; prep: PrepSpec | null; elsewhere: null | "extension" | "alt_id" }
export type Mut =
  | { m: "pause" } | { m: "forget" } | { m: "fence" } | { m: "bump" } | { m: "erase" }
  | { m: "replace_resume" } | { m: "delete_resume" }
  | { m: "elsewhere"; i: number; how: "extension" | "alt_id" }
  | { m: "reprepare"; i: number };
export type Step =
  | { k: "draw"; dev: "A" | "B" }
  | { k: "apply"; dev: "A" | "B"; i: number; stale?: boolean }
  | { k: "applyall"; dev: "A" | "B" }
  | { k: "tg_confirm"; i: number }
  | { k: "mutate"; mut: Mut }
  | { k: "advance"; ms: number }
  | { k: "signout_all"; dev: "A" | "B" }
  | { k: "at_session_end"; delta: number } // the clock set to the session's expiry + delta ms
  | { k: "cross"; dev: "A" | "B" } // another account's ref, posted with this session
  | { k: "link"; skew: number }; // a link minted by a clock `skew` ms ahead, opened now
export interface Scenario { id: number; cat: Cat; posts: PostSpec[]; account: { epoch: number; version: number; authority: number; paused: boolean }; skew: number; steps: Step[] }

const NAMES: ((n: number) => string)[] = [
  (n) => `Acme ${n}`,
  (n) => `Café Ünïcode ${n}`.normalize("NFC"),
  (n) => `Café Ünïcode ${n}`.normalize("NFD"),
  (n) => `株式会社テスト${n}`,
  (n) => `شركة الاختبار ${n}`,
  (n) => `Zero​Width ${n}`,
  (n) => `Ｆｕｌｌ Ｗｉｄｔｈ ${n}`,
  (n) => `👩‍💻 Labs ${n}`,
  (n) => `O'Brien & Sons "${n}"`,
  (n) => `<b>Tag</b> ‮evil ${n}`,
];
const freshPrep = (r: () => number): PrepSpec => ({ expiresIn: 7 * 86_400_000, stamp: "current", fields: ["plain", ...(r() < 0.3 ? ["eeo_decline" as const] : [])], quarantine: r() < 0.5 ? "current" : "none" });

export function generate(o: { seed: number; count: number }): Scenario[] {
  const out: Scenario[] = [];
  for (let id = 0; id < o.count; id++) {
    const r = rng(o.seed * 7919 + id);
    const cat = CATS[id % CATS.length];
    const nPosts = cat === "scale" ? 31 + Math.floor(r() * 90) : 1 + Math.floor(r() * 5);
    const posts: PostSpec[] = [];
    for (let i = 0; i < nPosts; i++) posts.push({ n: i + 1, company: pick(r, NAMES)(i + 1), provider: pick(r, ["greenhouse", "lever", "ashby"] as const), prep: r() < 0.9 ? freshPrep(r) : null, elsewhere: null });
    const account = { epoch: Math.floor(r() * 3), version: 5 + Math.floor(r() * 5), authority: 0, paused: false };
    account.authority = Math.floor(r() * account.version);
    const skew = Math.round((r() * 2 - 1) * 60_000); // the database's clock minus the page's
    const steps: Step[] = [{ k: "draw", dev: "A" }];
    const some = () => Math.floor(r() * posts.length);
    switch (cat) {
      case "expiry": {
        for (const p of posts) if (p.prep) p.prep.expiresIn = r() < 0.08 ? "invalid" : pick(r, [-86_400_000, -60_000, 0, 30_000, 60_000, 90_000, 119_000, 120_000, 121_000, 180_000, 300_000, 3_600_000, 86_400_000]) + Math.round(r() * 2000);
        steps.length = 0;
        steps.push({ k: "advance", ms: pick(r, [0, 0, 30_000]) }, { k: "draw", dev: "A" });
        if (r() < 0.5) steps.push({ k: "advance", ms: pick(r, [10_000, 60_000, 150_000, 600_000]) });
        steps.push(r() < 0.6 ? { k: "apply", dev: "A", i: some() } : r() < 0.5 ? { k: "applyall", dev: "A" } : { k: "tg_confirm", i: some() });
        steps.push({ k: "draw", dev: "A" });
        break;
      }
      case "account": {
        for (const p of posts) if (p.prep && r() < 0.35) p.prep.stamp = pick(r, ["old_epoch", "behind_fence", "ahead"] as const);
        if (r() < 0.15) account.paused = true;
        if (r() < 0.6) steps.push({ k: "mutate", mut: pick(r, [{ m: "pause" }, { m: "forget" }, { m: "fence" }, { m: "bump" }, { m: "erase" }] as const) });
        steps.push(r() < 0.6 ? { k: "apply", dev: "A", i: some() } : r() < 0.5 ? { k: "applyall", dev: "A" } : { k: "tg_confirm", i: some() }, { k: "draw", dev: "A" });
        break;
      }
      case "answers": {
        const kinds: FieldKind[] = ["plain", "eeo_decline", "eeo_value", "q_bank", "q_bank_padded", "q_answer_all", "q_delegated", "q_derived", "q_derived_alias", "derived_ok", "derived_bad", "text_no_key", "text_keyed", "other_owner", "own_owner"];
        for (const p of posts) if (p.prep) {
          p.prep.fields = ["plain", ...Array.from({ length: 1 + Math.floor(r() * 3) }, () => (r() < 0.5 ? pick(r, kinds) : pick(r, ["plain", "derived_ok", "text_keyed", "own_owner", "eeo_decline"] as const)))];
          p.prep.quarantine = pick(r, ["none", "current", "current", "other"] as const);
        }
        steps.push(r() < 0.5 ? { k: "apply", dev: "A", i: some() } : r() < 0.5 ? { k: "applyall", dev: "A" } : { k: "tg_confirm", i: some() }, { k: "draw", dev: "A" });
        break;
      }
      case "resume": {
        steps.push({ k: "mutate", mut: r() < 0.7 ? { m: "replace_resume" } : { m: "delete_resume" } });
        if (r() < 0.4) steps.push({ k: "mutate", mut: { m: "reprepare", i: some() } });
        steps.push(r() < 0.5 ? { k: "apply", dev: "A", i: some() } : r() < 0.5 ? { k: "applyall", dev: "A" } : { k: "tg_confirm", i: some() }, { k: "draw", dev: "A" });
        break;
      }
      case "elsewhere": {
        for (const p of posts) if (r() < 0.3) p.elsewhere = r() < 0.5 ? "extension" : "alt_id";
        steps.length = 0;
        steps.push({ k: "draw", dev: "A" });
        if (r() < 0.6) steps.push({ k: "mutate", mut: { m: "elsewhere", i: some(), how: r() < 0.5 ? "extension" : "alt_id" } });
        steps.push(r() < 0.5 ? { k: "apply", dev: "A", i: some() } : r() < 0.5 ? { k: "applyall", dev: "A" } : { k: "tg_confirm", i: some() }, { k: "draw", dev: "A" });
        break;
      }
      case "devices": {
        steps.push({ k: "draw", dev: "B" });
        const i = some();
        const moves: Step[] = [{ k: "apply", dev: "A", i }, { k: "apply", dev: "B", i }, { k: "tg_confirm", i }, { k: "applyall", dev: "B" }, { k: "apply", dev: "A", i, stale: true }];
        if (r() < 0.3) moves.push({ k: "mutate", mut: { m: "reprepare", i } });
        for (let k = moves.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [moves[k], moves[j]] = [moves[j], moves[k]]; }
        steps.push(...moves.slice(0, 2 + Math.floor(r() * 3)), { k: "draw", dev: "A" });
        break;
      }
      case "session": {
        steps.push({ k: "draw", dev: "B" });
        const x = Math.floor(r() * 4);
        if (x === 0) steps.push({ k: "signout_all", dev: "B" }, { k: "apply", dev: "A", i: some() }, { k: "applyall", dev: "A" });
        else if (x === 1) steps.push({ k: "at_session_end", delta: pick(r, [-1, 0, 1, -60_000]) }, { k: "apply", dev: "A", i: some() });
        else if (x === 2) steps.push({ k: "cross", dev: pick(r, ["A", "B"] as const) }, { k: "apply", dev: "A", i: some() });
        else steps.push({ k: "link", skew: pick(r, [-3_600_000, 0, 30_000, 59_000, 60_000, 61_000, 300_000]) }, { k: "apply", dev: "B", i: some() });
        steps.push({ k: "draw", dev: "A" });
        break;
      }
      case "scale": {
        steps.push(r() < 0.5 ? { k: "applyall", dev: "A" } : { k: "apply", dev: "A", i: 30 + Math.floor(r() * (posts.length - 30)) });
        if (r() < 0.5) steps.push({ k: "apply", dev: "A", i: Math.floor(r() * 30) });
        steps.push({ k: "draw", dev: "A" });
        break;
      }
    }
    out.push({ id, cat, posts, account, skew, steps });
  }
  return out;
}
export function sample<T>(xs: T[], n: number, seed: number): T[] {
  const r = rng(seed), a = [...xs];
  for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; }
  return a.slice(0, n);
}
