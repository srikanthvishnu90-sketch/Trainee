// One conversation interface for every channel (WO-004): the text simulator now, LoopMessage last (WO-013).
// A person is their contact (phone or email). The first text creates them (no web account). The brain answers with
// the person's history and state; the reply is split into texting-sized bubbles. Agent-initiated messages (alerts,
// reports, nudges) are queued per person, delivered once each, and become part of the conversation.
import { channelCommand, CHANNEL_REPLIES, type ChannelStore } from "./channel.ts";
import { findUrls, isBareUrl, safeCut } from "./channel_text.ts";
export interface Attachment { name: string; mime: string; bytes: Uint8Array }
export interface Inbound { contact: string; text: string; at: number; attachments?: Attachment[] }
export interface Outbound { contact: string; kind: "reply" | "proactive"; bubbles: string[] }
export type Turn = { role: "user" | "assistant"; content: string };
export type Brain = (a: {
  userId: string; message: string; history: Turn[]; stores: Record<string, unknown>;
  attachments: { name: string; mime: string; text: string | null }[];
}) => Promise<{ reply: string; stores: Record<string, unknown> }>;
export interface Person { id: string; contact: string; created: number }
export interface ConversationStore {
  userFor(contact: string): Promise<Person | null>;
  ensureUser(contact: string, at: number): Promise<Person>;
  history(userId: string): Promise<Turn[]>;
  append(userId: string, m: Turn): Promise<void>;
  stores(userId: string): Promise<Record<string, unknown>>;
  setStores(userId: string, s: Record<string, unknown>): Promise<void>;
  enqueueProactive(userId: string, m: { key: string; text: string; at: number }): Promise<void>;
  drainProactive(now: number): Promise<Outbound[]>;
}

export const SAFE_ERROR_REPLY = "Something went wrong on my side, so nothing was saved, sent or submitted. Send that again in a minute.";
export const HISTORY_TURNS = 20;
// Nothing the outbox holds (at most OUTBOX_CHARS) is ever cut: an approval card is approved whole, so it must arrive
// whole, and a daily report keeps every posting it lists. MAX_BUBBLES is the proven bound for OUTBOX_CHARS at
// BUBBLE_CHARS (any two neighbouring text bubbles hold more than BUBBLE_CHARS between them, plus at most two link
// bubbles and the text they split); only longer text, which never reaches a person through the outbox, is cut.
export const OUTBOX_CHARS = 4000;
export const MAX_BUBBLES = 16;
const BUBBLE_CHARS = 700;

// A contact is normalized once: emails lowercased; phone numbers to +digits. Never guess a country code.
export function normalizeContact(contact: string): string {
  const t = String(contact || "").trim().toLowerCase();
  if (t.includes("@")) return t;
  const digits = t.replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("Invalid contact.");
  return "+" + digits;
}

// ---- bubble formatting (first written for the retired imessage-inbound test bridge) ----
// Short texting-sized bubbles on sentence boundaries; each bare URL gets its
// own bubble so iMessage renders a link preview card; nothing the outbox holds is cut.
// CHANNEL DELIVERY SCENARIOS (2026-10-29): a link is found by channel_text.ts findUrls, so the sentence around it keeps its
// own punctuation and brackets ("(https://x/1)." sends https://x/1, never "https://x/1)."), a link's own brackets stay
// ("…/wiki/Foo_(bar)"), and a markdown link [label](url) sends its label and the link, never "[label](" and "url)".
const isBareLink = (s: string) => isBareUrl(s);
const MD_LINK = /!?\[([^\]\n]+)\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/g;

// Exported for the WhatsApp and Telegram adapters (WO-038), which pack messages at their own size with the same rules.
export function splitLong(text: string, max: number): string[] {
  const t = text.trim();
  if (t.length <= max) return [t];
  // Chunk on existing line breaks first (the model structures replies with
  // newlines), then word-wrap overlong lines. Cuts happen ONLY at spaces,
  // so numbers (15.49), domains (netflix.com) and URLs are never split.
  // Whole lines travel together while they fit, so a list stays a list (a posting and its link in one bubble).
  const out: string[] = [];
  let buf = "";
  const add = (piece: string) => {
    if (buf && buf.length + 1 + piece.length <= max) { buf += "\n" + piece; return; }
    // A link that does not fit takes the line it belongs to (the posting above it) into the next bubble.
    const nl = buf.lastIndexOf("\n");
    if (isBareLink(piece) && nl > 0 && buf.length - nl + piece.length <= max) {
      out.push(buf.slice(0, nl));
      buf = `${buf.slice(nl + 1)}\n${piece}`;
      return;
    }
    if (buf) out.push(buf);
    buf = piece;
  };
  for (const line of t.split("\n")) {
    let rest = line.trim();
    if (!rest) continue;
    while (rest.length > max) {
      // CHANNEL DELIVERY SCENARIOS (2026-10-29): at the last space that fits, however early, so a word or a link that
      // fits the next message is never cut. Only a single word longer than a whole message is cut, and never inside a
      // character; a link that long goes whole on its own (the platform's own limit is the adapter's).
      let cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) {
        const sp = rest.indexOf(" "), word = sp < 0 ? rest : rest.slice(0, sp);
        cut = isBareLink(word) ? word.length : safeCut(rest, max) || max;
      }
      add(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) add(rest);
  }
  if (buf) out.push(buf);
  return out.length ? out : [t.slice(0, max)];
}

