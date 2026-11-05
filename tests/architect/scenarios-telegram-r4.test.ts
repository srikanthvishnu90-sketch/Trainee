// The Telegram chat flow, round 4 (architect, 2026-11-05; rounds 1-3: scenarios-telegram.test.ts, -r2, -r3): a FRESH seed (20261105)
// and about 10,000 generated scenarios on the pure functions the chat is made of: how a long answer is split into Telegram messages
// (channel_adapters.ts packMessages with the texting voice off, channel_voice.ts nativeRender with it on), the job card (caption, text
// card, Details pages, buttons, logo), every button's callback data and what a tap does with it (telegram_jobs.ts tapJob,
// channel_card_tap.ts tapCard), apply-all by yes (apply_all_yes.ts), STOP / START words, and the list links Telegram shows (the Mini
// App button and the signed link). No network, no model, no database, no wall clock. The strict invariants:
//   - a tap or a yes approves only the exact payload the person was shown, and only their own (a tampered button, another person's
//     button, a payload that changed since it was shown, a second tap: nothing more approved);
//   - a changed, stale or unknown payload is refused in words (never a silent nothing, never an internal code);
//   - no message exceeds Telegram's limits (4,096 a message, 1,024 a caption, 64 bytes of callback data), none is invalid UTF-16,
//     and no split breaks a link, a code block or a list item, loses a sentence, repeats one, or reorders them;
//   - nothing is approved for someone who sent STOP after the offer, or whose account is paused, and nothing is queued for them;
//   - no fact about the person appears that the scenario did not give (names only from the postings, counts only from results);
//   - no internal code or id leaks into text (user ids, refs, tags, payload hashes, list ids, job ids, prepared ids, error codes).
// Categories:
//   split   long answers of prose, lists, links (bare, in brackets, markdown) and fenced code blocks (indented, blank lines inside,
//           "*" "_" "<" "&" in code, a link in code), voice off and on, at and around the 1,500 and 4,096 limits
//   card    postings with long, emoji, HTML-carrying, missing and future-dated fields: caption, text card, Details, buttons, logo
//   tap     Apply / Confirm / Edit / Cancel / Details / Next and the card's Approve / Decline: tampered data, another person's,
//           a changed payload, double taps, stale cards, answered and expired cards
//   yes     "yes" and its near misses (D-MS-1 words only) against fresh, stale, future, malformed and spent offers, changed, dismissed,
//           unprepared and held-back roles, a paused list or account, a STOP before or after the offer
//   stop    STOP / START words on Telegram, their replies, and what a STOP recorded before or after an offer does to it
//   links   the mass list's line, its Mini App button and signed link, Apply here
// Run: deno test -A --no-check tests/architect/scenarios-telegram-r4.test.ts   (TG4_ONLY=split,yes runs those alone; TG4_SCALE=0.1)
import assertNode from "node:assert/strict";
import { rng } from "./scenarios/telegram-r3-world.ts";
import { decode, htmlProblem, LONE } from "./scenarios/telegram-bot-api.ts";
import { packMessages } from "../../supabase/functions/_shared/channel_adapters.ts";
import { nativeRender, telegramPlain } from "../../supabase/functions/_shared/channel_voice.ts";
import { findUrls } from "../../supabase/functions/_shared/channel_text.ts";
import { inlineKeyboard, parseTelegramUpdate, TELEGRAM_CAPTION, TELEGRAM_CHARS } from "../../supabase/functions/_shared/telegram.ts";
import {
  captionOf, confirmButtons, detailsOf, hashTag, jobButtons, type JobDeps, type JobStore, jobViewOf, type JobView, logoUrl, parseJobTap, type PostingRow, type PreparedRow,
  refOf, sendJobCards, tapJob, GONE_REPLY,
} from "../../supabase/functions/_shared/telegram_jobs.ts";
import { cardButtons, parseTap, tapCard, type TapCard, type TapStore, TAP_ANSWERED, TAP_CHANGED, TAP_EXPIRED, TAP_STALE, TAP_UNKNOWN } from "../../supabase/functions/_shared/channel_card_tap.ts";
import * as AY from "../../supabase/functions/_shared/apply_all_yes.ts";
import { channelCommand, CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";

const { applyAllYesTurn, isApplyAllYes, offerOf, offerQuestion, OFFER_WINDOW_MS } = AY;
// round 4's two rules, read through the namespace so this file runs against the code before the fix too (and fails there)
const STOPPED_AFTER_OFFER_REPLY = (AY as Record<string, unknown>).STOPPED_AFTER_OFFER_REPLY as string | undefined;
const SEED = 20261105;
const SCALE = Number(Deno.env.get("TG4_SCALE") || 1);
const ONLY = new Set((Deno.env.get("TG4_ONLY") ?? "").split(",").filter(Boolean));
const NOW = Date.parse("2026-11-05T15:00:00Z"), MIN = 60000, DAY = 86400000;
const A = "aaaaaaaa-1111-4111-8111-111111111111", B = "bbbbbbbb-2222-4222-8222-222222222222";

// ------------------------------------------------------------------------------------------------ the report
type Finding = { id: string; why: string };
const findings = new Map<string, Finding[]>();
const totals: Record<string, number> = {};
function grade(cat: string, id: string, whys: string[]) {
  totals[cat] = (totals[cat] ?? 0) + 1;
  for (const why of [...new Set(whys)].slice(0, 4)) {
    const key = `${cat}: ${why.replace(/[0-9a-f]{10,}|\d{2,}/g, "#").slice(0, 110)}`;
    const xs = findings.get(key) ?? [];
    xs.push({ id, why });
    findings.set(key, xs);
  }
}
function report(cat: string) {
  const mine = [...findings.entries()].filter(([k]) => k.startsWith(`${cat}:`));
  const lines = mine.sort((a, b) => b[1].length - a[1].length).flatMap(([k, xs]) => [`  ${xs.length}x ${k}`, ...xs.slice(0, 2).map((x) => `      #${x.id}: ${x.why.slice(0, 500)}`)]);
  console.log(`[tg-r4] ${cat}: ${totals[cat] ?? 0} scenarios, ${new Set(mine.flatMap(([, xs]) => xs.map((x) => x.id))).size} failed`);
  assertNode.deepStrictEqual(lines, [], `${cat}:\n${lines.slice(0, 40).join("\n")}`);
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// Internal words that are never the person's: error codes, statuses, the buttons' own data, placeholders a template forgot.
const INTERNAL = /\b(?:card_changed|card_stale|card_expired|card_answered|duplicate_job|daily_cap|not_plain|apply_all_offer|apply_all_done|payload_hash|prepared_id|job_id|user_id|unreadable|undefined|NaN|\[object Object\])\b|\bnull\b|\bjc[adsxeyn]:|\btc[ad]:|Invalid Date/;
function leaks(text: string, ids: string[]): string | null {
  const m = INTERNAL.exec(text);
  if (m) return `an internal word in the text: ${JSON.stringify(m[0])}`;
  for (const id of ids) if (id && id.length >= 8 && text.includes(id)) return `an internal id in the text: ${id.slice(0, 20)}`;
  return null;
}

// ================================================================================================ split
// A long answer the brain might write: prose with one token per sentence, lists with one per item, links, fenced code with one
// per line. Every token is unique, so loss, repetition and reordering are visible.
type Piece = { kind: "s" | "li" | "url" | "code"; token: string; text: string; indent?: string };
const WORDS = ["the", "role", "pays", "well", "and", "asks", "for", "SQL", "R&D", "a <5 year", "team", "in", "Austin", "remote", "résumé", "日本語", "🙂", "👩‍💻", "🇺🇸", "naïve", "Zoë", "x > y", "interview", "prep", "practice", "salary", "offer", "deadline"];
const CODE_BITS = ["x * y", "a_b_c", "if (n < 0) return -1;", "s = \"<b>&amp;</b>\"", "for i in range(n):", "seen[n] = i", "# keep *this*", "//_not italic_", "SELECT * FROM jobs WHERE pay > 30;", "return [seen[t - n], i]", "curl https://api.example.test/v1/jobs?q=a&b=c"];
function genAnswer(r: ReturnType<typeof rng>, id: number, target: number): { text: string; pieces: Piece[] } {
  const pieces: Piece[] = [], blocks: string[] = [];
  let k = 0, len = 0;
  const words = (n: number) => Array.from({ length: n }, () => r.pick(WORDS)).join(" ");
  while (len < target) {
    const kind = r.pick(["prose", "prose", "list", "url", "code", "longpara"] as const);
    let block = "";
    if (kind === "prose" || kind === "longpara") {
      const n = kind === "longpara" ? r.int(12, 30) : r.int(1, 6);
      const ss: string[] = [];
      for (let i = 0; i < n; i++) { const t = `s${id}k${++k}`; const s = `${t} ${words(r.int(3, 40))}.`; ss.push(s); pieces.push({ kind: "s", token: t, text: s }); }
      block = ss.join(" ");
    } else if (kind === "list") {
      const n = r.int(2, 12), marker = r.pick(["- ", "• ", "* ", "1. "]);
      const items: string[] = [];
      for (let i = 0; i < n; i++) { const t = `li${id}k${++k}`; const body = `${t} ${words(r.int(2, r.chance(0.1) ? 120 : 25))}`; items.push(`${marker === "1. " ? `${i + 1}. ` : marker}${body}`); pieces.push({ kind: "li", token: t, text: body }); }
      block = items.join("\n");
    } else if (kind === "url") {
      const t = `u${id}k${++k}`;
      const url = `https://boards.greenhouse.io/acme/jobs/${t}${r.chance(0.5) ? `?gh_src=${"q".repeat(r.int(1, 200))}&utm=x` : ""}${r.chance(0.2) ? "/Foo_(bar)" : ""}`;
      const shape = r.pick(["bare", "label", "paren", "md"] as const);
      block = shape === "bare" ? url : shape === "label" ? `Apply here: ${url}` : shape === "paren" ? `The posting (${url}) is open.` : `[Acme role](${url})`;
      pieces.push({ kind: "url", token: t, text: url });
    } else {
      const lang = r.pick(["", "python", "sql", "js"]);
      const n = r.int(2, r.chance(0.15) ? 90 : 18);
      const lines: string[] = [];
      for (let i = 0; i < n; i++) {
        if (i > 0 && r.chance(0.12)) lines.push("");
        const t = `c${id}k${++k}`, indent = " ".repeat(r.pick([0, 0, 2, 4, 4, 8, 12]));
        const line = `${indent}${r.pick(CODE_BITS)} ${t}`;
        lines.push(line); pieces.push({ kind: "code", token: t, text: line.trimStart(), indent });
      }
      block = "```" + lang + "\n" + lines.join("\n") + "\n```";
    }
    if (len + block.length + 2 > 4000) { pieces.splice(pieces.length - (block.split(/s\d+k|li\d+k|u\d+k|c\d+k/).length - 1)); if (blocks.length) break; continue; } // the outbox holds at most 4,000
    blocks.push(block);
    len += block.length + 2;
  }
  return { text: blocks.join("\n\n"), pieces };
}
// Each message as Telegram shows it: the plain text, and which characters of it are code.
function shown(msg: string, native: boolean): { plain: string; code: string[]; prose: string } {
  if (native) {
    const code: string[] = [];
    const prose = msg.replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, c: string) => { code.push(decode(c)); return "\n"; });
    return { plain: decode(msg), code, prose: decode(prose) };
  }
  const code: string[] = [];
  const prose = msg.replace(/^\s*```[^\n]*\n([\s\S]*?)\n\s*```\s*$/gm, (_m, c: string) => { code.push(c); return "\n"; });
  return { plain: msg, code, prose };
}
async function splitScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const native = r.chance(0.5);
  const target = r.pick([1400, 1500, 1501, 1600, 2900, 3000, 3990, 4000]) + r.int(-60, 60);
  const { text, pieces } = genAnswer(r, id, target);
  const msgs = native ? nativeRender("telegram", 1500)(text) : packMessages(text, 1500);
  if (!msgs.length) return ["nothing to send for a non-empty answer"];
  const views = msgs.map((m) => shown(m, native));
  msgs.forEach((m, i) => {
    const sentText = native && m.length > TELEGRAM_CHARS && telegramPlain(m).length <= TELEGRAM_CHARS ? telegramPlain(m) : m;
    if (sentText.length > TELEGRAM_CHARS) whys.push(`message ${i + 1} is ${sentText.length} characters (over 4,096)`);
    if (LONE.test(m)) whys.push(`message ${i + 1} carries half a character`);
    if (!m.trim()) whys.push(`message ${i + 1} is empty`);
    if (native) { const p = htmlProblem(m); if (p) whys.push(`message ${i + 1} is HTML Telegram refuses: ${p}`); }
  });
  const all = views.map((v) => v.plain).join("\n");
  // Every token's positions, from one scan of the text.
  const pos = new Map<string, number[]>();
  for (const m of all.matchAll(/(?<![A-Za-z0-9])(?:s|li|u|c)\d+k\d+(?![0-9])/g)) { const xs = pos.get(m[0]) ?? []; xs.push(m.index!); pos.set(m[0], xs); }
  const at = (tok: string) => pos.get(tok) ?? [];
  let last = -1;
  for (const p of pieces) {
    const hits = at(p.token);
    if (hits.length !== 1) { whys.push(`${p.kind} ${p.token} appears ${hits.length} times`); continue; }
    if (hits[0] < last) whys.push(`${p.kind} ${p.token} is out of order`);
    last = hits[0];
    // With the voice off a paragraph over 1,500 is wrapped at its last space (conversation.ts splitLong: only at spaces): every word
    // whole. With it on, a sentence that fits stays in one message (channel_voice.ts splitNatural).
    if (p.kind === "s" && !native) for (const word of p.text.slice(0, -1).split(" ")) if (word && !views.some((v) => v.prose.split(/\s+/).includes(word) || v.prose.split(/\s+/).includes(`${word}.`))) { whys.push(`a word was cut: ${p.token}`); break; }
    if (p.kind === "s" && native && p.text.length <= 1400 && !views.some((v) => norm(v.prose).includes(norm(p.text)))) {
      whys.push(`a sentence was split across messages or changed: ${p.token}`);
      if (Deno.env.get("TG4_DEBUG") === String(id)) console.log(JSON.stringify({ native, sentence: p.text, msgs: views.map((v) => v.plain.slice(0, 3000)) }, null, 1));
    }
    if (p.kind === "li" && p.text.length <= 1400 && !views.some((v) => norm(v.prose).includes(norm(p.text)))) whys.push(`a list item was split across messages or changed: ${p.token}`);
    if (p.kind === "url" && p.text.length <= 1400 && !views.some((v) => findUrls(v.plain).some((u) => u.url === p.text))) whys.push(`a link was broken: ${p.token}`);
    if (p.kind === "code") {
      const inCode = views.some((v) => v.code.some((c) => c.split("\n").includes(`${p.indent}${p.text}`)));
      if (!inCode) whys.push(`a code line lost its block or its indentation: ${p.token}`);
      if (views.some((v) => v.prose.includes(p.token))) whys.push(`a code line was shown as prose: ${p.token}`);
    }
    if ((p.kind === "s" || p.kind === "li") && views.some((v) => v.code.some((c) => c.includes(p.token)))) whys.push(`prose was shown as code: ${p.token}`);
  }
  return whys;
}

