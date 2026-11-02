// Channel presentation layer for the Trainee messaging bridges
// (telegram-inbound, whatsapp-inbound). Owner law, 2026-10-19: the way
// WhatsApp and Telegram respond IS the product — responses, design and
// behavior end to end — so a channel test must test the product itself,
// never a lesser copy. This module is where the canonical agent-chat
// reply becomes each platform's native presentation WITHOUT losing
// structure: emphasis, lists, links and code survive rendering, long
// replies split only on block boundaries, approvals become real
// platform controls, and every non-happy state speaks in one product
// voice across channels.
//
// ------------------------------------------------------------------
// THE REPLY CONTRACT (verified 2026-10-19 against agent-chat's
// handler-career.ts): the response is
//   { thread_id, reply, action, capabilities, turn_key, reminders,
//     task?, batch?, meta, artifacts? }
// `reply` is the canonical text (markdown-flavoured: **bold**, *italic*,
// ~~strike~~, `code`, [label](url), "- " lists, "# " headings, ```
// fences — the dialect the career modules speak). `reminders` only add
// speak_line strings to `reply`. `artifacts` is the document field
// (CHANNEL-DOC-1, landed 2026-10-20 — below).
//
// CHANNEL-DOC-1 (named follow-up, LANDED 2026-10-20, LANE B): the
// reply contract now carries the document hand-off:
//   artifacts?: [{ kind: "document", filename: string, mime: string,
//                  ref: string /* opaque id in channel_artifacts —
//                  the owner-scoped bytes store; see
//                  channel_artifacts.ts */ }]
// The bytes live in the product's own store, scoped to the turn's
// user (and thread); they are never a public URL and never ride the
// reply itself. extractArtifacts() below reads that shape and keeps
// the earlier direct-url shape ({ ..., url: https://... }) accepted
// for any surface that already holds a hosted file URL. The bridges
// resolve a ref owner-scoped at send time (Telegram uploads the bytes
// via sendDocument; WhatsApp mints a signed, expiring URL on its own
// function for Twilio's MediaUrl); a ref that resolves to nothing
// sends nothing and the failure is spoken — a document is never
// claimed sent that was not.
//
// ------------------------------------------------------------------
// APPROVALS. The hash-bound approval the core presents conversationally
// is the batch card: the response's `batch` field with
// kind "batch_run" and status "awaiting_approval" (the worker-prepared
// run read back through the handler). The card's cardSha256 is NEVER in
// the chat response — by design it stays server-side. So the bridge:
//   1. reads the worker's run record through the SAME owner-scoped RPC
//      the handler uses (career_batch_result_v1) and takes cardSha256
//      from the stored run — the card the worker actually wrote;
//   2. binds it to a single-use, expiring channel token (table
//      channel_pending_approvals, migration 20261019010000) — the token
//      is all a button or a numbered choice ever carries;
//   3. on a tap/choice, calls agent-chat with the EXACT message
//      "Approve batch <runId>" AND the structured career_batch
//      { action:"approve", version, eventId, runId, cardSha256 } —
//      byte-identical authorization semantics to the app client. The
//      core re-verifies the hash against the stored run and refuses a
//      moved card; the bridge's own state authorizes nothing.
// A tap therefore has exactly the effect of the exact-message path —
// there is no weaker channel path. The career_task (single browser
// task) approval is NOT offered as a channel control: its approve
// request needs prepare-time hashes (payloadSha256, resumeSha256,
// destination) that a channel never holds; its text path is unchanged.
// WhatsApp interactive buttons via Twilio Content Templates are the
// production follow-up (named in whatsapp_twilio.ts); the sandbox uses
// numbered replies resolving through this same store and call.

import type { ChannelDeps } from "./channel_bridge.ts";

