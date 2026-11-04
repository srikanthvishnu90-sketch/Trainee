// Seeded journeys through the WHOLE jobs-page flow, round 2 (owner, 2026-10-29: "open the postings with company logos, roles and
// details, log in with my phone number, then click Apply and have it apply for me"). Pure data: a scenario is a list of postings
// (in every state and in hostile text) and a list of steps a person, a second device, Telegram, an attacker and the world take.
// tests/architect/scenarios-file-journey-r2*.test.ts runs them through the real handler; the Postgres flows sample them.
//
// Round 1 (scenarios-file-signin*, scenarios-file-apply*) covered sign-in and the page's Apply on one device. New here:
//   - journey: Telegram's cards -> the "open the list" link -> phone sign-in -> the list -> details -> Apply -> Telegram's Confirm on
//     the same posting (one approval, an honest word on the other); the list changing between draw and tap (a new posting, a posting
//     closed, a payload prepared again); a session expiring mid-journey; signing out on one device while another taps Apply;
//   - rendering at scale: up to 45 postings (the page shows 30 and says so), very long, non-Latin, right-to-left, emoji-first and
//     markup-laden companies, titles and descriptions, missing and hostile logos; the plain-form (no script) path;
//   - security: a cross-site POST (the cookie, never the session's own value), a session id planted before sign-in, a redirect path
//     that names another host, posting and destination links that are javascript: or data:, markup in every field, many sign-in tries;
//   - accessibility that decides correctness: every Apply names its role and company, status changes are announced.

export type Script = "latin" | "long" | "arabic" | "hebrew" | "cjk" | "emoji" | "markup" | "bidi" | "combining" | "astral";
export type UrlKind = "greenhouse" | "lever" | "ashby" | "linkedin" | "indeed" | "handshake" | "javascript" | "data";
export type AppState = "queued" | "driving" | "submitted_unconfirmed" | "confirmed" | "failed" | "needs_user" | "not_submitted" | "unknown_outcome";
export type PrepKind = "plain" | "secret" | "bad_dest" | "byhand_dest" | "markup";
export interface PostingSpec {
  n: number;
  company: Script; title: Script; desc: "plain" | "long" | "markup" | "rtl" | "emoji_cut" | "none";
  url: UrlKind; logo: "stated" | "none" | "hostile";
  hasRow: boolean; closed: boolean; deadlinePast: boolean;
  prep: PrepKind | null; app: AppState | null; wanted: boolean;
}
export type Device = 0 | 1;
export type Step =
  | { k: "cards" } // the bot shows the postings: cards (3 or fewer) or one "open the list" link
  | { k: "open"; dev: Device; path: "plain" | "double_slash" | "backslash"; crawler?: boolean; plant?: "random" | "other_account" }
  | { k: "phone"; dev: Device; who: "own" | "stranger" | "garbage" }
  | { k: "code"; dev: Device; right: boolean }
  | { k: "view"; dev: Device; text?: boolean }
  | { k: "apply"; dev: Device; row: number; tag: "shown" | "stale" | "forged" | "none"; js: boolean }
  | { k: "applyall"; dev: Device }
  | { k: "tg_apply"; row: number } // the Telegram card's Apply: the exact payload and its Confirm
  | { k: "tg_confirm"; row: number } // the Confirm from the last tg_apply of that row (or a stale one)
  | { k: "world"; op: "new_posting" | "close" | "reprepare" | "elsewhere" | "unprepare"; row: number }
  | { k: "clock"; ms: number }
  | { k: "phone_change" }
  | { k: "signout"; dev: Device; all: boolean }
  | { k: "csrf"; dev: Device; row: number } // a cross-site form: the cookie rides along, the session's own value does not
  | { k: "foreign"; row: number } // another account's valid session taps this account's row
  | { k: "brute"; tries: number }; // a forwarded link: someone types numbers and codes