// ================================================================================================ card
const NASTY = ["R&D <Lab>", "Acme & Sons", "<script>x</script>", "Zoë 🇺🇸 Labs", "👩‍💻 Dev", "Foo_Bar *Inc*", "`tick`", "A".repeat(300), "日本語チーム", "  spaced  out  ", "", "&nbsp;Co"];
function hitOf(r: ReturnType<typeof rng>, id: number): any {
  const company = r.chance(0.7) ? `TEST Co ${id}` : `TEST ${r.pick(NASTY)} ${id}`;
  const host = r.pick(["boards.greenhouse.io/test", "jobs.lever.co/test", "www.linkedin.com/jobs/view", `careers.testco${id}.com`, "test.bamboohr.com/careers"]);
  return {
    job_id: `${r.pick(["greenhouse", "lever", "ashby"])}:test:${id}`, company, title: r.chance(0.2) ? r.pick(NASTY) + " Engineer" : `Data Analyst ${id}`,
    location: r.chance(0.2) ? "" : r.pick(["Austin, TX", "Remote", "Chicago, IL", "日本 東京"]), url: `https://${host}/${id}`,
    pay: r.chance(0.4) ? r.pick(["$30/hr", "$120k-$140k", "€50,000", "Up to $45 per hour"]) : null, level: r.chance(0.3) ? "Intern" : null,
    first_seen_at: r.chance(0.8) ? new Date(NOW - r.int(-3 * DAY, 30 * DAY)).toISOString() : r.pick([null, "not a date", ""]),
    deadline: r.chance(0.3) ? r.pick([new Date(NOW + 5 * DAY).toISOString(), "garbage", ""]) : null,
    ...(r.chance(0.3) ? { company_domain: r.pick(["linkedin.com", `testco${id}.com`, "lever.co", "bad domain"]) } : {}),
    fit: r.chance(0.5) ? { reasons: Array.from({ length: r.int(0, 6) }, () => r.pick(NASTY) + " fits"), gaps: Array.from({ length: r.int(0, 3) }, () => "no SQL") } : undefined,
  };
}
function rowOf(r: ReturnType<typeof rng>, hit: any): PostingRow {
  const bullets = Array.from({ length: r.int(0, 80) }, (_, i) => `<li>req${i}x ${"knows SQL and Excel well ".repeat(r.int(1, r.chance(0.05) ? 60 : 4))}</li>`).join("");
  return { job_id: hit.job_id, provider: hit.job_id.split(":")[0], company: hit.company, title: hit.title, location: hit.location, url: hit.url,
    description: r.chance(0.8) ? `<p>About us.</p><h3>${r.pick(["Requirements", "Qualifications", "What you'll need", "Duties"])}</h3><ul>${bullets}</ul>` : null,
    seniority_band: r.chance(0.3) ? "intern" : null, posted_at: r.chance(0.5) ? new Date(NOW - r.int(0, 9) * DAY).toISOString() : null, first_seen_at: hit.first_seen_at, pay: null, closed_at: null };
}
async function cardScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const hit = hitOf(r, id), row = rowOf(r, hit);
  const job = jobViewOf(hit, row);
  const env = { get: (k: string) => (k === "TRAINEE_LOGO_GUESS" ? (r.chance(0.2) ? "on" : undefined) : undefined) };
  const ref = await refOf(A, job.job_id);
  const ids = [A, ref, job.job_id];
  const cap = captionOf(job, NOW);
  if (cap.length > TELEGRAM_CAPTION) whys.push(`the caption is ${cap.length} characters`);
  if (LONE.test(cap)) whys.push("the caption carries half a character");
  const lk = leaks(cap, ids); if (lk) whys.push(`caption: ${lk}`);
  if (/^Pay:/m.test(cap) !== !!job.pay) whys.push("a Pay line that the posting does not state, or a stated pay left out");
  if (/^Apply by:/m.test(cap) && !(hit.deadline && !Number.isNaN(Date.parse(hit.deadline)))) whys.push("an Apply by line with no deadline stated");
  if (/^Level:/m.test(cap) !== !!job.level) whys.push("a Level line that the posting does not state");
  if (/not listed/i.test(cap)) whys.push("a 'not listed' line on the card");
  const card = `${cap}${job.url ? `\n\n${job.url}` : ""}`;
  if (card.length > 4000) whys.push(`the text card is ${card.length} characters`);
  if (!findUrls(card).some((u) => u.url === job.url)) whys.push("the text card's link is broken");
  for (const row2 of [...jobButtons(ref), ...confirmButtons(ref, "0123456789abcdef")]) for (const b of row2) {
    if (new TextEncoder().encode(b.data!).length > 64) whys.push(`callback data over 64 bytes: ${b.text}`);
    const t = parseJobTap(b.data!);
    if (!t || ("ref" in t && t.ref !== ref)) whys.push(`a button's own data does not parse back: ${b.text}`);
  }
  const kb = inlineKeyboard(jobButtons(ref));
  if (kb.inline_keyboard[0].length !== 3) whys.push("a button was dropped from the card");
  const logo = logoUrl(job, env);
  if (logo && /(linkedin|lever|greenhouse|bamboohr)/.test(logo)) whys.push(`a job board's logo shown as the employer's: ${logo}`);
  const parts = detailsOf(job, row, NOW);
  parts.forEach((p, i) => {
    if (p.length > 4000) whys.push(`Details page ${i + 1} is ${p.length} characters`);
    if (LONE.test(p)) whys.push(`Details page ${i + 1} carries half a character`);
    const l2 = leaks(p, ids); if (l2) whys.push(`details: ${l2}`);
  });
  if (job.url && !parts.some((p) => findUrls(p).some((u) => u.url === job.url))) whys.push("the Details link is broken");
  const allD = parts.join("\n");
  for (const m of String(row.description ?? "").matchAll(/req(\d+)x/g)) {
    const n = allD.split(`req${m[1]}x`).length - 1;
    if (n !== 1) { whys.push(`requirement ${m[1]} appears ${n} times in Details`); break; }
  }
  for (const m of String(row.description ?? "").matchAll(/<li>(req\d+x [^<]*)<\/li>/g)) {
    const item = norm(m[1]);
    if (item.length <= 1500 && !parts.some((p) => norm(p).includes(item))) { whys.push("a requirement was split across Details pages"); break; }
  }
  return whys;
}