// ------------------------------------------------------------------
// Wording policy — one voice on every channel. Short, plain, honest
// about state, and always naming the next step. (NOT_AUTHORIZED_TEXT
// stays in channel_bridge.ts, where the first lane put it; the empty-
// reply string below is byte-identical to the bridge's fallback and is
// pinned by fixtures in both places.)
export const VOICE = {
  empty: "(I didn't get a reply — try again.)",
  error: "Something went wrong on my side — nothing was changed. Give me a moment and send that again.",
  rateLimited:
    "You've reached the limit of 60 messages an hour, so I didn't read that message and nothing was changed. The limit resets within the hour; send it again then.",
  dismiss: "Okay — nothing was approved. The batch stays right where it is.",
  approvalAck: "Got it ✓",
  approvalDeclined: "Not approved — nothing was sent.",
  buttonExpired: "That button has expired — ask for the batch status and I'll show you a fresh card.",
  choiceExpired: "That choice has expired — ask for the batch status and I'll show you a fresh card.",
  buttonForeign: "That button isn't for this chat.",
  approvalPrompt: (runId: string) => `Batch ${runId} is waiting on your yes.`,
  choiceFooter: "Reply with a number:\n1 — Approve this batch\n2 — Not now",
  approveButton: "Approve this batch",
  declineButton: "Not now",
  docAttachFailed:
    "That file didn't go through — it's saved on your record; ask me to send it again and I'll retry.",
  // P1 text yes: the card's applications, numbered as the yes refers to them.
  cardItems: (items: CardItem[]) =>
    items.map((it, i) => `${i + 1}. ${it.company ?? "A company"} — ${it.role ?? "a role"}`).join("\n"),
  textYesFooter: (n: number) =>
    `Text "yes" to approve all ${n}, "yes but not 2" to leave one out, or "no".`,
  textYesUnclear:
    "I didn't approve anything — I couldn't tell which applications you meant. Text \"yes\" for all of them, \"yes but not 2\" (or \"yes but not 2, 5\") to leave some out, or \"no\".",
  textYesTooLate:
    "That card was shown more than 10 minutes ago, so a text yes can't approve it. Tap Approve on the card, or ask for the batch status and I'll show you a fresh one.",
  textYesCardMoved:
    "That card changed since I showed it, so nothing was approved. Ask for the batch status and I'll show you the current card.",
  textYesAllExcluded: "That leaves every application out, so nothing was approved. The batch stays where it is.",
} as const;

// ------------------------------------------------------------------
// Block parsing of the canonical reply. A block is a maximal run of
// non-blank lines of one kind; ``` fences swallow lines verbatim.

export interface Block {
  kind: "heading" | "para" | "list" | "quote" | "code";
  lines: string[];
}

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;

