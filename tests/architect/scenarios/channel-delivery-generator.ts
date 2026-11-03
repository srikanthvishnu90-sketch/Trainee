// Channel delivery at scale (2026-10-29): a deterministic, seeded generator of what Trainee sends on Telegram, WhatsApp and
// iMessage, and of what people text back, each with what must happen. The product code is never consulted here: every
// expectation (the words a person must read, in order; every link, once and whole; the command a text is) comes from how
// the scenario was built.
//
//   render    a reply as the brain writes it (markdown-flavoured: **bold**, *italic*, _italic_, __bold__, ~~strike~~,
//             `code`, ***both***, # headings, - * • 1. lists, > quotes, | tables |, ``` fences, --- rules), with links in
//             every shape a reply carries them (bare, "here: <link>.", "(<link>)", [label](<link>), [<link>](<link>),
//             <link>, "<link>", **<link>**, a link and a longer one that starts with it, a link with its own brackets
//             (…/wiki/Foo_(bar)), with "__", "*", "~", "%", "&", "#" in it, tracking links of 300-900 characters), emoji
//             (skin tones, flags, ZWJ sequences), CJK, accents, "AT&T" and "<script>", part counters the model wrote
//             ("(1/3)" on each part) and fractions that are content ("rating (4/5)"); up to 3,900 characters (what the
//             outbox holds); on each channel, with CAREER_TEXTING_NATIVE on and off.
//   split     long replies made to be split: a paragraph of 2,000-3,800 characters, a sentence with no stop, a line of
//             links, a link of 700-1,450 characters inside a long line, a token longer than a whole message (a pasted
//             hash; CJK with no spaces), an emoji flood with no spaces; and a reply in parts (agent-chat's `parts`) of up
//             to 160 parts, some over 4,000 characters.
//   command   what a person texts that may be STOP, START or HELP: every keyword in every case, with the punctuation,
//             quotes, spaces and invisible characters phones add, and with words after it (a message, not a command); on
//             each channel (CANCEL, END and QUIT are SMS words only, WO-091c).
//   optout    a person's queued messages around a STOP: proactive ones (alert, report, card, brief, digest, status,
//             receipt, followup, link) and answers to messages sent before and after it, then START.
//   buttons   Telegram buttons whose callback data is ASCII, exactly 64 bytes, over 64 bytes, non-ASCII, empty.
//   window    WhatsApp rows inside and outside the 24-hour window, answers and proactive, template configured or not.
//   provider  a provider failing on a given bubble in a given way (429, 502, 503, 500, 504, network, timeout, 403
//             blocked), run after run.
//   inbound   the same provider message delivered again (webhook retries) and two people texting at once.

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
export type R = ReturnType<typeof rng>;
export const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const chance = (r: R, p: number) => r() < p;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export type Ch = "telegram" | "whatsapp" | "imessage";
export const NOW = Date.parse("2026-10-29T15:00:00Z");

// ------------------------------------------------------------------------------------------------ text pieces
const WORDS = ["data", "analyst", "role", "Acme", "Chicago", "remote", "salary", "interview", "résumé", "Müller", "naïve", "café", "São", "Paulo",
  "Zürich", "東京", "データ", "데이터", "Python", "SQL", "dashboards", "$120,000", "15.49", "3.5%", "Q4", "team", "hiring", "manager", "next", "week",
  "apply", "tailored", "offer", "benefits", "401k", "New", "York", "AT&T", "R&D", "C++", "Node.js", "<script>", "snake_case_name", "file_name.pdf",
  "deadline", "Friday", "recruiter", "Initech", "Globex", "Hooli", "onsite", "hybrid", "Seattle", "Toronto", "Δelta", "Ωmega", "Łódź", "İstanbul"];
const EMOJI = ["🚀", "👍🏽", "🇺🇸", "👩‍💻", "✅", "📌", "🎉", "😀", "🙏🏿", "🏳️‍🌈"];
const COMPANIES = ["acme", "globex", "initech", "hooli", "umbrella", "vandelay", "wonka", "cyberdyne"];