// ================================================================================================ the memory world for taps and yes
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
type Prep = PreparedRow & { userId: string };
function memWorld() {
  const clock = { t: NOW };
  const kv = new Map<string, any>(), rows = new Map<string, PostingRow>(), preps: Prep[] = [], applied = new Set<string>(), wants: string[] = [];
  const approvals: { userId: string; jobId: string; hash: string }[] = [], said: string[] = [];
  let account: { epoch: number; version: number; authority_version: number; paused: boolean } | "throw" = { epoch: 0, version: 0, authority_version: 0, paused: false };
  let PREP = 0;
  const store: JobStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, structuredClone({ job, shownAs })); },
    async recall(u, ref) { return structuredClone(kv.get(`${u}|job|${ref}`) ?? null); },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, [...refs]); },
    async recallList(u, id) { return kv.get(`${u}|list|${id}`) ?? null; },
    async rememberListMeta(u, id, m) { kv.set(`${u}|meta|${id}`, structuredClone(m)); },
    async recallListMeta(u, id) { return structuredClone(kv.get(`${u}|meta|${id}`) ?? null); },
    async postings(ids) { return ids.map((i) => rows.get(i)).filter((x): x is PostingRow => !!x).map((x) => structuredClone(x)); },
    async save(u, ref) { const k = `${u}|saved|${ref}`; if (kv.has(k)) return "already"; kv.set(k, true); return "saved"; },
    async prepared(u, jobId) { const p = preps.filter((x) => x.userId === u && x.job_id === jobId && (x.state === "ready" || x.state === "shown")).at(-1); return p ? structuredClone(p) : null; },
    async applied(u, jobId) { return applied.has(`${u}|${jobId}`); },
    async want(u, job) { const k = `${u}|${job.job_id}`; if (wants.includes(k)) return { result: "already" }; wants.push(k); return { result: "queued" }; },
  };
  const cards = {
    async open() { throw new Error("the deployed store confirms in one transaction"); },
    async confirm(u: string, ids: string[], hashes: string[]) {
      const p = preps.find((x) => x.id === ids[0] && x.userId === u && (x.state === "ready" || x.state === "shown"));
      if (!p || p.payload_hash !== hashes[0]) throw new Error("card_changed");
      const k = `${u}|${p.job_id}`;
      if (applied.has(k)) return { card: { id: `card-${ids[0]}` }, results: [{ n: 1, company: p.company, result: "duplicate" }] };
      applied.add(k); p.state = "approved"; approvals.push({ userId: u, jobId: p.job_id, hash: p.payload_hash });
      return { card: { id: `card-${ids[0]}` }, results: [{ n: 1, company: p.company, result: "queued" }] };
    },
  };
  const tap: TapStore = { async card() { return null; }, async prepared() { return []; }, async answer() { throw new Error("no card"); } };
  const deps = (): JobDeps => ({ store, cards: cards as any, tap, now: () => clock.t, env: { get: () => undefined }, events: null, facts: async () => [],
    account: async () => { if (account === "throw") throw new Error("db down"); return structuredClone(account); } });
  const sender = () => ({ photo: async () => ({ ok: false }), text: async (a: { text: string }) => { said.push(a.text); return { ok: true, id: String(said.length) }; }, edit: async () => ({ ok: true }) });
  async function posting(userId: string, n: number, company = `TEST Co ${n}`): Promise<{ job: JobView; ref: string }> {
    const hit = { job_id: `lever:test:${n}`, company, title: `Data Analyst ${n}`, location: "Austin, TX", url: `https://jobs.lever.co/test/${n}`, first_seen_at: new Date(clock.t - 3600000).toISOString() };
    rows.set(hit.job_id, { job_id: hit.job_id, provider: "lever", company, title: hit.title, location: hit.location, url: hit.url, description: "Requirements\nSQL and Excel.", closed_at: null } as PostingRow);
    const job = jobViewOf(hit, rows.get(hit.job_id));
    const ref = await refOf(userId, job.job_id);
    await store.remember(userId, ref, job, "text");
    return { job, ref };
  }
  async function prepare(userId: string, job: JobView, o: { cover?: string; fields?: any[] } = {}): Promise<Prep> {
    for (const x of preps) if (x.userId === userId && x.job_id === job.job_id && (x.state === "ready" || x.state === "shown")) x.state = "expired";
    const payload = { version: 1, user_id: userId, job_id: job.job_id, company: job.company, url: job.url, resume_sha256: "a".repeat(64), expires_at: new Date(clock.t + DAY).toISOString(),
      privacy_epoch: 0, account_version: 0, fields: o.fields ?? [], cover_note: o.cover ?? `Hello ${job.company} ${++PREP}` };
    const p: Prep = { id: crypto.randomUUID(), userId, job_id: job.job_id, company: job.company, url: job.url, payload, payload_hash: await hex(JSON.stringify(payload)), card_lines: [job.company], state: "ready" };
    preps.push(p);
    return p;
  }
  return { clock, kv, rows, preps, applied, wants, approvals, said, store, deps, sender, posting, prepare, setAccount: (a: typeof account) => { account = a; } };
}