export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let inFence = false;
  const push = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };
  for (const rawLine of String(md ?? "").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (inFence) {
      if (/^\s*```/.test(line)) { inFence = false; push(); } else cur?.lines.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { push(); cur = { kind: "code", lines: [] }; inFence = true; continue; }
    if (!line.trim()) { push(); continue; }
    if (/^#{1,6}\s+/.test(line)) { push(); blocks.push({ kind: "heading", lines: [line.replace(/^#{1,6}\s+/, "")] }); continue; }
    if (LIST_ITEM.test(line)) {
      if (!cur || cur.kind !== "list") { push(); cur = { kind: "list", lines: [] }; }
      cur.lines.push(line);
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (!cur || cur.kind !== "quote") { push(); cur = { kind: "quote", lines: [] }; }
      cur.lines.push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (!cur || cur.kind !== "para") { push(); cur = { kind: "para", lines: [] }; }
    cur.lines.push(line);
  }
  push();
  return blocks;
}

// ------------------------------------------------------------------
// Inline rendering. One tokenizer for the canonical dialect; each
// platform renders the segments in its own markup.

type Seg =
  | { t: "text"; s: string }
  | { t: "bold" | "italic" | "strike" | "code"; s: string }
  | { t: "link"; s: string; href: string }
  | { t: "url"; s: string };

function tokenizeInline(s: string): Seg[] {
  const segs: Seg[] = [];
  let buf = "";
  const flush = () => { if (buf) { segs.push({ t: "text", s: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if (s[i] === "`" && (m = /^`([^`\n]+)`/.exec(rest))) {
      flush(); segs.push({ t: "code", s: m[1] }); i += m[0].length; continue;
    }
    if (rest.startsWith("**") && (m = /^\*\*([^*\n]+)\*\*/.exec(rest))) {
      flush(); segs.push({ t: "bold", s: m[1] }); i += m[0].length; continue;
    }
    if (rest.startsWith("~~") && (m = /^~~([^~\n]+)~~/.exec(rest))) {
      flush(); segs.push({ t: "strike", s: m[1] }); i += m[0].length; continue;
    }
    if (s[i] === "*" && (m = /^\*([^*\n]+)\*/.exec(rest))) {
      flush(); segs.push({ t: "italic", s: m[1] }); i += m[0].length; continue;
    }
    if (s[i] === "_" && (i === 0 || /[\s(]/.test(s[i - 1])) && (m = /^_([^_\n]+)_(?=$|[\s).,;:!?])/.exec(rest))) {
      flush(); segs.push({ t: "italic", s: m[1] }); i += m[0].length; continue;
    }
    if (s[i] === "[" && (m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) {
      flush(); segs.push({ t: "link", s: m[1], href: m[2] }); i += m[0].length; continue;
    }
    if ((rest.startsWith("https://") || rest.startsWith("http://")) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      m = /^https?:\/\/[^\s<]+/.exec(rest)!;
      let url = m[0];
      let trail = "";
      while (/[.,;:!?]$/.test(url) && !url.endsWith("=")) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
      flush(); segs.push({ t: "url", s: url });
      buf = trail; i += m[0].length; continue;
    }
    buf += s[i]; i++;
  }
  flush();
  return segs;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

function inlineTelegram(s: string): string {
  return tokenizeInline(s).map((g) => {
    switch (g.t) {
      case "text": return escapeHtml(g.s);
      case "bold": return `<b>${inlineTelegram(g.s)}</b>`;
      case "italic": return `<i>${inlineTelegram(g.s)}</i>`;
      case "strike": return `<s>${inlineTelegram(g.s)}</s>`;
      case "code": return `<code>${escapeHtml(g.s)}</code>`;
      case "link": return `<a href="${escapeAttr(g.href)}">${inlineTelegram(g.s)}</a>`;
      case "url": return escapeHtml(g.s); // Telegram linkifies bare URLs itself
    }
  }).join("");
}

function inlineWhatsapp(s: string): string {
  return tokenizeInline(s).map((g) => {
    switch (g.t) {
      case "text": return g.s;
      case "bold": return `*${inlineWhatsapp(g.s)}*`;
      case "italic": return `_${inlineWhatsapp(g.s)}_`;
      case "strike": return `~${inlineWhatsapp(g.s)}~`;
      case "code": return "```" + g.s + "```";
      case "link": return g.s === g.href ? g.href : `${inlineWhatsapp(g.s)} (${g.href})`;
      case "url": return g.s;
    }
  }).join("");
}

function listMarker(line: string): { marker: string; text: string } {
  const m = /^(\s*)(\d+)([.)])\s+/.exec(line);
  if (m) return { marker: `${m[2]}${m[3]} `, text: line.slice(m[0].length) };
  return { marker: "• ", text: line.replace(/^\s*(?:[-*•])\s+/, "") };
}

function renderBlock(b: Block, platform: "telegram" | "whatsapp"): string {
  const inline = platform === "telegram" ? inlineTelegram : inlineWhatsapp;
  switch (b.kind) {
    case "heading": {
      const inner = inline(b.lines[0]);
      return platform === "telegram" ? `<b>${inner}</b>` : `*${inner}*`;
    }
    case "code":
      return platform === "telegram"
        ? `<pre>${escapeHtml(b.lines.join("\n"))}</pre>`
        : "```\n" + b.lines.join("\n") + "\n```";
    case "list":
      return b.lines.map((l) => { const { marker, text } = listMarker(l); return marker + inline(text); }).join("\n");
    case "quote":
      return platform === "telegram"
        ? `<blockquote>${b.lines.map(inline).join("\n")}</blockquote>`
        : b.lines.map(inline).join("\n");
    default:
      return b.lines.map(inline).join("\n");
  }
}

export function renderTelegramBlocks(md: string): string[] {
  return parseBlocks(md).map((b) => renderBlock(b, "telegram")).filter((s) => s.trim());
}

// The plain-text shape of a rendered Telegram part, used only when
// Telegram rejects the HTML and the same content must go out again
// without markup. Link destinations survive: a labelled link degrades
// to "label (url)", never to the label alone — a fallback that drops
// the URL drops the answer the user asked for. Entities decode back
// to the characters the author wrote.
export function plainFromTelegramHtml(html: string): string {
  const decode = (s: string) => s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const withLinks = String(html ?? "").replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, (_m, href, text) => {
    const label = decode(String(text).replace(/<[^>]+>/g, ""));
    const url = decode(String(href));
    return label === url ? url : `${label} (${url})`;
  });
  return decode(withLinks.replace(/<[^>]+>/g, ""));
}
export function renderWhatsappBlocks(md: string): string[] {
  return parseBlocks(md).map((b) => renderBlock(b, "whatsapp")).filter((s) => s.trim());
}