export type Kind = "journey" | "both_channels" | "race" | "expire" | "devices" | "render" | "security" | "brute";
export interface Scenario { id: number; kind: Kind; postings: PostingSpec[]; steps: Step[]; logoTpl: "default" | "custom" }

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: () => number, p: number) => r() < p;

// Text in every script the page must carry whole and escaped. Each posting's company and title also carry its number, so a test can
// find them (and find them where they must not be).
export const TEXT: Record<Script, (n: number) => string> = {
  latin: (n) => `Northwind Analytics ${n}`,
  long: (n) => `${"Consolidated International Holdings and Data Services ".repeat(6)}Group ${n}`,
  arabic: (n) => `شركة البيانات المتقدمة ${n}`,
  hebrew: (n) => `חברת הנתונים בע"מ ${n}.`,
  cjk: (n) => `株式会社データ分析 ${n}`,
  emoji: (n) => `🚀 Rocket Labs ${n}`,
  markup: (n) => `<img src=x onerror=alert(${n})>"'&<script>alert(${n})</script> Co ${n}`,
  bidi: (n) => `‮evil‬ Corp ⁧${n}⁩`,
  combining: (n) => `Ćafé Ünïcødé̈ GmbH ${n}`,
  astral: (n) => `𝔉𝔯𝔞𝔨𝔱𝔲𝔯 Analytics ${n}`,
};
export const TITLE: Record<Script, (n: number) => string> = {
  latin: (n) => `Senior Data Analyst ${n}`,
  long: (n) => `${"Supercalifragilisticexpialidocious".repeat(8)} Engineer ${n}`,
  arabic: (n) => `مهندس برمجيات أول (Senior) ${n}`,
  hebrew: (n) => `מהנדס/ת תוכנה ${n}!`,
  cjk: (n) => `データアナリスト ${n}`,
  emoji: (n) => `📊 Analyst ${n}`,
  markup: (n) => `"><svg onload=alert(${n})> Analyst ${n}`,
  bidi: (n) => `Analyst ‮${n}lmth.exe‬`,
  combining: (n) => `Analýst̃ ${n}`,
  astral: (n) => `𝓓𝓪𝓽𝓪 Analyst ${n}`,
};
export function descOf(s: PostingSpec): string | null {
  switch (s.desc) {
    case "none": return null;
    case "plain": return `<p>Build dashboards and own the weekly pricing report for the growth team (role ${s.n}).</p><ul><li>3 years of SQL</li></ul>`;
    case "long": return `<p>${"We are looking for someone to own the reporting pipeline end to end and to work closely with finance. ".repeat(60)}</p>`;
    case "markup": return `<p>Great role <script>alert(1)</script><img src=x onerror=alert(2)> <a href="javascript:alert(3)">apply</a> &lt;b&gt;</p>`;
    case "rtl": return `<p>אנחנו מחפשים אנליסט נתונים שיוביל את הדוחות השבועיים. نحن نبحث عن محلل بيانات. ${s.n}</p>`;
    // An emoji straddling the 150-character cut of the short description.
    case "emoji_cut": return `<p>${"a".repeat(148)}🚀🚀🚀 and more text after the cut ${s.n}</p>`;
  }
}

const SCRIPTS: Script[] = ["latin", "latin", "latin", "long", "arabic", "hebrew", "cjk", "emoji", "markup", "bidi", "combining", "astral"];
const APP_STATES: AppState[] = ["queued", "driving", "submitted_unconfirmed", "confirmed", "failed", "needs_user", "not_submitted", "unknown_outcome"];