// ================================================================================================ tap
function tamper(r: ReturnType<typeof rng>, data: string): string {
  const k = r.int(0, 9);
  const i = r.int(0, Math.max(0, data.length - 1));
  const flip = (c: string) => (/[0-9a-f]/.test(c) ? "0123456789abcdef"[("0123456789abcdef".indexOf(c) + r.int(1, 15)) % 16] : "x");
  switch (k) {
    case 0: return data.slice(0, i) + flip(data[i]) + data.slice(i + 1);
    case 1: return data.toUpperCase();
    case 2: return data + r.pick(["0", " ", "\n", "a", ":"]);
    case 3: return data.slice(0, -r.int(1, 4));
    case 4: return ` ${data}`;
    case 5: return data.replace(/^jc./, r.pick(["jca", "jcy", "jcd", "jcs", "jcx", "jce", "jcn", "jcz"]));
    case 6: return data.replace(/[0-9a-f]/, "а"); // a Cyrillic look-alike
    case 7: return data.replace(/:/g, "::");
    case 8: return data.replace(/^tc./, r.pick(["tca", "tcd", "tcx"]));
    default: return data.split("").reverse().join("");
  }
}
async function tapScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const w = memWorld();
  const n = id;
  const mine = await w.posting(A, n), p1 = await w.prepare(A, mine.job);
  await w.posting(B, n); // the same posting on B's list too: B's own ref
  const confirm = confirmButtons(mine.ref, hashTag(p1.payload_hash))[0][0].data!;
  const ids = [A, B, mine.ref, p1.id, p1.payload_hash, hashTag(p1.payload_hash), mine.job.job_id];
  const variant = r.pick(["tamper", "other", "changed", "double", "stale", "apply-then-confirm", "edit-cancel", "card"] as const);
  const send = w.sender();
  const run = async (u: string, data: string) => await tapJob({ userId: u, data, messageId: "1", deps: w.deps(), send });
  if (variant === "tamper") {
    const bad = tamper(r, r.chance(0.5) ? confirm : `jca:${mine.ref}`);
    const res = await run(A, bad);
    if (bad !== confirm && w.approvals.length) whys.push(`a tampered button approved something: ${JSON.stringify(bad)}`);
    if (!res.toast.trim()) whys.push("a tampered tap got no answer");
  } else if (variant === "other") {
    const res = await run(B, r.chance(0.5) ? confirm : `jca:${mine.ref}`);
    if (w.approvals.length) whys.push("another person's tap approved the owner's application");
    if (w.said.some((s) => s.includes(p1.payload.cover_note as string))) whys.push("another person's tap showed the owner's application");
    if (res.status !== "gone" && res.status !== "unknown") whys.push(`another person's tap: ${res.status}`);
  } else if (variant === "changed") {
    const before = w.said.length;
    const p2 = await w.prepare(A, mine.job, { cover: r.pick(["A new cover note", "Changed answers", `Hello again ${n}`]) });
    const res = await run(A, confirm);
    const out = w.said.slice(before);
    if (w.approvals.length) whys.push("a Confirm for a payload that changed approved something");
    if (res.status !== "changed") whys.push(`a changed payload's Confirm: ${res.status}`);
    if (!out.some((s) => /changed after I showed it/.test(s) && /nothing was approved/.test(s))) whys.push(`the refusal is not in words: ${JSON.stringify(out).slice(0, 200)}`);
    if (!out.some((s) => s.includes(p2.payload.cover_note as string))) whys.push("the current application was not shown after the refusal");
    const fresh = confirmButtons(mine.ref, hashTag(p2.payload_hash))[0][0].data!;
    await run(A, fresh);
    if (w.approvals.length !== 1 || w.approvals[0].hash !== p2.payload_hash) whys.push(`the fresh Confirm did not approve exactly the payload shown: ${JSON.stringify(w.approvals)}`);
  } else if (variant === "double") {
    const k = r.int(2, 4);
    const res = await Promise.all(Array.from({ length: k }, () => run(A, confirm)));
    if (w.approvals.length !== 1) whys.push(`${k} taps approved ${w.approvals.length}`);
    if (w.approvals[0]?.hash !== p1.payload_hash) whys.push("the approval is not the payload shown");
    if (res.filter((x) => x.status === "confirmed").length !== 1) whys.push(`statuses ${res.map((x) => x.status)}`);
  } else if (variant === "stale") {
    w.kv.delete(`${A}|job|${mine.ref}`);
    const res = await run(A, r.pick([confirm, `jca:${mine.ref}`, `jcd:${mine.ref}`]));
    if (w.approvals.length) whys.push("a stale card approved something");
    if (res.status !== "gone" || !w.said.includes(GONE_REPLY)) whys.push(`a stale card was not refused in words: ${res.status}`);
  } else if (variant === "apply-then-confirm") {
    await run(A, `jca:${mine.ref}`);
    const shownTag = w.said.length ? hashTag(p1.payload_hash) : "";
    if (!w.said.some((s) => s.includes(p1.payload.cover_note as string))) whys.push("Apply did not show the exact payload");
    if (w.approvals.length) whys.push("Apply approved something (it only shows)");
    await run(A, confirmButtons(mine.ref, shownTag)[0][0].data!);
    if (w.approvals.length !== 1 || w.approvals[0].hash !== p1.payload_hash || w.approvals[0].userId !== A) whys.push(`Confirm did not approve exactly the payload shown: ${JSON.stringify(w.approvals)}`);
  } else if (variant === "edit-cancel") {
    await run(A, r.pick([`jce:${mine.ref}`, `jcx:${mine.ref}`, `jcd:${mine.ref}`, `jcs:${mine.ref}`]));
    if (w.approvals.length) whys.push("Edit, Cancel, Details or Save approved something");
  } else {
    // The card's Approve / Decline (tca / tcd): a digest over the card's id and each item's hash.
    const cid = crypto.randomUUID();
    const card: TapCard & { user_id: string } = { id: cid, user_id: A, state: "open", items: [{ n: 1, prepared_id: p1.id, payload_hash: p1.payload_hash }] };
    let answered = 0;
    const mode = r.pick(["ok", "tamper", "other", "changed", "answered", "stale", "expired"] as const);
    const store: TapStore = {
      async card(u, c) { return c === cid && u === card.user_id ? structuredClone(card) : null; },
      async prepared(u, xs) { return w.preps.filter((p) => p.userId === u && xs.includes(p.id) && (p.state === "ready" || p.state === "shown")).map((p) => ({ id: p.id, payload_hash: p.payload_hash })); },
      async answer(_u, _c, approve) {
        if (mode === "stale") throw new Error("card_stale"); if (mode === "expired") throw new Error("card_expired");
        answered++; card.state = "answered";
        return approve.map((nn) => ({ n: nn, company: p1.company, result: "queued" })) as any;
      },
    };
    const [[ok, no]] = await cardButtons(card);
    if (mode === "answered") card.state = "answered";
    if (mode === "changed") { await w.prepare(A, mine.job, { cover: "changed" }); }
    const data = mode === "tamper" ? tamper(r, r.chance(0.5) ? ok.data : no.data) : r.chance(0.8) ? ok.data : no.data;
    const res = await tapCard({ userId: mode === "other" ? B : A, data, now: w.clock.t, store });
    const lk = leaks(res.reply, [...ids, cid]); if (lk) whys.push(`card reply: ${lk}`);
    if (!res.reply.trim() || !res.toast.trim()) whys.push("a card tap got no words");
    if (mode === "ok" && answered !== 1) whys.push(`a good tap answered ${answered} times`);
    if (mode !== "ok" && mode !== "stale" && mode !== "expired" && answered && (mode !== "tamper" || data !== ok.data && data !== no.data)) whys.push(`a ${mode} tap answered the card`);
    const want = { tamper: [TAP_UNKNOWN, TAP_CHANGED], other: [TAP_UNKNOWN], changed: [TAP_CHANGED], answered: [TAP_ANSWERED], stale: [TAP_STALE], expired: [TAP_EXPIRED] } as Record<string, string[]>;
    if (want[mode] && !(mode === "tamper" && parseTap(data) && (data === ok.data || data === no.data)) && !want[mode].includes(res.reply)) whys.push(`a ${mode} tap said ${JSON.stringify(res.reply.slice(0, 120))}`);
  }
  for (const s of w.said) { const lk = leaks(s, ids.filter((x) => x !== mine.job.url)); if (lk) { whys.push(lk); break; } }
  if (w.approvals.some((x) => x.userId !== A)) whys.push("an approval for someone else");
  return whys;
}