// ------------------------------------------------------------------
// Structure-aware splitting. Chunks are packed from whole blocks; a
// block that alone exceeds the limit splits at LINE boundaries (list
// items, paragraph lines); only a single over-limit line falls to the
// span-aware splitter, which cuts plain text at spaces and never cuts
// inside a protected span (an HTML element, a ``` span, a URL).

interface Span { s: string; atomic: boolean }

function spansOf(line: string, platform: "telegram" | "whatsapp"): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let buf = "";
  const flush = () => { if (buf) { spans.push({ s: buf, atomic: false }); buf = ""; } };
  while (i < line.length) {
    const rest = line.slice(i);
    let m: RegExpExecArray | null = null;
    if (platform === "telegram") {
      m = /^<([a-z]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/.exec(rest) || /^<[^>]+>/.exec(rest);
    } else {
      m = /^```[\s\S]*?```/.exec(rest) || /^https?:\/\/\S+/.exec(rest);
    }
    if (m) { flush(); spans.push({ s: m[0], atomic: true }); i += m[0].length; continue; }
    buf += line[i]; i++;
  }
  flush();
  return spans;
}

// Split one rendered line to the limit. Atomic spans are kept whole; a
// span that alone exceeds the limit is degraded (Telegram: tags stripped
// to its text; WhatsApp code span: re-fenced pieces; a bare over-limit
// URL is hard-cut — the documented last resort for a pathological URL).
function splitRenderedLine(line: string, limit: number, platform: "telegram" | "whatsapp"): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  const putText = (text: string) => {
    for (const word of text.split(/(?<=\s)/)) {
      if (!word) continue;
      if (cur && (cur + word).length > limit) flush();
      if (word.length > limit) { // a single unbreakable word: hard cut
        let rest = word;
        while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit); }
        cur = rest;
      } else {
        cur += word;
      }
    }
  };
  const putAtomic = (span: string) => {
    if (span.length <= limit) {
      if (cur && (cur + span).length > limit) flush();
      cur += span;
      return;
    }
    flush();
    if (platform === "telegram") {
      putText(span.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    } else if (span.startsWith("```")) {
      const inner = span.replace(/^```/, "").replace(/```$/, "");
      for (const piece of splitRenderedLine(inner, limit - 8, platform)) out.push("```" + piece + "```");
    } else {
      let rest = span; // over-limit URL: hard cut, documented last resort
      while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit); }
      cur = rest;
    }
    flush();
  };
  for (const sp of spansOf(line, platform)) {
    if (sp.atomic) putAtomic(sp.s); else putText(sp.s);
  }
  flush();
  return out.length ? out : [line.slice(0, limit)];
}

function splitBlock(block: string, limit: number, platform: "telegram" | "whatsapp"): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const line of block.split("\n")) {
    if (line.length > limit) {
      flush();
      out.push(...splitRenderedLine(line, limit, platform));
      continue;
    }
    const candidate = cur ? cur + "\n" + line : line;
    if (candidate.length > limit) { flush(); cur = line; } else cur = candidate;
  }
  flush();
  return out;
}