// The limits are the contract: at most MAX_BUBBLES bubbles, none longer than BUBBLE_CHARS, a bare link alone (a link is
// never cut, so a link bubble is as long as its link). A reply that does not fit is cut at a word and the last bubble
// says so; content is never dropped silently.
export const CUT_NOTE = "(That's where I had to stop. Ask me for the rest.)";
// previews=false (more than two links): a bare link is ordinary text, packed with its neighbours, since no preview cards
// are drawn for a wall of links anyway.
function packBubbles(segments: string[], previews = true): string[] {
  const isLinkBubble = (s: string) => previews && isBareLink(s);
  const sized: string[] = [];
  for (const s of segments) {
    if (isBareLink(s) || s.length <= BUBBLE_CHARS) sized.push(s);
    else sized.push(...splitLong(s, BUBBLE_CHARS));
  }
  // Join neighbouring text bubbles while the joined bubble still fits, so short paragraphs travel together.
  const packed: string[] = [];
  for (const s of sized) {
    const last = packed[packed.length - 1];
    if (last !== undefined && !isLinkBubble(last) && !isLinkBubble(s) && last.length + 2 + s.length <= BUBBLE_CHARS) packed[packed.length - 1] = `${last}\n\n${s}`;
    else packed.push(s);
  }
  if (packed.length <= MAX_BUBBLES) return packed;
  const keep = packed.slice(0, MAX_BUBBLES);
  let j = keep.length - 1;
  while (j >= 0 && isBareLink(keep[j])) j--;
  if (j < 0) { keep[keep.length - 1] = CUT_NOTE; return keep; }
  const room = BUBBLE_CHARS - CUT_NOTE.length - 1;
  let text = keep[j];
  if (text.length > room) { const cut = text.lastIndexOf(" ", room); text = text.slice(0, cut > room * 0.5 ? cut : safeCut(text, room)).trimEnd(); }
  keep[j] = `${text} ${CUT_NOTE}`;
  return keep;
}

// What the outbox may hold: text over OUTBOX_CHARS is cut at a word and says so, never silently (a reply is the only
// text that can be that long; a card is built under the same limit).
export function fitOutbox(text: string): string {
  const t = String(text ?? "").trim();
  if (t.length <= OUTBOX_CHARS) return t;
  const room = OUTBOX_CHARS - CUT_NOTE.length - 1;
  const cut = t.lastIndexOf(" ", room);
  return `${t.slice(0, cut > room * 0.5 ? cut : safeCut(t, room)).trimEnd()} ${CUT_NOTE}`;
}