// ================================================================================================ yes
const YES_WORDS = ["yes", "Yes", "YES!", "yes.", "yep", "yeah", "yeah please", "yes please", "do it", "go ahead", "apply to all", "apply to all of them", "send them all", "  yes  ", "yes, please", "Yes!!!"];
const NOT_YES = ["ok", "okay", "sure", "sounds good", "absolutely", "definitely", "ya", "maybe", "yes?", "yeah maybe", "👍", "yes what is the salary?", "no", "nope", "stop", "yes​", "y", "yess", "not yet", "yes I guess", "do it later", "yes but not TEST Co 1", "yeah except the first", "yes skip 2"];
async function yesScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const w = memWorld();
  const n = r.int(1, 7);
  const jobs: { job: JobView; ref: string; prep: Prep | null }[] = [];
  for (let i = 0; i < n; i++) {
    const p = await w.posting(A, id * 10 + i);
    const prepared = r.chance(0.75) ? await w.prepare(A, p.job, r.chance(0.12) ? { fields: [{ name: "q", label: r.pick(["Gender", "Your answer", "Are you authorized to work"]), value: r.pick(["", "Yes", "n/a"]), factId: "f1" }] } : {}) : null;
    jobs.push({ ...p, prep: prepared });
  }
  const list = (await hex(`list${id}`)).slice(0, 10);
  await w.store.rememberList(A, list, jobs.map((j) => j.ref));
  const meta: any = { kind: "results", what: "data analyst", floor: null, at: w.clock.t, dismissed: [], paused: null };
  const offer = offerOf({ list, at: w.clock.t, jobs: jobs.map((j) => ({ ref: j.ref, job_id: j.job.job_id, payload_hash: j.prep?.payload_hash ?? null })) });
  const question = offerQuestion(offer);
  const ready = offer.jobs.filter((j) => j.tag).length;
  if (n > 1 && ready === n && !question.includes(`all ${n} shown`)) whys.push(`the question does not say all ${n}: ${question}`);
  if (ready && ready < n && !question.includes(`the ${ready} prepared`)) whys.push(`the question does not say ${ready} prepared: ${question}`);
  if (!ready && /apply to/.test(question) && !/getting/.test(question)) whys.push(`nothing is prepared and the question offers to apply: ${question}`);
  // What changes after the offer, before the yes.
  const changes = { changed: new Set<string>(), dismissed: new Set<string>(), applied: new Set<string>() };
  for (const j of jobs) {
    const roll = r.next();
    if (j.prep && roll < 0.12) { await w.prepare(A, j.job, { cover: "re-prepared after the offer" }); changes.changed.add(j.ref); }
    else if (roll < 0.18) { meta.dismissed.push(j.ref); changes.dismissed.add(j.ref); }
    else if (roll < 0.22) { w.applied.add(`${A}|${j.job.job_id}`); changes.applied.add(j.ref); }
  }
  const state = r.pick(["fresh", "fresh", "fresh", "fresh", "stale", "future", "malformed", "spent", "list-paused", "account-paused", "stop-after", "stop-before", "stop-unreadable", "other-user", "list-gone"] as const);
  if (state === "list-paused") meta.paused = { at: w.clock.t };
  if (state === "account-paused") w.setAccount({ epoch: 0, version: 0, authority_version: 0, paused: true });
  if (state === "list-gone") w.kv.delete(`${A}|list|${list}`);
  await w.store.rememberListMeta!(A, list, meta);
  const message = r.chance(0.7) ? r.pick(YES_WORDS) : r.pick(NOT_YES);
  const plainYes = isApplyAllYes(message);
  w.clock.t += state === "stale" ? OFFER_WINDOW_MS + r.int(1, 60) * MIN : r.int(1, 9) * MIN;
  const at = state === "future" ? w.clock.t + 5 * MIN : offer.at;
  const last = state === "spent" ? { intent: AY.APPLY_ALL_INTENT, meta: { apply_all_done: { list } } } : state === "malformed" ? { intent: null, meta: { apply_all_offer: { ...offer, v: 2 } } }
    : { intent: null, meta: { apply_all_offer: { ...offer, at } } };
  const stoppedAt = state === "stop-after" ? async () => offer.at + MIN : state === "stop-before" ? async () => offer.at - DAY : state === "stop-unreadable" ? async () => { throw new Error("db down"); } : async () => null;
  const res = await applyAllYesTurn({ message, userId: state === "other-user" ? B : A, now: w.clock.t, last, deps: w.deps(), stoppedAt, prepare: async () => "started" });
  const ids = [A, B, list, ...jobs.flatMap((j) => [j.ref, j.job.job_id, j.prep?.id ?? "", j.prep?.payload_hash ?? "", j.prep ? hashTag(j.prep.payload_hash) : ""])];
  // Approvals: only offered roles, prepared when offered, unchanged since, not dismissed, theirs, and only for a plain yes on a live offer.
  for (const a of w.approvals) {
    const j = jobs.find((x) => x.job.job_id === a.jobId);
    if (!j) { whys.push("approved a role that was not offered"); continue; }
    if (!j.prep || a.hash !== j.prep.payload_hash) whys.push("approved a payload other than the one offered");
    if (changes.changed.has(j.ref)) whys.push("approved a role whose application changed after the offer");
    if (changes.dismissed.has(j.ref)) whys.push("approved a role the person dismissed");
    if (a.userId !== A) whys.push("approved for someone else");
  }
  const live = ["fresh", "stop-before", "account-paused", "list-paused"].includes(state);
  if (w.approvals.length && !(plainYes && live && state !== "list-paused" && state !== "account-paused")) whys.push(`approved ${w.approvals.length} on "${message}" (${state})`);
  if ((state === "account-paused" || state === "list-paused") && w.wants.length) whys.push(`queued ${w.wants.length} to prepare while ${state}`);
  if (state === "stop-after" && (w.approvals.length || w.wants.length)) whys.push("approved or queued after the person sent STOP");
  if (state === "stop-after" && res && STOPPED_AFTER_OFFER_REPLY !== undefined && res.reply !== STOPPED_AFTER_OFFER_REPLY && (plainYes || res.reply)) whys.push(`a yes after STOP was answered ${JSON.stringify(res.reply.slice(0, 160))}`);
  if (state === "stop-after" && STOPPED_AFTER_OFFER_REPLY === undefined && plainYes) whys.push("no rule ends the offer on a STOP sent after it");
  if (state === "stop-unreadable" && (w.approvals.length || w.wants.length)) whys.push("approved while the STOP could not be read");
  if (["stale", "future", "malformed", "spent"].includes(state) && res) whys.push(`a ${state} offer was answered as live`);
  if (!plainYes && res && res.status !== "not_plain" && res.status !== "stopped" && res.status !== "unreadable") whys.push(`"${message}" was taken as a yes: ${res.status}`);
  if (res) {
    const lk = leaks(res.reply, ids); if (lk) whys.push(lk);
    const m = /Approved and queued (\d+) application/.exec(res.reply);
    if ((m ? Number(m[1]) : 0) !== w.approvals.length) whys.push(`the reply says ${m?.[1] ?? 0} approved, ${w.approvals.length} were`);
    if (/\bapplied\b/i.test(res.reply.replace(/already in your applications/g, ""))) whys.push("the reply says applied");
    for (const c of res.reply.match(/TEST Co \d+/g) ?? []) if (!jobs.some((j) => j.job.company === c)) whys.push(`the reply names a company that was not offered: ${c}`);
    if (state === "account-paused" && plainYes && !/paused/.test(res.reply)) whys.push(`a paused account's yes does not say paused: ${res.reply.slice(0, 160)}`);
    if (!res.reply.trim()) whys.push("an empty reply");
  }
  return whys;
}