export function presentReply(channel: "telegram" | "whatsapp", text: string, limit: number): string[] {
  const blocks = channel === "telegram" ? renderTelegramBlocks(text) : renderWhatsappBlocks(text);
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const block of blocks) {
    if (block.length > limit) {
      flush();
      const pieces = splitBlock(block, limit, channel);
      out.push(...pieces.slice(0, -1));
      cur = pieces[pieces.length - 1] ?? "";
      continue;
    }
    const candidate = cur ? cur + "\n\n" + block : block;
    if (candidate.length > limit) { flush(); cur = block; } else cur = candidate;
  }
  flush();
  return out.length ? out : [""];
}

// ------------------------------------------------------------------
// Approval offers (design in the header). The store is the
// channel_pending_approvals table; every failure on the OFFER path
// degrades to "no buttons" (the text card still stands), and every
// failure on the RESOLUTION path fails closed (no approval call).

export interface BatchCard { runId: string }

const RUN_ID_OK = /^batch-[A-Za-z0-9-]{4,96}$/;
const CARD_HASH_OK = /^[a-f0-9]{64}$/;

export function detectBatchCard(chat: any): BatchCard | null {
  const b = chat?.batch;
  if (!b || b.kind !== "batch_run" || b.status !== "awaiting_approval") return null;
  if (typeof b.id !== "string" || !RUN_ID_OK.test(b.id)) return null;
  return { runId: b.id };
}