export function toBubbles(reply: string): string[] {
  // Strip hidden markers (exec-offer etc.) — they'd render as raw text in iMessage.
  const clean = reply.replace(/<!--[\s\S]*?-->/g, "").replace(MD_LINK, (_m, label: string, url: string) => {
    const l = label.trim();
    return l === url ? url : `${l} ${url}`;
  }).trim();
  if (!clean) return [];
  const urls = findUrls(clean);
  // Many links: no preview cards (a wall of them), plain texting-sized text instead.
  if (urls.length > 2) return packBubbles(clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean), false);
  const raw: string[] = [];
  for (const para of clean.split(/\n\s*\n/)) {
    let buf = "";
    const flush = () => {
      const t = buf.trim();
      if (t) raw.push(t);
      buf = "";
    };
    for (const line of para.split("\n")) {
      const lineUrls = findUrls(line);
      if (!lineUrls.length) {
        buf += (buf ? "\n" : "") + line;
        continue;
      }
      let at = 0;
      for (const u of lineUrls) {
        // The text before the link (without the bracket or "here:" that led to it), the link alone, then what follows it
        // (without the bracket and punctuation that closed it).
        const before = line.slice(at, u.start).replace(/[\s:–—(<\["“‘'-]+$/, "").trim();
        if (before) buf += (buf ? "\n" : "") + before;
        flush();
        raw.push(u.url);
        at = u.end + /^[\s.,;:!?)>\]"”’']*/.exec(line.slice(u.end))![0].length;
      }
      const rest = line.slice(at);
      if (rest.trim()) buf += (buf ? "\n" : "") + rest.trim();
    }
    flush();
  }
  return packBubbles(raw);
}

const TEXT_MIME = /^text\/|^application\/(json|csv)$/;
const decode = (a: Attachment) => (TEXT_MIME.test(a.mime) ? new TextDecoder().decode(a.bytes) : null);

export async function handleInbound(i: Inbound, d: { brain: Brain; store: ConversationStore; channel?: Pick<ChannelStore, "setOptOut"> }): Promise<Outbound> {
  // STOP / START / HELP are the channel's, never the brain's (WO-013a): answered with fixed words, recorded, and no
  // person is created or history written for them.
  const command = d.channel ? channelCommand(i.text) : null;
  if (command && d.channel) {
    const contact = normalizeContact(i.contact);
    if (command !== "help") await d.channel.setOptOut(contact, command === "stop", i.at);
    return { contact, kind: "reply", bubbles: toBubbles(CHANNEL_REPLIES[command]) };
  }
  const person = await d.store.ensureUser(i.contact, i.at);
  const history = (await d.store.history(person.id)).slice(-HISTORY_TURNS);
  const stores = await d.store.stores(person.id);
  const attachments = (i.attachments || []).map((a) => ({ name: a.name, mime: a.mime, text: decode(a) }));
  let reply: string;
  try {
    const r = await d.brain({ userId: person.id, message: i.text, history, stores: JSON.parse(JSON.stringify(stores)), attachments });
    reply = String(r.reply || "").trim();
    // An empty reply is a failure: the person is told nothing was saved, so nothing is.
    if (!reply) throw new Error("the brain returned an empty reply");
    await d.store.setStores(person.id, r.stores);
  } catch (e) {
    console.error("conversation: brain failed:", e instanceof Error ? e.message : String(e));
    reply = SAFE_ERROR_REPLY;
  }
  await d.store.append(person.id, { role: "user", content: i.text });
  await d.store.append(person.id, { role: "assistant", content: reply });
  return { contact: person.contact, kind: "reply", bubbles: toBubbles(reply) };
}

// In-memory store (tests and the simulator). dump()/load() make it serializable so a simulator session can resume.
export interface MemoryState {
  people: Person[]; history: Record<string, Turn[]>; stores: Record<string, Record<string, unknown>>;
  queue: { userId: string; key: string; text: string; at: number }[]; delivered: string[]; seq: number;
}
export function memoryStore(initial?: MemoryState): ConversationStore & { dump(): MemoryState; forget(userId: string): Promise<void> } {
  const st: MemoryState = initial ? JSON.parse(JSON.stringify(initial)) : { people: [], history: {}, stores: {}, queue: [], delivered: [], seq: 0 };
  const byContact = (c: string) => st.people.find((p) => p.contact === c) || null;
  const store = {
    async userFor(contact: string) { return byContact(normalizeContact(contact)); },
    async ensureUser(contact: string, at: number) {
      const c = normalizeContact(contact);
      let p = byContact(c);
      if (!p) { p = { id: `u${++st.seq}`, contact: c, created: at }; st.people.push(p); }
      return p;
    },
    async history(userId: string) { return (st.history[userId] || []).map((m) => ({ ...m })); },
    async append(userId: string, m: Turn) { (st.history[userId] ||= []).push({ role: m.role, content: m.content }); },
    async stores(userId: string) { return JSON.parse(JSON.stringify(st.stores[userId] || {})); },
    async setStores(userId: string, s: Record<string, unknown>) { st.stores[userId] = JSON.parse(JSON.stringify(s || {})); },
    async enqueueProactive(userId: string, m: { key: string; text: string; at: number }) {
      const k = `${userId}|${m.key}`;
      if (st.delivered.includes(k) || st.queue.some((q) => q.userId === userId && q.key === m.key)) return;
      st.queue.push({ userId, key: m.key, text: m.text, at: m.at });
    },
    async drainProactive(now: number) {
      const due = st.queue.filter((q) => q.at <= now).sort((a, b) => a.at - b.at);
      st.queue = st.queue.filter((q) => q.at > now);
      const out: Outbound[] = [];
      for (const q of due) {
        st.delivered.push(`${q.userId}|${q.key}`);
        await store.append(q.userId, { role: "assistant", content: q.text });
        const p = st.people.find((x) => x.id === q.userId);
        if (p) out.push({ contact: p.contact, kind: "proactive", bubbles: toBubbles(q.text) });
      }
      return out;
    },
    // Forget a person (the simulator's /reset): their state, history and anything still queued for them. Keys already
    // delivered stay recorded, so an alert they already got is never sent twice.
    async forget(userId: string) { st.stores[userId] = {}; st.history[userId] = []; st.queue = st.queue.filter((q) => q.userId !== userId); },
    dump() { return JSON.parse(JSON.stringify(st)); },
  };
  return store;
}