export interface Text { md: string; vis: string; urls: string[] }
const T = (md: string, vis = md, urls: string[] = []): Text => ({ md, vis, urls });
const join = (xs: Text[], sep: string, visSep = sep): Text => ({ md: xs.map((x) => x.md).join(sep), vis: xs.map((x) => x.vis).join(visSep), urls: xs.flatMap((x) => x.urls) });

let urlSerial = 0;
const alnum = (r: R, n: number) => { let s = ""; const A = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; for (let i = 0; i < n; i++) s += A[Math.floor(r() * A.length)]; return s; };
// A link that ends the way links end (a letter, a digit, "/" or its own ")"), unique in the whole run.
export function url(r: R, long = false): string {
  const id = `${++urlSerial}${alnum(r, 4)}`, co = pick(r, COMPANIES);
  if (long) return `https://click.example.com/track?u=${alnum(r, int(r, 300, 900))}&id=${id}`;
  return pick(r, [
    () => `https://boards.greenhouse.io/${co}/jobs/${id}`,
    () => `https://jobs.lever.co/${co}/${id}-4f2a-9c1e`,
    () => `https://jobs.ashbyhq.com/${co}/${id}?utm_source=trainee&utm_medium=sms`,
    () => `https://${co}.wd5.myworkdayjobs.com/en-US/External/job/New-York-NY/Data-Analyst_R${id}`,
    () => `https://en.wikipedia.org/wiki/${pick(r, ["Mercury", "Python", "Java"])}_(${pick(r, ["planet", "language", "island"])})_${id}_(note)`,
    () => `https://example.com/jobs/__internal__/${id}`,
    () => `https://example.com/search?q=data+analyst&loc=NYC&id=${id}#results`,
    () => `https://careers.example.com/~team/${id}/`,
    () => `https://example.com/a*b*c/${id}?x=1`,
    () => `https://example.com/path/%E2%9C%93/${id}`,
    () => `http://insecure.example.com/${id}`,
    () => `https://example.com/${id}/~edit~/v2`,
  ])();
}
const words = (r: R, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");
const sentence = (r: R, n = int(r, 4, 14)) => { const w = words(r, n); return `${w[0].toUpperCase()}${w.slice(1)}${pick(r, [".", ".", "!", "?"])}`; };

// Inline markdown around a few words, always closed properly and followed by a non-letter (CommonMark's rule).
function styled(r: R): Text {
  const w = words(r, int(r, 1, 3));
  const after = pick(r, [" ", ", ", ". ", "'s ", " — ", ": ", "! ", ") "]);
  const st = pick(r, ["**", "__", "*", "_", "~~", "`", "***", "nested", "plain", "plain"]);
  const tail = T(after);
  if (st === "plain") return join([T(w), tail], "");
  if (st === "nested") { const a = words(r, 1), b = words(r, 1), c = words(r, 1); return join([T(`**${a} *${b}* ${c}**`, `${a} ${b} ${c}`), tail], ""); }
  if (st === "`") { const code = pick(r, ["pip install pandas", "SELECT * FROM jobs", "snake_case", "git push", "x = 1"]); return join([T(`\`${code}\``, code), tail], ""); }
  return join([T(`${st}${w}${st}`, w), tail], "");
}
function proseLine(r: R): Text {
  const parts: Text[] = [T(sentence(r))];
  for (let i = int(r, 0, 3); i > 0; i--) parts.push(chance(r, 0.5) ? styled(r) : T(sentence(r)));
  if (chance(r, 0.25)) parts.push(T(pick(r, EMOJI)));
  return join(parts, " ");
}
// A link in one of the shapes replies carry it. vis: the words a person reads around it.
function linkLine(r: R, o: { long?: boolean; mdUrlLabel?: boolean } = {}): Text {
  const u = url(r, o.long);
  const lead = words(r, int(r, 1, 4));
  const shape = o.mdUrlLabel ? "mdself" : pick(r, ["mid", "end", "paren", "md", "mdself", "angle", "quote", "own", "item", "bold", "prefix", "two"]);
  switch (shape) {
    case "mid": { const tail = words(r, 2); return T(`${lead} ${u} ${tail}`, `${lead} ${tail}`, [u]); }
    case "end": return T(`Apply here: ${u}.`, "Apply here", [u]);
    case "paren": { const tail = words(r, 1); return T(`${lead} (${u}) — ${tail}`, `${lead} ${tail}`, [u]); }
    case "md": return T(`[${lead}](${u})`, lead, [u]);
    case "mdself": return T(`${lead}: [${u}](${u})`, lead, [u]);
    case "angle": return T(`${lead} <${u}>`, lead, [u]);
    case "quote": return T(`${lead} "${u}"`, lead, [u]);
    case "own": return T(u, "", [u]);
    case "item": return T(`- ${lead}: ${u}`, lead, [u]);
    case "bold": return T(`${lead} **${u}**`, lead, [u]);
    case "prefix": { const longer = `${u}/apply`; return T(`${lead} ${u} or ${longer}`, `${lead} or`, [u, longer]); }
    default: { const v = url(r); return T(`${lead} ${u} and ${v}`, `${lead} and`, [u, v]); }
  }
}
function block(r: R, o: { links: boolean }): Text {
  const k = pick(r, ["para", "para", "para", "heading", "list", "quote", "table", "fence", "rule", "links"]);
  switch (k) {
    case "heading": { const w = words(r, int(r, 1, 4)); const bold = chance(r, 0.3); return T(`${"#".repeat(int(r, 1, 3))} ${bold ? `**${w}**` : w}`, w); }
    case "list": {
      const marker = pick(r, ["- ", "* ", "• ", "1. "]);
      const items = Array.from({ length: int(r, 2, 6) }, (_, i) => {
        const it = chance(r, 0.4) ? styled(r) : T(words(r, int(r, 2, 8)));
        const m = marker === "1. " ? `${i + 1}. ` : marker;
        return T(`${m}${it.md.trimEnd()}`, `${marker === "1. " ? `${i + 1} ` : ""}${it.vis}`, it.urls);
      });
      return join(items, "\n", " ");
    }
    case "quote": { const p = proseLine(r); return T(`> ${p.md}`, p.vis, p.urls); }
    case "table": {
      const cols = int(r, 2, 3), rows = int(r, 1, 4);
      const head = Array.from({ length: cols }, () => words(r, 1)), body = Array.from({ length: rows }, () => Array.from({ length: cols }, () => words(r, int(r, 1, 2))));
      const md = [`| ${head.join(" | ")} |`, `|${Array(cols).fill("---").join("|")}|`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
      return T(md, [...head, ...body.flat()].join(" "));
    }
    case "fence": { const lines = Array.from({ length: int(r, 1, 3) }, () => words(r, int(r, 2, 5))); return T("```\n" + lines.join("\n") + "\n```", lines.join(" ")); }
    case "rule": return T(pick(r, ["---", "***", "___"]), "");
    case "links": if (o.links) return linkLine(r); return proseLine(r);
    default: {
      const lines = Array.from({ length: int(r, 1, 3) }, () => (o.links && chance(r, 0.35) ? linkLine(r) : proseLine(r)));
      return join(lines, "\n", " ");
    }
  }
}

// ------------------------------------------------------------------------------------------------ scenarios
export interface RenderScenario {
  kind: "render" | "split"; id: number; category: string; channel: Ch; native: boolean;
  text: string;
  words: string[]; // what the person reads, in order, with CAREER_TEXTING_NATIVE on (the model's own counters taken out)
  rawWords: string[]; // the same as written (counters kept), what the plain renderers keep
  urls: string[]; // each link, exactly as written, once each
  giant: string[]; // tokens longer than a whole message: the only words that may be cut (into pieces that join back)
  astral: number; // characters outside the BMP (emoji, flags): none lost, none cut in half
}
export interface PartsScenario { kind: "parts"; id: number; category: string; parts: string[]; words: string[] }
export interface CommandScenario { kind: "command"; id: number; category: string; text: string; channel: Ch | "sms" | undefined; expect: "stop" | "start" | "help" | null }
export interface OptoutScenario {
  kind: "optout"; id: number; category: string; channel: Ch; stopAt: number; startAt: number | null;
  rows: { key: string; at: number; proactive: boolean }[];
}
export interface ButtonsScenario { kind: "buttons"; id: number; category: string; buttons: { text: string; data: string }[][]; valid: boolean[][] }
export interface WindowScenario {
  kind: "window"; id: number; category: string; lastInboundAgoMs: number | null; nudgedAgoMs: number | null; template: boolean; optedOut: boolean;
  rows: { key: string; reply: boolean }[]; sendFailCode: number | null;
}
export interface ProviderScenario { kind: "provider"; id: number; category: string; channel: Ch; bubbles: number; failAt: number; mode: string; reply: boolean }
export interface InboundScenario { kind: "inbound"; id: number; category: string; channel: Ch; deliveries: number; people: number; sameIdOtherProvider: boolean }
export type Scenario = RenderScenario | PartsScenario | CommandScenario | OptoutScenario | ButtonsScenario | WindowScenario | ProviderScenario | InboundScenario;

const tokens = (s: string): string[] => s.match(/[\p{L}\p{N}]+/gu) ?? [];
const astralOf = (s: string) => (s.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length;

function renderScenario(r: R, id: number): RenderScenario {
  const channel = pick(r, ["telegram", "whatsapp", "imessage"] as const), native = chance(r, 0.6);
  const blocks: Text[] = [];
  const counters = chance(r, 0.08), fractions = !counters && chance(r, 0.08);
  let len = 0, target = pick(r, [120, 300, 600, 1200, 2000, 3000, 3800]);
  let counterWords: string[] = [];
  const n = counters ? int(r, 2, 4) : 0;
  for (let i = 0; len < target || i < n; i++) {
    let b = block(r, { links: true });
    if (counters && i < n) { const lead = `(${i + 1}/${n}) `; counterWords = [...counterWords, String(i + 1), String(n)]; b = T(lead + proseLine(r).md, "", []); b = { ...b, vis: tokens(b.md.slice(lead.length)).join(" ") }; }
    if (fractions && i === 0) b = T(`Glassdoor rating (4/5)\n(3/4) of the roles are remote`, "Glassdoor rating 4 5 3 4 of the roles are remote");
    if (len + b.md.length + 2 > 3900) break;
    blocks.push(b); len += b.md.length + 2;
  }
  const doc = join(blocks, "\n\n", " ");
  const vis = doc.vis;
  const w = tokens(vis);
  // The counters the model wrote: native takes them out of what is read; the raw renderers keep them.
  let raw = w;
  if (counters) {
    raw = [];
    blocks.forEach((b, i) => { if (i < n) raw.push(String(i + 1), String(n)); raw.push(...tokens(b.vis)); });
  }
  void counterWords;
  return { kind: "render", id, category: `render/${channel}/${native ? "native" : "plain"}${counters ? "/counters" : ""}${fractions ? "/fractions" : ""}`,
    channel, native, text: doc.md, words: w, rawWords: raw, urls: doc.urls, giant: [], astral: astralOf(doc.md) };
}

function splitScenario(r: R, id: number): RenderScenario {
  const channel = pick(r, ["telegram", "whatsapp", "imessage"] as const), native = chance(r, 0.6);
  const shape = pick(r, ["long-para", "no-stop", "link-lines", "long-link", "giant", "cjk", "emoji", "mixed"]);
  const max = channel === "imessage" ? 700 : 1500;
  let t: Text, giant: string[] = [];
  switch (shape) {
    case "long-para": { const ss: string[] = []; while (ss.join(" ").length < int(r, 2000, 3700)) ss.push(sentence(r)); t = T(ss.join(" ")); break; }
    case "no-stop": t = T(words(r, int(r, 200, 400))); break;
    case "link-lines": { const ls = Array.from({ length: int(r, 8, 30) }, () => linkLine(r)); t = join(ls, "\n", " "); break; }
    case "long-link": { const u = url(r, true); const pre = words(r, int(r, 20, 60)), post = words(r, int(r, 10, 40)); t = T(`${pre} ${u} ${post}`, `${pre} ${post}`, [u]); break; }
    case "giant": { const g = alnum(r, int(r, max + 50, max * 2 + 300)); giant = [g]; const a = words(r, int(r, 3, 30)), b = words(r, int(r, 3, 30)); t = T(`${a} ${g} ${b}`); break; }
    case "cjk": { let g = ""; while (g.length < max + int(r, 50, 600)) g += pick(r, ["東京", "データ", "分析", "求人", "応募", "面接"]); giant = [g]; t = T(`${words(r, 5)}\n\n${g}\n\n${words(r, 5)}`); break; }
    case "emoji": { const e = Array.from({ length: int(r, Math.ceil(max / 2) + 20, max + 200) }, () => pick(r, ["😀", "🚀", "✅", "🎉"])).join(""); t = T(`${words(r, 4)} ${e} ${words(r, 4)}`); break; }
    default: { const bs: Text[] = []; while (join(bs, "\n\n").md.length < 3000) bs.push(chance(r, 0.5) ? T(Array.from({ length: int(r, 3, 12) }, () => sentence(r)).join(" ")) : block(r, { links: true })); t = join(bs, "\n\n", " "); }
  }
  if (t.md.length > 3900) { // what the outbox holds: cut the generated text at a line, keeping its expectations exact
    const lines = t.md.split("\n"); let md = "";
    for (const l of lines) { if ((md + "\n" + l).length > 3900) break; md = md ? `${md}\n${l}` : l; }
    if (!md) md = t.md.slice(0, 3900);
    const keepUrls = t.urls.filter((u) => md.includes(u));
    t = T(md, md, keepUrls);
    let vis = md; for (const u of keepUrls) vis = vis.split(u).join(" ");
    t.vis = vis.replace(/\[([^\]]*)\]\(\s*\)/g, "$1");
    giant = giant.filter((g) => md.includes(g));
  }
  const w = tokens(t.vis);
  return { kind: "split", id, category: `split/${shape}/${channel}/${native ? "native" : "plain"}`, channel, native, text: t.md, words: w, rawWords: w, urls: t.urls, giant, astral: astralOf(t.md) };
}

function partsScenario(r: R, id: number): PartsScenario {
  const n = pick(r, [2, 3, 8, 30, 49, 50, 51, 60, 120, 160]);
  const parts = Array.from({ length: n }, (_, i) => {
    if (chance(r, 0.05)) return "   "; // an empty part from the chat is dropped, never sent
    const big = chance(r, 0.06);
    const ss: string[] = [`${i + 1}. ${words(r, 3)}`];
    while (ss.join(" ").length < (big ? int(r, 4100, 9000) : int(r, 40, 600))) ss.push(chance(r, 0.1) ? `\n${url(r)}` : sentence(r));
    return ss.join(" ");
  });
  return { kind: "parts", id, category: `parts/${n > 50 ? "over-50" : "up-to-50"}`, parts, words: tokens(parts.join(" ").replace(/https?:\/\/\S+/g, " ")) };
}

const STOPS = ["stop", "stopall", "unsubscribe"], SMS_STOPS = ["cancel", "end", "quit"], STARTS = ["start", "unstop"], HELPS = ["help", "info"];
function caseOf(r: R, w: string) { return pick(r, [w, w.toUpperCase(), w[0].toUpperCase() + w.slice(1), [...w].map((c) => (chance(r, 0.5) ? c.toUpperCase() : c)).join("")]); }
function commandScenario(r: R, id: number): CommandScenario {
  const channel = pick(r, ["telegram", "whatsapp", "imessage", "sms", undefined] as const);
  const family = pick(r, ["stop", "stop", "sms-stop", "start", "help", "message"]);
  const kw = family === "stop" ? pick(r, STOPS) : family === "sms-stop" ? pick(r, SMS_STOPS) : family === "start" ? pick(r, STARTS) : family === "help" ? pick(r, HELPS) : pick(r, STOPS);
  let text = caseOf(r, kw);
  // What phones and people put around a word: spaces, end punctuation (iOS's "…"), quotes, invisible characters.
  if (chance(r, 0.4)) text = pick(r, [" ", "  ", "\t", "\n", " "]) + text;
  if (chance(r, 0.5)) text += pick(r, [".", "!", "!!", "?", "...", "…", ",", ";", ":", " .", "!?", " "]);
  if (chance(r, 0.15)) text = pick(r, [["\"", "\""], ["“", "”"], ["'", "'"], ["‘", "’"]]).reduce((a, q, i) => (i === 0 ? q + a : a + q), text);
  if (chance(r, 0.1)) text = pick(r, ["​", "﻿", "⁠"]) + text + pick(r, ["", "​"]);
  let expect: CommandScenario["expect"] = family === "stop" ? "stop" : family === "sms-stop" ? (channel === "sms" || channel === undefined ? "stop" : null) : family === "start" ? "start" : family === "help" ? "help" : null;
  if (family === "message") {
    // A message that starts or ends with the word is a message ("stop sending me sales jobs", "please stop").
    text = pick(r, [`${text} sending me sales jobs`, `please ${text}`, `${text} it`, `can you ${text}`, `${text} the alerts for now`, `${text} 🛑`, `don't ${text}`]);
    expect = null;
  }
  return { kind: "command", id, category: `command/${family}/${channel ?? "none"}`, text, channel, expect };
}

const PROACTIVE = ["alert", "report", "card", "brief", "digest", "status", "receipt", "followup", "link"];
function optoutScenario(r: R, id: number): OptoutScenario {
  const channel = pick(r, ["telegram", "whatsapp", "imessage"] as const);
  const stopAt = NOW - int(r, 1, 120) * 60000;
  const rows: OptoutScenario["rows"] = [];
  for (let i = int(r, 2, 8); i > 0; i--) {
    const proactive = chance(r, 0.6), at = stopAt + (chance(r, 0.5) ? -1 : 1) * int(r, 1, 3600) * 1000;
    rows.push({ key: proactive ? `${pick(r, PROACTIVE)}:${id}-${i}` : `reply:${id}-${i}${chance(r, 0.4) ? `:${int(r, 1, 3)}` : ""}`, at: Math.min(at, NOW), proactive });
  }
  return { kind: "optout", id, category: `optout/${channel}`, channel, stopAt, startAt: chance(r, 0.3) ? NOW + 60000 : null, rows };
}
function buttonsScenario(r: R, id: number): ButtonsScenario {
  const datum = (): [string, boolean] => pick(r, [
    () => [`tca:0b6f7d3e-1c2a-4e5f-8a9b-0c1d2e3f4a5b:${alnum(r, 16).toLowerCase()}`, true] as [string, boolean],
    () => [`jca:${alnum(r, 12).toLowerCase()}`, true] as [string, boolean],
    () => { const s = alnum(r, 64); return [s, true] as [string, boolean]; },
    () => [alnum(r, int(r, 65, 120)), false] as [string, boolean],
    () => { const s = "é".repeat(int(r, 33, 40)); return [s, false] as [string, boolean]; },
    () => { const s = "é".repeat(int(r, 1, 32)); return [s, true] as [string, boolean]; },
    () => ["🚀".repeat(17), false] as [string, boolean],
    () => ["", false] as [string, boolean],
  ])();
  const rows = Array.from({ length: int(r, 1, 3) }, () => Array.from({ length: int(r, 1, 3) }, () => { const [d, ok] = datum(); return { text: pick(r, ["Approve", "Decline", "Approve all 12", "🚀".repeat(40), "Next 5 of 9 more"]), data: d, ok }; }));
  return { kind: "buttons", id, category: `buttons/${rows.flat().every((b) => b.ok) ? "valid" : "some-invalid"}`, buttons: rows.map((row) => row.map(({ text, data }) => ({ text, data }))), valid: rows.map((row) => row.map((b) => b.ok)) };
}
function windowScenario(r: R, id: number): WindowScenario {
  const H = 3600000;
  const lastInboundAgoMs = pick(r, [null, 5 * 60000, 3 * H, 23 * H, 23 * H + 49 * 60000, 23 * H + 51 * 60000, 24 * H, 30 * H, 72 * H]);
  const rows = Array.from({ length: int(r, 1, 5) }, (_, i) => { const reply = chance(r, 0.4); return { key: reply ? `reply:wa:${id}-${i}` : `${pick(r, PROACTIVE)}:${id}-${i}`, reply }; });
  return { kind: "window", id, category: `window/${lastInboundAgoMs === null ? "never" : lastInboundAgoMs < 23 * H + 50 * 60000 ? "open" : "closed"}`, lastInboundAgoMs,
    nudgedAgoMs: pick(r, [null, null, 2 * H, 40 * H]), template: chance(r, 0.6), optedOut: chance(r, 0.15), rows, sendFailCode: pick(r, [null, null, null, 131047, 131049, 131056]) };
}
function providerScenario(r: R, id: number): ProviderScenario {
  const channel = pick(r, ["telegram", "whatsapp", "imessage"] as const);
  const bubbles = int(r, 1, 4);
  return { kind: "provider", id, category: `provider/${channel}`, channel, bubbles, failAt: int(r, 0, bubbles - 1), mode: pick(r, ["ok", "429", "502", "503", "500", "504", "network", "timeout", "403"]), reply: chance(r, 0.5) };
}
function inboundScenario(r: R, id: number): InboundScenario {
  return { kind: "inbound", id, category: "inbound/dedupe", channel: pick(r, ["telegram", "whatsapp", "imessage"] as const), deliveries: int(r, 1, 4), people: int(r, 1, 3), sameIdOtherProvider: chance(r, 0.3) };
}

export const MIX: [Scenario["kind"], number][] = [["render", 3600], ["split", 1800], ["parts", 300], ["command", 2000], ["optout", 800], ["buttons", 500], ["window", 500], ["provider", 400], ["inbound", 100]];
export function generate(o: { seed?: number; count?: number } = {}): Scenario[] {
  const r = rng(o.seed ?? 20261029);
  urlSerial = 0;
  const total = MIX.reduce((a, [, n]) => a + n, 0), scale = (o.count ?? total) / total;
  const out: Scenario[] = [];
  let id = 0;
  for (const [kind, n] of MIX) {
    for (let i = 0; i < Math.round(n * scale); i++) {
      id++;
      out.push(kind === "render" ? renderScenario(r, id) : kind === "split" ? splitScenario(r, id) : kind === "parts" ? partsScenario(r, id) : kind === "command" ? commandScenario(r, id)
        : kind === "optout" ? optoutScenario(r, id) : kind === "buttons" ? buttonsScenario(r, id) : kind === "window" ? windowScenario(r, id) : kind === "provider" ? providerScenario(r, id) : inboundScenario(r, id));
    }
  }
  return out;
}