// The card hash, read from the worker's stored run record through the
// same owner-scoped RPC the agent-chat handler uses; the shape is
// validated the same way career_persistence validates it.
export async function readCardHash(admin: any, userId: string, runId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("career_batch_result_v1", { p_user: userId, p_run: runId });
    if (error || !data || typeof data !== "object") return null;
    const rec = (data as any).batch;
    if (!rec || rec.version !== "career_batch_run/v1" || rec.userId !== userId) return null;
    if (rec.runId !== runId || rec.status !== "awaiting_approval") return null;
    if (!rec.run || rec.run.id !== runId || typeof rec.run.cardSha256 !== "string") return null;
    return CARD_HASH_OK.test(rec.run.cardSha256) ? rec.run.cardSha256 : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// P1 TEXT YES. A texted reply to a live card offer: "yes" approves the
// whole card, "yes but not 2" (or "yes except 2, 5") leaves the named
// applications off, "no" declines. The reply resolves ONLY through the
// sender's live single-use offer (one per sender per channel; a newer
// card supersedes it), the stored run is re-read and its card hash must
// still equal the hash the offer bound, and the approval goes to the
// core as the identical structured approve a button tap sends, plus the
// exclusions as posting keys. Anything that is not clearly one of those
// shapes approves nothing. The core re-verifies the hash and exclusions;
// the database and the worker check them again.

export interface CardItem { postingKey: string; company: string | null; role: string | null }

export type TextReply =
  | { kind: "yes"; exclude: number[] }
  | { kind: "no" }
  | { kind: "unclear" };

const YES_WORD = /^(?:yes|yep|yeah|yup|y|ok|okay|approve|approved|go|go ahead|send|send them|do it|sure)$/;
const NO_WORD = /^(?:no|nope|nah|n|not now|cancel|stop|don't|dont|do not)$/;

// null = not a reply to the card at all (an ordinary message).
export function parseTextApproval(text: string): TextReply | null {
  const t = String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[.!]+\s*$/g, "").trim().replace(/\s+/g, " ");
  if (!t || t.length > 120) return null;
  if (NO_WORD.test(t)) return { kind: "no" };
  if (YES_WORD.test(t) || /^(?:yes|ok|okay) (?:please|to all|all|approve)$/.test(t)) return { kind: "yes", exclude: [] };
  const m = /^(?:yes|yep|yeah|ok|okay|approve)[, ]+(?:but |except |minus |without )?(?:not |skip |drop |except |leave out |exclude |without )?(?:#|number |no\. ?)?(.+)$/.exec(t);
  if (!m) {
    // Starts like a yes but says more than we can read: never a yes.
    return /^(?:yes|yep|yeah|ok|okay|approve)\b/.test(t) ? { kind: "unclear" } : null;
  }
  // The rest must be ONLY numbers joined by commas / "and" / "&" / spaces / "#".
  const rest = m[1].replace(/\b(?:and|&|or)\b/g, ",").replace(/#/g, "");
  if (!/^[\d,\s]+$/.test(rest)) return { kind: "unclear" };
  const nums = rest.split(/[,\s]+/).filter(Boolean).map((s) => Number(s));
  if (!nums.length || nums.some((n) => !Number.isSafeInteger(n) || n < 1)) return { kind: "unclear" };
  if (new Set(nums).size !== nums.length) return { kind: "unclear" };
  // The words must actually say "not"/"except"/… — "yes 2" is not an exclusion.
  if (!/\b(?:but|except|minus|without|not|skip|drop|leave out|exclude)\b/.test(t)) return { kind: "unclear" };
  return { kind: "yes", exclude: nums.sort((a, b) => a - b) };
}

// The card's applications in the order the person sees them: the run's
// selection order, doorstep-ready only — exactly the set 155's cardSha
// covers (and career_task_bridge.batchCardItems lists). Read owner-
// scoped; null unless the stored run is still at the card with the
// given hash (a moved or foreign card yields nothing).
export async function readCardItems(
  admin: any,
  userId: string,
  runId: string,
  cardSha256: string,
): Promise<CardItem[] | null> {
  try {
    const { data, error } = await admin.rpc("career_batch_result_v1", { p_user: userId, p_run: runId });
    if (error || !data || typeof data !== "object") return null;
    const rec = (data as any).batch;
    if (!rec || rec.version !== "career_batch_run/v1" || rec.userId !== userId) return null;
    if (rec.runId !== runId || rec.status !== "awaiting_approval") return null;
    const run = rec.run;
    if (!run || run.id !== runId || run.cardSha256 !== cardSha256) return null;
    if (!Array.isArray(run.selected) || !run.apps || typeof run.apps !== "object") return [];
    return run.selected
      .filter((k: unknown) => typeof k === "string" && run.apps[k as string]?.stage === "doorstep")
      .map((k: string) => ({ postingKey: k, company: run.apps[k].company ?? null, role: run.apps[k].role ?? null }));
  } catch {
    return null;
  }
}

export type TextApprovalResolution =
  | { kind: "none" } // no live offer for this sender, or not a card reply: an ordinary turn
  | { kind: "say"; text: string; reason: "unclear" | "moved" | "all_excluded" | "declined" | "foreign" | "spent" | "too_late" }
  | { kind: "approve"; row: PendingApproval; excludeKeys: string[]; count: number };

// Resolve a texted reply against the sender's live card offer. Fail-
// closed: every doubt says something and approves nothing. The offer is
// consumed only once the reply is a well-formed yes/no for THIS card.
export async function resolveTextApproval(
  deps: ChannelDeps,
  args: { channel: string; senderKey: string; userId: string; text: string },
): Promise<TextApprovalResolution> {
  const parsed = parseTextApproval(args.text);
  if (!parsed) return { kind: "none" };
  const pending = await peekApproval(deps, { channel: args.channel, senderKey: args.senderKey });
  if (!pending) return { kind: "none" };
  // The offer must be this person's: a sender mapped to another user
  // never answers someone else's card.
  if (pending.user_id !== args.userId) return { kind: "say", text: VOICE.buttonForeign, reason: "foreign" };
  if (parsed.kind === "unclear") return { kind: "say", text: VOICE.textYesUnclear, reason: "unclear" };
  if (parsed.kind === "no") {
    const taken = await takeApproval(deps, { channel: args.channel, senderKey: args.senderKey, token: pending.token });
    if (!taken.ok) return { kind: "say", text: VOICE.choiceExpired, reason: "spent" };
    return { kind: "say", text: VOICE.dismiss, reason: "declined" };
  }
  // A text yes counts only as a reply to a card shown within TEXT_YES_WINDOW_MS. The offer is not spent: the tap keeps
  // its own TTL (approvalTtlMs). A "no" above is honoured at any age.
  const shownAt = Date.parse(String(pending.created_at ?? ""));
  if (!Number.isFinite(shownAt) || Date.now() - shownAt > TEXT_YES_WINDOW_MS) {
    return { kind: "say", text: VOICE.textYesTooLate, reason: "too_late" };
  }
  const items = await readCardItems(deps.createAdmin(), args.userId, pending.run_id, pending.card_sha256);
  if (!items) {
    // The stored card is no longer the one offered: spend the offer so it
    // can never resolve later, and approve nothing.
    await takeApproval(deps, { channel: args.channel, senderKey: args.senderKey, token: pending.token });
    return { kind: "say", text: VOICE.textYesCardMoved, reason: "moved" };
  }
  let excludeKeys: string[] = [];
  if (parsed.exclude.length) {
    // Numbers refer to the card as shown; a run without itemized
    // applications cannot be partially approved.
    if (!items.length || parsed.exclude.some((n) => n > items.length)) {
      return { kind: "say", text: VOICE.textYesUnclear, reason: "unclear" };
    }
    if (parsed.exclude.length >= items.length) return { kind: "say", text: VOICE.textYesAllExcluded, reason: "all_excluded" };
    excludeKeys = parsed.exclude.map((n) => items[n - 1].postingKey);
  }
  const taken = await takeApproval(deps, { channel: args.channel, senderKey: args.senderKey, token: pending.token });
  if (!taken.ok) return { kind: "say", text: taken.reason === "foreign" ? VOICE.buttonForeign : VOICE.choiceExpired, reason: "spent" };
  return { kind: "approve", row: taken.row, excludeKeys, count: items.length - excludeKeys.length };
}

// Vishnu, 2026-10-22 5:09 (architect's rule, docs/integration/BUILDER-PLAN-48H-20261022.md): a texted "yes" approves a
// batch only as a direct reply to a card shown in this thread within the last 10 minutes; bound to the card's hash,
// once, refused on any change. One number, one place.
export const TEXT_YES_WINDOW_MS = 10 * 60_000;

export interface PendingApproval {
  token: string;
  created_at?: string;
  channel: string;
  sender_key: string;
  user_id: string;
  thread_id: string;
  run_id: string;
  card_sha256: string;
  expires_at: string;
}

const APPROVALS_TABLE = "channel_pending_approvals";

function newToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function approvalTtlMs(env: ChannelDeps["env"]): number {
  const min = Number(env("CHANNEL_APPROVAL_TTL_MIN") ?? "");
  const minutes = Number.isFinite(min) && min >= 1 ? min : 1440; // 24h default
  return minutes * 60_000;
}

// Offer an approval for a presented card: reads the hash, supersedes any
// live offer for this sender (one live card per sender per channel), and
// stores the single-use token. Returns null when no offer can be made —
// the reply text still stands on its own.
export async function offerApproval(
  deps: ChannelDeps,
  args: { channel: string; senderKey: string; userId: string; threadId: string; runId: string },
): Promise<{ token: string; items: CardItem[] } | null> {
  try {
    const admin = deps.createAdmin();
    const cardSha256 = await readCardHash(admin, args.userId, args.runId);
    if (!cardSha256) return null;
    // The numbered list a texted "yes but not 2" refers to — read from
    // the same stored run at the same hash the token binds.
    const items = (await readCardItems(admin, args.userId, args.runId, cardSha256)) ?? [];
    const now = new Date();
    // Supersede older live offers so a stale button/choice can never be
    // the one that resolves (best-effort; resolution also re-checks).
    try {
      await admin.from(APPROVALS_TABLE)
        .update({ consumed_at: now.toISOString() })
        .eq("channel", args.channel)
        .eq("sender_key", args.senderKey)
        .is("consumed_at", null);
    } catch { /* supersede is hygiene; the insert below is the offer */ }
    const token = newToken();
    const { error } = await admin.from(APPROVALS_TABLE).insert({
      token,
      channel: args.channel,
      sender_key: args.senderKey,
      user_id: args.userId,
      thread_id: args.threadId,
      run_id: args.runId,
      card_sha256: cardSha256,
      // 2026-10-31 (clock sweep): created_at is the database's clock at the insert (the column's default), never this
      // worker's. peekApproval resolves a numbered reply ("1", "yes") against the newest live offer by created_at, and the
      // offer inserted last is the card shown last; two offers racing past each other's supersede on two workers whose clocks
      // differ (±2 s) were ordered by those clocks, so the reply resolved the card shown before. The text-yes window
      // (10 minutes) reads it against this worker's clock: seconds do not matter.
      expires_at: new Date(now.getTime() + approvalTtlMs(deps.env)).toISOString(),
      consumed_at: null,
    });
    if (error) return null;
    return { token, items };
  } catch {
    return null;
  }
}

// The approval prompt under a card: the run line, then — when the stored
// run itemizes its applications — the numbered list and the text-yes
// footer. With no items it is exactly VOICE.approvalPrompt, as before.
export function approvalPromptText(runId: string, items: CardItem[] | undefined): string {
  if (!items || !items.length) return VOICE.approvalPrompt(runId);
  return `${VOICE.approvalPrompt(runId)}\n${VOICE.cardItems(items)}\n${VOICE.textYesFooter(items.length)}`;
}

// The latest live offer for a sender (WhatsApp numbered choices carry no
// token, so resolution starts from the sender's current offer).
export async function peekApproval(
  deps: ChannelDeps,
  args: { channel: string; senderKey: string },
): Promise<PendingApproval | null> {
  try {
    const admin = deps.createAdmin();
    const { data } = await admin.from(APPROVALS_TABLE)
      .select("*")
      .eq("channel", args.channel)
      .eq("sender_key", args.senderKey)
      .order("created_at", { ascending: false })
      .limit(5);
    const rows: any[] = Array.isArray(data) ? data : [];
    const now = Date.now();
    return rows.find((r) => !r.consumed_at && new Date(r.expires_at).getTime() > now) ?? null;
  } catch {
    return null;
  }
}

export type TakeResult =
  | { ok: true; row: PendingApproval }
  | { ok: false; reason: "missing" | "foreign" | "spent" | "expired" };

// Take (consume) an offer for resolution. Fail-closed: any doubt — no
// row, another chat's row, already spent, expired, or a lost consume
// race — returns not-ok and the caller must NOT call the agent.
export async function takeApproval(
  deps: ChannelDeps,
  args: { channel: string; senderKey: string; token: string },
): Promise<TakeResult> {
  try {
    const admin = deps.createAdmin();
    const { data: row } = await admin.from(APPROVALS_TABLE)
      .select("*")
      .eq("token", args.token)
      .maybeSingle();
    if (!row) return { ok: false, reason: "missing" };
    if (row.channel !== args.channel || row.sender_key !== args.senderKey) return { ok: false, reason: "foreign" };
    if (row.consumed_at) return { ok: false, reason: "spent" };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };
    const { data: consumed } = await admin.from(APPROVALS_TABLE)
      .update({ consumed_at: new Date().toISOString() })
      .eq("token", args.token)
      .is("consumed_at", null)
      .select("token");
    if (!Array.isArray(consumed) || consumed.length !== 1) return { ok: false, reason: "spent" };
    return { ok: true, row: row as PendingApproval };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

// ------------------------------------------------------------------
// Document artifacts — CHANNEL-DOC-1 (landed; see header). Reads the
// reply's artifacts[]: the bytes-ref shape the core now emits, and
// the legacy direct-url shape stays accepted.

export interface ChannelArtifact { kind: "document"; ref?: string; url?: string; filename?: string; mime?: string }

export function extractArtifacts(chat: any): ChannelArtifact[] {
  const list = Array.isArray(chat?.artifacts) ? chat.artifacts : [];
  const out: ChannelArtifact[] = [];
  for (const a of list) {
    if (!a || a.kind !== "document") continue;
    const entry: ChannelArtifact = {
      kind: "document",
      filename: typeof a.filename === "string" ? a.filename : undefined,
      mime: typeof a.mime === "string" ? a.mime : undefined,
    };
    if (typeof a.ref === "string" && a.ref) entry.ref = a.ref;
    else if (typeof a.url === "string" && a.url.startsWith("https://")) entry.url = a.url;
    else continue;
    out.push(entry);
  }
  return out;
}