function posting(r: () => number, n: number, kind: Kind): PostingSpec {
  const byHand = chance(r, kind === "render" ? 0.12 : 0.06);
  const url: UrlKind = byHand ? pick(r, ["linkedin", "indeed", "handshake"] as const) : chance(r, kind === "security" ? 0.08 : 0.01) ? pick(r, ["javascript", "data"] as const) : pick(r, ["greenhouse", "greenhouse", "lever", "ashby"] as const);
  const app = chance(r, kind === "render" ? 0.3 : 0.12) ? pick(r, APP_STATES) : null;
  const prepRoll = r();
  const prep: PrepKind | null = app ? null : prepRoll < 0.55 ? "plain" : prepRoll < 0.62 ? "secret" : prepRoll < 0.67 ? (kind === "security" ? "bad_dest" : "plain") : prepRoll < 0.70 ? "byhand_dest" : prepRoll < 0.76 ? "markup" : null;
  return {
    n, company: pick(r, SCRIPTS), title: pick(r, SCRIPTS), desc: pick(r, ["plain", "plain", "long", "markup", "rtl", "emoji_cut", "none"] as const),
    url, logo: pick(r, ["stated", "none", "none", "hostile"] as const),
    hasRow: url === "javascript" || url === "data" ? false : chance(r, 0.93), closed: chance(r, 0.07), deadlinePast: chance(r, 0.03),
    prep, app, wanted: !app && !prep && chance(r, 0.3),
  };
}