// ================================================================================================ stop
const STOPS = ["/stop", "/STOP", "/stop@TraineeBot", "/stop now", "STOP", "stop", " Stop. ", "stop!", "Stop​", "“stop”", "STOP!!", "unsubscribe", "Unsubscribe."];
const STARTS = ["/start", "/start@TraineeBot", "START", "start", "Start.", "unstop"];
const NEITHER = ["stop it", "please stop", "don't stop", "stopp", "start applying", "stop applying to acme", "yes", "stop?́x"];
async function stopScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const kind = r.pick(["stop", "start", "neither", "offer"] as const);
  if (kind === "offer") {
    // A STOP recorded at a time relative to the offer, through the real yes turn.
    const w = memWorld();
    const p = await w.posting(A, id), prep = await w.prepare(A, p.job);
    const list = (await hex(`l${id}`)).slice(0, 10);
    await w.store.rememberList(A, list, [p.ref]);
    await w.store.rememberListMeta!(A, list, { kind: "results", what: "x", floor: null, at: w.clock.t });
    const offer = offerOf({ list, at: w.clock.t, jobs: [{ ref: p.ref, job_id: p.job.job_id, payload_hash: prep.payload_hash }] });
    const dt = r.pick([-DAY, -MIN, 0, 1, MIN, 5 * MIN]);
    w.clock.t += 6 * MIN;
    await applyAllYesTurn({ message: "yes", userId: A, now: w.clock.t, last: { intent: null, meta: { apply_all_offer: offer } }, deps: w.deps(), stoppedAt: async () => offer.at + dt });
    if (dt >= 0 && w.approvals.length) whys.push(`a yes approved after a STOP sent ${dt / 1000}s after the offer`);
    if (dt < 0 && w.approvals.length !== 1) whys.push(`a yes after a STOP sent before the offer (the person texted since) approved ${w.approvals.length}`);
    return whys;
  }
  const text = kind === "stop" ? r.pick(STOPS) : kind === "start" ? r.pick(STARTS) : r.pick(NEITHER);
  // As the webhook reads it: Telegram's own command first (telegram.ts), then the words (channel.ts), as runInbound does.
  const msg = parseTelegramUpdate({ update_id: id, message: { message_id: id, chat: { id: 4200 + id, type: "private" }, from: { id: 4200 + id, is_bot: false }, date: 1, text } }).message;
  const cmd = msg ? (msg.command ?? channelCommand(msg.text, "telegram")) : null;
  if (kind === "stop" && cmd !== "stop") whys.push(`"${text}" is not read as STOP on Telegram`);
  if (kind === "start" && text !== "unstop" && cmd !== "start") whys.push(`"${text}" is not read as START on Telegram`);
  if (kind === "neither" && cmd) whys.push(`"${text}" was read as ${cmd}`);
  for (const reply of Object.values(CHANNEL_REPLIES)) { const lk = leaks(reply, []); if (lk) whys.push(lk); if (reply.length > 1500) whys.push("a command reply is longer than one message"); }
  if (!/START/.test(CHANNEL_REPLIES.stop)) whys.push("the STOP reply does not say how to turn messages back on");
  if (!/STOP/.test(CHANNEL_REPLIES.start)) whys.push("the START reply does not say how to stop");
  return whys;
}