function stepsOf(r: () => number, kind: Kind, size: number): Step[] {
  const row = () => Math.floor(r() * Math.max(1, Math.min(size, 32)));
  const signIn = (dev: Device): Step[] => [{ k: "open", dev, path: "plain" }, { k: "phone", dev, who: "own" }, { k: "code", dev, right: true }];
  const s: Step[] = [{ k: "cards" }];
  switch (kind) {
    case "journey": {
      s.push(...signIn(0), { k: "view", dev: 0 });
      for (let i = 0, m = 2 + Math.floor(r() * 4); i < m; i++) s.push(chance(r, 0.15) ? { k: "applyall", dev: 0 } : { k: "apply", dev: 0, row: row(), tag: chance(r, 0.85) ? "shown" : "none", js: chance(r, 0.5) });
      if (chance(r, 0.5)) s.push({ k: "view", dev: 0, text: true });
      break;
    }
    case "both_channels": {
      const i = row();
      s.push(...signIn(0), { k: "view", dev: 0 });
      // Telegram's card first or the page first, then the other one acts on the same posting.
      if (chance(r, 0.5)) s.push({ k: "tg_apply", row: i }, { k: "apply", dev: 0, row: i, tag: "shown", js: chance(r, 0.5) }, { k: "tg_confirm", row: i });
      else s.push({ k: "tg_apply", row: i }, { k: "tg_confirm", row: i }, { k: "apply", dev: 0, row: i, tag: "shown", js: chance(r, 0.5) });
      if (chance(r, 0.4)) s.push({ k: "tg_confirm", row: i });
      s.push({ k: "view", dev: 0 });
      break;
    }
    case "race": {
      s.push(...signIn(0), { k: "view", dev: 0 });
      for (let i = 0, m = 1 + Math.floor(r() * 3); i < m; i++) s.push({ k: "world", op: pick(r, ["new_posting", "close", "reprepare", "elsewhere", "unprepare"] as const), row: row() });
      for (let i = 0, m = 1 + Math.floor(r() * 3); i < m; i++) s.push(chance(r, 0.3) ? { k: "applyall", dev: 0 } : { k: "apply", dev: 0, row: row(), tag: pick(r, ["shown", "shown", "stale", "forged", "none"] as const), js: chance(r, 0.5) });
      break;
    }
    case "expire": {
      s.push(...signIn(0), { k: "view", dev: 0 });
      if (chance(r, 0.5)) s.push({ k: "apply", dev: 0, row: row(), tag: "shown", js: false });
      s.push({ k: "clock", ms: pick(r, [119 * 60_000, 2 * 3600_000, 2 * 3600_000 + 1, 5 * 3600_000]) });
      s.push(chance(r, 0.7) ? { k: "apply", dev: 0, row: row(), tag: "shown", js: chance(r, 0.5) } : { k: "applyall", dev: 0 });
      if (chance(r, 0.4)) s.push({ k: "view", dev: 0 });
      // A fresh link after the expiry signs in again.
      if (chance(r, 0.5)) s.push(...signIn(0), { k: "apply", dev: 0, row: row(), tag: "shown", js: false });
      break;
    }
    case "devices": {
      s.push(...signIn(0), ...signIn(1), { k: "view", dev: 0 }, { k: "view", dev: 1 });
      const op = r();
      if (op < 0.4) s.push({ k: "signout", dev: 1, all: true });
      else if (op < 0.7) s.push({ k: "signout", dev: 1, all: false });
      else s.push({ k: "phone_change" });
      s.push({ k: "apply", dev: 0, row: row(), tag: "shown", js: chance(r, 0.5) }, { k: "apply", dev: 1, row: row(), tag: "shown", js: false });
      if (chance(r, 0.3)) s.push({ k: "applyall", dev: 0 });
      break;
    }
    case "render": {
      s.push(...signIn(0), { k: "view", dev: 0 }, { k: "view", dev: 0, text: true });
      if (chance(r, 0.5)) s.push({ k: "apply", dev: 0, row: row(), tag: "shown", js: false });
      break;
    }
    case "security": {
      const which = r();
      if (which < 0.2) s.push({ k: "open", dev: 0, path: pick(r, ["double_slash", "backslash"] as const) }, { k: "phone", dev: 0, who: "own" }, { k: "code", dev: 0, right: true }, { k: "view", dev: 0 });
      else if (which < 0.4) s.push({ k: "open", dev: 0, path: "plain", plant: pick(r, ["random", "other_account"] as const) }, { k: "phone", dev: 0, who: "own" }, { k: "code", dev: 0, right: true }, { k: "view", dev: 0 });
      else if (which < 0.55) s.push({ k: "open", dev: 0, path: "plain", crawler: true }, ...signIn(0), { k: "view", dev: 0 });
      else s.push(...signIn(0), { k: "view", dev: 0 });
      for (let i = 0, m = 1 + Math.floor(r() * 3); i < m; i++) s.push(pick(r, [{ k: "csrf", dev: 0, row: row() }, { k: "foreign", row: row() }, { k: "apply", dev: 0, row: row(), tag: "forged", js: false }, { k: "apply", dev: 0, row: row(), tag: "shown", js: false }] as Step[]));
      break;
    }
    case "brute": {
      s.push({ k: "open", dev: 1, path: "plain" }, { k: "brute", tries: 2 + Math.floor(r() * 8) });
      if (chance(r, 0.5)) s.push({ k: "open", dev: 1, path: "plain" }, { k: "phone", dev: 1, who: pick(r, ["stranger", "garbage", "own"] as const) }, { k: "code", dev: 1, right: false });
      s.push(...signIn(0), { k: "view", dev: 0 });
      break;
    }
  }
  return s;
}

const KINDS: [Kind, number][] = [["journey", 0.22], ["both_channels", 0.16], ["race", 0.16], ["expire", 0.1], ["devices", 0.1], ["render", 0.1], ["security", 0.11], ["brute", 0.05]];
export function generate(o: { seed: number; count: number }): Scenario[] {
  const r = rng(o.seed);
  const out: Scenario[] = [];
  for (let id = 1; id <= o.count; id++) {
    let x = r(), kind: Kind = "journey";
    for (const [k, p] of KINDS) { if (x < p) { kind = k; break; } x -= p; }
    const size = kind === "render" ? (chance(r, 0.4) ? 30 + Math.floor(r() * 16) : 8 + Math.floor(r() * 22)) : 1 + Math.floor(r() * (chance(r, 0.15) ? 40 : 8));
    const postings = Array.from({ length: size }, (_, i) => posting(r, i + 1, kind));
    out.push({ id, kind, postings, steps: stepsOf(r, kind, size), logoTpl: chance(r, 0.5) ? "default" : "custom" });
  }
  return out;
}
export function sample<T>(xs: T[], n: number, seed: number): T[] {
  const r = rng(seed), a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