// ================================================================================================ links
async function linksScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const w = memWorld();
  const n = r.int(1, 45);
  const vars: Record<string, string | undefined> = { TRAINEE_FILE_BASE_URL: r.pick(["https://trainee.example/file", "http://insecure.example/file", "", "https://trainee.example/file?x=1"]),
    TRAINEE_FILE_LINK_SECRET: r.chance(0.8) ? ["TEST", "file", "link", "secret", "0123456789abcdef"].join("-") : undefined, TELEGRAM_BOT_TOKEN: r.chance(0.7) ? ["1", "TEST"].join(":") : undefined };
  const env = { get: (k: string) => vars[k] };
  const out: { text: string; buttons?: any }[] = [];
  const hits = Array.from({ length: n }, (_, i) => ({ job_id: `lever:test:${id}-${i}`, company: `TEST Co ${i}`, title: `Analyst ${i}`, location: "Austin, TX", url: `https://jobs.lever.co/test/${id}-${i}`, ...(r.chance(0.2) ? { apply_here: true } : {}) }));
  if (hits.some((h) => (h as any).apply_here)) for (const h of hits) (h as any).apply_here = true;
  const deps = { ...w.deps(), env, feedLinks: (u: string, l: string) => feedUrlsFor(env, u, l, w.clock.t) };
  await sendJobCards({ userId: A, hits, deps, send: { photo: async () => ({ ok: false }), text: async (a) => { out.push(a); return { ok: true, id: "1" }; } } });
  if (!out.length) whys.push("nothing was sent for the postings");
  for (const m of out) {
    if (m.text.length > TELEGRAM_CHARS) whys.push(`a ${m.text.length}-character message`);
    const lk = leaks(m.text, [A]); if (lk) whys.push(lk);
    for (const u of findUrls(m.text)) if (!/^https:\/\//.test(u.url)) whys.push(`a link that is not https: ${u.url}`);
    for (const row of m.buttons ?? []) for (const b of row) {
      if (b.webApp && (!/^https:\/\//.test(b.webApp) || b.webApp.includes(A))) whys.push(`a Mini App button that is not https or names the person: ${b.webApp}`);
      if (b.data && new TextEncoder().encode(b.data).length > 64) whys.push("callback data over 64 bytes");
    }
  }
  const one = out.length === 1 && n > 3;
  if (one) {
    const m = out[0];
    const said = /^(\d+) (?:jobs for you|postings ready)/.exec(m.text);
    if (!said || Number(said[1]) !== n) whys.push(`the list line miscounts: ${m.text.slice(0, 80)}`);
    if (n > 30 && !/first 30/.test(m.text) && /jobs for you/.test(m.text)) whys.push("a list over 30 does not say the page shows the first 30");
    if (!findUrls(m.text).length && !(m.buttons ?? []).flat().some((b: any) => b.webApp)) whys.push("the list line has no link and no button");
  }
  return whys;
}

// ================================================================================================ the battery
const CATS: [string, number, (id: number, r: ReturnType<typeof rng>) => Promise<string[]>][] = [
  ["split", 2600, splitScenario], ["card", 1600, cardScenario], ["tap", 2200, tapScenario], ["yes", 2600, yesScenario], ["stop", 600, stopScenario], ["links", 400, linksScenario],
];
for (const [cat, n, fn] of CATS) {
  Deno.test({ name: `telegram r4: ${cat} (${Math.ceil(n * SCALE)} scenarios, seed ${SEED})`, ignore: ONLY.size > 0 && !ONLY.has(cat), sanitizeOps: false, sanitizeResources: false, async fn() {
    const base = SEED + CATS.findIndex((c) => c[0] === cat) * 1_000_003;
    for (let i = 0; i < Math.ceil(n * SCALE); i++) {
      const id = i + 1;
      let whys: string[];
      try { whys = await fn(id, rng(base + id)); } catch (e) { whys = [`threw: ${(e as Error)?.stack?.slice(0, 300) ?? e}`]; }
      grade(cat, `${cat}-${id}`, whys);
    }
    report(cat);
  } });
}

// ================================================================================================ the bugs round 4 found, one each
const TWO_SUM = "```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n\n        seen[n] = i  # keep *this* index\n    return []\n```";
Deno.test("r4 bug 1: a code block with a blank line, at a message boundary, arrives whole: code stays code, prose stays prose, indentation kept", () => {
  for (const reps of [17, 18, 19, 20]) {
    const text = `${"This is a sentence about your interview prep and what to practice next. ".repeat(reps)}\n\n${TWO_SUM}\n\nAfter the code: use *a hash map* for O(n).`;
    const on = nativeRender("telegram", 1500)(text);
    const pre = on.filter((m) => m.includes("<pre>"));
    assertNode.equal(pre.length, 1, `one message carries the code (${reps})`);
    assertNode.ok(decode(pre[0]).includes("\n        seen[n] = i  # keep *this* index\n    return []"), `indentation and the * kept inside the code (${reps}):\n${pre[0]}`);
    assertNode.ok(on.some((m) => m.includes("<i>a hash map</i>") && !/<pre>(?:(?!<\/pre>)[^])*hash map/.test(m)), `the prose after the code is prose (${reps})`);
    const off = packMessages(text, 1500);
    for (const m of off) assertNode.equal((m.match(/^\s*```/gm) ?? []).length % 2, 0, `every message's fences pair up (${reps}):\n${m}`);
    assertNode.ok(off.some((m) => m.includes("\n        seen[n] = i  # keep *this* index")), `voice off keeps the indentation (${reps})`);
  }
});
Deno.test("r4 bug 1: a code block longer than a message goes as whole blocks, each one code, nothing lost; a link inside code stays in its line", () => {
  const lines = Array.from({ length: 90 }, (_, i) => `    line_${i} = compute(${i}) * 2  # step`);
  const text = "```\n" + lines.join("\n") + "\n    curl https://api.example.test/v1/jobs?q=a&b=c\n```\nDone.";
  for (const msgs of [nativeRender("telegram", 1500)(text), packMessages(text, 1500)]) {
    assertNode.ok(msgs.length >= 3);
    const html = msgs[0].includes("<pre>");
    const codeOf = (m: string) => html ? [...m.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((x) => decode(x[1])).join("\n") : [...m.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map((x) => x[1]).join("\n");
    const code = msgs.map(codeOf).join("\n").split("\n");
    for (const l of lines) assertNode.equal(code.filter((x) => x === l).length, 1, `${l} once, indented, in code`);
    assertNode.ok(code.includes("    curl https://api.example.test/v1/jobs?q=a&b=c"), "the link in the code is still on its code line");
    assertNode.ok(msgs.at(-1)!.trim().endsWith("Done.") && !codeOf(msgs.at(-1)!).includes("Done."), "the prose after the block is prose");
    for (const m of msgs) assertNode.ok(m.length <= 1500 + 20, `${m.length} characters`);
  }
});
async function oneOffer(o: { paused?: boolean; prepared?: boolean } = {}) {
  const w = memWorld();
  const p = await w.posting(A, 77), prep = o.prepared === false ? null : await w.prepare(A, p.job);
  const list = "0123456789";
  await w.store.rememberList(A, list, [p.ref]);
  await w.store.rememberListMeta!(A, list, { kind: "results", what: "x", floor: null, at: w.clock.t });
  if (o.paused) w.setAccount({ epoch: 0, version: 0, authority_version: 0, paused: true });
  const offer = offerOf({ list, at: w.clock.t, jobs: [{ ref: p.ref, job_id: p.job.job_id, payload_hash: prep?.payload_hash ?? null }] });
  w.clock.t += 3 * MIN;
  return { w, offer, last: { intent: null, meta: { apply_all_offer: offer } } };
}
Deno.test("r4 bug 2: a STOP sent after the offer ends it: the yes approves nothing and says why; a STOP before the offer does not", async () => {
  const a = await oneOffer();
  const r = (await applyAllYesTurn({ message: "yes", userId: A, now: a.w.clock.t, last: a.last, deps: a.w.deps(), stoppedAt: async () => a.offer.at + MIN }))!;
  assertNode.equal(a.w.approvals.length, 0);
  assertNode.equal(r.reply, STOPPED_AFTER_OFFER_REPLY);
  assertNode.ok(!("apply_all_offer" in r.meta), "the offer is spent");
  const u = await oneOffer();
  const ru = (await applyAllYesTurn({ message: "yes", userId: A, now: u.w.clock.t, last: u.last, deps: u.w.deps(), stoppedAt: async () => { throw new Error("db down"); } }))!;
  assertNode.equal(u.w.approvals.length, 0, "an unreadable STOP approves nothing");
  assertNode.ok(/nothing was approved/.test(ru.reply) && "apply_all_offer" in ru.meta, ru.reply);
  const b = await oneOffer();
  await applyAllYesTurn({ message: "yes", userId: A, now: b.w.clock.t, last: b.last, deps: b.w.deps(), stoppedAt: async () => b.offer.at - DAY });
  assertNode.equal(b.w.approvals.length, 1, "stopped yesterday, texted since, offered today: the yes is theirs");
});
Deno.test("r4 bug 3: a paused account's yes queues nothing to prepare and says it is paused", async () => {
  const a = await oneOffer({ paused: true, prepared: false });
  const r = (await applyAllYesTurn({ message: "yes", userId: A, now: a.w.clock.t, last: a.last, deps: a.w.deps(), prepare: async () => "started" }))!;
  assertNode.equal(a.w.wants.length, 0, "nothing queued to prepare while paused");
  assertNode.equal(a.w.approvals.length, 0);
  assertNode.ok(/paused/.test(r.reply) && /resume/.test(r.reply), r.reply);
  const b = await oneOffer({ prepared: false });
  await applyAllYesTurn({ message: "yes", userId: A, now: b.w.clock.t, last: b.last, deps: b.w.deps(), prepare: async () => "started" });
  assertNode.equal(b.w.wants.length, 1, "not paused: the unprepared role is queued to prepare");
});
Deno.test("r4 bug 4: the exact application never prints the account's id, the posting's internal id or the rule versions; unknown keys and the expiry are said", async () => {
  const w = memWorld();
  const p = await w.posting(A, 5), prep = await w.prepare(A, p.job);
  (prep.payload as any).referrer = "Sam";
  w.preps[w.preps.length - 1].payload = prep.payload;
  const send = w.sender();
  await tapJob({ userId: A, data: `jca:${p.ref}`, messageId: "1", deps: w.deps(), send });
  const all = w.said.join("\n");
  for (const bad of [A, p.job.job_id, "user_id", "job_id", "privacy_epoch", "account_version", "• version"]) assertNode.ok(!all.includes(bad), `printed ${bad}:\n${all}`);
  assertNode.ok(all.includes("• referrer: Sam"), "a key the payload carries is still listed");
  assertNode.ok(/This approval works until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./.test(all), all);
  assertNode.ok(all.includes(`Posting: ${p.job.title} at ${p.job.company}`) && all.includes(`Link: ${p.job.url}`));
});
