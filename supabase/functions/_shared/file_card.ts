// SPEC C.2 (docs/architect/specs/APP-LAYER-15-FIXES.md; D-049): the chat File card. A File turn shows ONE card per result, never a
// list of raw links: a caps kicker, the File's title, a freshness line with real counts, up to three state chips, one button, and the
// caption "Opens your private File - nothing is submitted from chat"; then a follow-up that names the exact decision.
//
// Counts come from the items' own states (results_spec.ts specOf for roles; the stored record for the other kinds), never from taps
// (an Apply tap is not an application). Every item is in exactly one bucket, so the counts are exclusive and sum to the item total.
// The card is built by code from those counts; nothing here is written by a model and nothing here states a fact about the person.
//
// Channel shapes (D-049): Telegram, the link rides as the one inline button (the Mini App button where Telegram sign-in is set up,
// file_link.ts B1); WhatsApp and iMessage, the link is the plain last line; web, the card as data (FileCardData) and as HTML.
//
// Switch: CAREER_FILE_CARD, a release flag (D-049; agent-chat/release_config.ts): served on; CAREER_FILE_CARD=off rolls it back and
// the link goes alone, as before.
import type { Button, DeliveryAdapter, SendOptions, SendResult } from "./channel_adapters.ts";
import { escapeHtml } from "./channel_voice.ts";
import { releaseFlagOn } from "../agent-chat/release_config.ts";
import { FAMILIES, type FamilyId } from "./file_family.ts";
import type { FileRecord } from "./file_kinds.ts";
import { fileAppFor, verifyFileToken } from "./file_link.ts";
import type { Spec } from "./results_spec.ts";
import type { JobStore } from "./telegram_jobs.ts";

export const FILE_CARD_ENV = "CAREER_FILE_CARD";
export const fileCardOn = (env: { get(k: string): string | undefined }) => releaseFlagOn(env, "CAREER_FILE_CARD");
export const CARD_CAPTION = "Opens your private File - nothing is submitted from chat";
export const MAX_CHIPS = 3;

export type CardBucket = "ready" | "review" | "needs" | "progress" | "done" | "closed";
export const BUCKET_ORDER: readonly CardBucket[] = ["ready", "review", "needs", "progress", "done", "closed"];
// The chips that must show when present come first: what needs the person, then what waits for their yes.
const CHIP_PRIORITY: readonly CardBucket[] = ["needs", "review", "ready", "progress", "done", "closed"];
export type ChipTone = "good" | "plum" | "warn" | "info" | "done" | "mute";
const TONE: Record<CardBucket, ChipTone> = { ready: "good", review: "plum", needs: "warn", progress: "info", done: "done", closed: "mute" };
const LINE: Record<CardBucket, string> = { ready: "ready", review: "waiting for your yes", needs: "need answers", progress: "in progress", done: "done", closed: "closed" };
const CHIP: Record<CardBucket, string> = { ready: "ready", review: "for your yes", needs: "need you", progress: "in progress", done: "done", closed: "closed" };

interface FamilyCard { name: string; kicker: string; noun: [string, string]; button: string; line?: Partial<Record<CardBucket, string>> }
// name: the family's name (file_family.ts FAMILIES); the kicker is the family's own header in caps; the button names what the File is for.
export const FAMILY_CARD: Record<FamilyId, FamilyCard> = {
  "F-01": { name: "Career brief", kicker: "CAREER BRIEF", noun: ["item", "items"], button: "Open brief" },
  "F-02": { name: "Profile facts", kicker: "PROFILE FACTS", noun: ["fact", "facts"], button: "Review facts" },
  "F-03": { name: "Path comparison", kicker: "PATH COMPARISON", noun: ["path", "paths"], button: "Compare paths" },
  "F-04": { name: "Search plan", kicker: "SEARCH PLAN", noun: ["step", "steps"], button: "Review plan" },
  "F-05": { name: "Roles shortlist", kicker: "ROLES FILE", noun: ["role", "roles"], button: "Review roles", line: { ready: "ready to prepare" } },
  "F-06": { name: "Role workspace", kicker: "ROLE WORKSPACE", noun: ["requirement", "requirements"], button: "Open role" },
  "F-07": { name: "Materials studio", kicker: "MATERIALS STUDIO", noun: ["document", "documents"], button: "Review materials" },
  "F-08": { name: "Answer library", kicker: "ANSWER LIBRARY", noun: ["answer", "answers"], button: "Review answers" },
  "F-09": { name: "Application review", kicker: "APPLICATION REVIEW", noun: ["answer", "answers"], button: "Review application" },
  "F-10": { name: "Batch File", kicker: "BATCH FILE", noun: ["role", "roles"], button: "Review batch", line: { ready: "ready to prepare" } },
  "F-11": { name: "Pipeline", kicker: "PIPELINE", noun: ["application", "applications"], button: "Open pipeline" },
  "F-12": { name: "People and messages", kicker: "MESSAGE REVIEW", noun: ["message", "messages"], button: "Review message" },
  "F-13": { name: "Interview hub", kicker: "INTERVIEW HUB", noun: ["item", "items"], button: "Open interview hub" },
  "F-14": { name: "Plan and weekly brief", kicker: "WEEKLY BRIEF", noun: ["item", "items"], button: "Open weekly brief" },
  "F-15": { name: "Offer comparison", kicker: "OFFER COMPARISON", noun: ["offer", "offers"], button: "Compare offers" },
};

export interface CardInput { family: FamilyId; title: string; batch?: string | null; updatedAt: number; tz?: string | null; items: readonly { state: CardBucket }[]; url: string; webApp?: string | null }
export interface FileCardData {
  type: "file_card"; family: FamilyId; kicker: string; title: string; freshness: string; counts: { bucket: CardBucket; n: number }[]; total: number;
  chips: { bucket: CardBucket; label: string; tone: ChipTone }[]; button: { label: string; url: string; webApp: string | null }; caption: string; followup: string;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const say = (n: number) => (n <= 10 ? WORDS[n] : String(n));
// deno-lint-ignore no-control-regex
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
function clock(at: number, tz?: string | null): string {
  const o: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" };
  try { if (tz) new Intl.DateTimeFormat("en-US", { timeZone: tz }); if (tz) o.timeZone = tz; } catch { /* the default zone */ }
  return new Intl.DateTimeFormat("en-US", o).format(new Date(at)).replace(/ /g, " ");
}

export function fileCard(i: CardInput): FileCardData | null {
  const f = FAMILY_CARD[i.family];
  if (!f || !/^https:\/\/\S+$/.test(i.url) || !Number.isFinite(i.updatedAt)) return null;
  const n = new Map<CardBucket, number>();
  for (const it of i.items) if (BUCKET_ORDER.includes(it.state)) n.set(it.state, (n.get(it.state) ?? 0) + 1);
  const counts = BUCKET_ORDER.filter((b) => n.get(b)).map((b) => ({ bucket: b, n: n.get(b)! }));
  const total = counts.reduce((a, c) => a + c.n, 0);
  const noun = (k: number) => (k === 1 ? f.noun[0] : f.noun[1]);
  const shown = new Set(CHIP_PRIORITY.filter((b) => n.get(b)).slice(0, MAX_CHIPS));
  const chips = BUCKET_ORDER.filter((b) => shown.has(b)).map((b) => ({ bucket: b, label: `${n.get(b)} ${CHIP[b]}`, tone: TONE[b] }));
  const line = [`Updated ${clock(i.updatedAt, i.tz)}`, ...(total ? counts.map((c) => `${c.n} ${f.line?.[c.bucket] ?? LINE[c.bucket]}`) : [`no ${f.noun[1]} yet`])].join(" - ");
  const need = n.get("needs") ?? 0, yes = n.get("review") ?? 0, ready = n.get("ready") ?? 0, going = n.get("progress") ?? 0;
  const followup = need ? `${say(need)} ${noun(need)} ${need === 1 ? "needs" : "need"} an answer from you. The File shows exactly which.`
    : yes ? `${say(yes)} ${noun(yes)} ${yes === 1 ? "waits" : "wait"} for your yes. Nothing is sent until you say yes to it.`
    : ready ? `${say(ready)} ${noun(ready)} ${ready === 1 ? "is" : "are"} ready for you to look over. Nothing is submitted from here.`
    : going ? `${say(going)} ${noun(going)} ${going === 1 ? "is" : "are"} in progress. Nothing needs you right now.`
    : "Nothing needs you right now.";
  const batch = clean(i.batch, 24).toUpperCase();
  return { type: "file_card", family: i.family, kicker: batch ? `${f.kicker} - ${batch}` : f.kicker, title: clean(i.title, 80) || f.name, freshness: line,
    counts, total, chips, button: { label: f.button, url: i.url, webApp: i.webApp && /^https:\/\/\S+$/.test(i.webApp) ? i.webApp : null }, caption: CARD_CAPTION, followup };
}

// ---------------------------------------------------------------- channel shapes
export type CardChannel = "telegram" | "whatsapp" | "imessage";
export interface CardMessage { text: string; buttons?: Button[][] }
// The card as texting messages: the card, then the follow-up. html: Telegram with the texting voice (send() parses HTML).
export function cardMessages(c: FileCardData, channel: CardChannel, o: { html?: boolean } = {}): CardMessage[] {
  const e = (s: string) => (o.html ? escapeHtml(s) : s);
  const body = [e(c.kicker), o.html ? `<b>${e(c.title)}</b>` : c.title, e(c.freshness), e(c.chips.map((x) => `[${x.label}]`).join(" ")), e(CARD_CAPTION)];
  if (channel === "telegram") {
    const b: Button = c.button.webApp ? { text: c.button.label, webApp: c.button.webApp } : { text: c.button.label, url: c.button.url };
    return [{ text: body.join("\n"), buttons: [[b]] }, { text: e(c.followup) }];
  }
  return [{ text: [...body, `${c.button.label}:`, c.button.url].join("\n") }, { text: c.followup }];
}

// The web chat's card (the same data, drawn as spec C.2 draws it).
export function cardHtml(c: FileCardData): string {
  const tone: Record<ChipTone, string> = { good: "#E6F4EA;color:#1E6B34", plum: "#F1E8F0;color:#5C2751", warn: "#FFF3DC;color:#8A5A00", info: "#E8F0FB;color:#24508F", done: "#E6F4EA;color:#1E6B34", mute: "#EEEDEB;color:#5F5B57" };
  const x = escapeHtml, q = (s: string) => x(s).replace(/"/g, "&quot;");
  return `<article class="file-card" style="width:85%;background:#fff;border-radius:24px;overflow:hidden;border:1px solid #E7E2DE">`
    + `<div style="background:linear-gradient(90deg,#5C2751,#8A4C7D);color:#fff;padding:8px 16px;font:600 11px/1.4 Inter,sans-serif;letter-spacing:.08em">${x(c.kicker)}</div>`
    + `<div style="padding:14px 16px"><h3 style="font:600 20px/1.3 'Brygada 1918',serif;margin:0">${x(c.title)}</h3><p style="color:#6B6560;font-size:13px;margin:6px 0">${x(c.freshness)}</p>`
    + `<p style="margin:8px 0">${c.chips.map((h) => `<span class="chip" style="display:inline-block;margin-right:6px;padding:3px 10px;border-radius:999px;font-size:12px;background:${tone[h.tone]}">${x(h.label)}</span>`).join("")}</p>`
    + `<a class="btn" href="${q(c.button.url)}" style="display:block;text-align:center;background:#5C2751;color:#fff;border-radius:999px;padding:12px;text-decoration:none;font-weight:600">${x(c.button.label)}</a>`
    + `<p style="text-align:center;color:#6B6560;font-size:12px;margin:8px 0 0">${x(CARD_CAPTION)}</p></div></article>`;
}

// ---------------------------------------------------------------- what a File's items are
// Roles (F-05, F-10): one bucket per role, from its one primary state (results_spec.ts specOf).
export function bucketOfRole(s: RoleSpec): CardBucket {
  switch (s.bucket) {
    case "notprep": return "ready";
    case "ready": return "review";
    case "needs": return "needs";
    case "preparing": case "progress": return "progress";
    case "done": return "done";
    default: return "closed";
  }
}
// A stored File of the other kinds: its family and its items' states, from the record only. null: the kind has no family card
// (the research brief), and its link goes as before.
export function cardSourceOf(rec: CardRecord): { family: FamilyId; title: string; items: { state: CardBucket }[] } | null {
  // deno-lint-ignore no-explicit-any
  const d: any = rec.data ?? {}, st = rec.state ?? {};
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const head = (s: string) => [s, [d.role, d.company].filter(Boolean).join(", ")].filter(Boolean).join(": ");
  switch (rec.kind) {
    case "application_review": {
      const r = d.review ?? {};
      return { family: "F-09", title: head("Application review"), items: [...arr(r.answers).map(() => ({ state: "ready" as const })), ...arr(r.unresolved).map(() => ({ state: "needs" as const }))] };
    }
    case "application_proof": {
      const s = d.stage === "employer_confirmed" ? "done" : d.stage === "not_submitted" || d.stage === "failed" ? "closed" : "progress";
      return { family: "F-11", title: head("Application"), items: [{ state: s }] };
    }
    case "introduction": {
      const c = st.choice;
      return { family: "F-12", title: clean(d.title, 80) || `Introduction to ${clean(d.person?.name, 60)}`, items: [{ state: c === "introduced" ? "done" : c === "approved" ? "progress" : c === "passed" ? "closed" : "review" }] };
    }
    case "draft": return { family: "F-07", title: clean(d.title, 80) || "Draft", items: [{ state: "ready" }] };
    case "plan_review": {
      const family: FamilyId = d.variant === "interview_prep" ? "F-13" : d.variant === "pipeline" ? "F-11" : d.variant === "weekly" ? "F-14" : "F-04";
      return { family, title: clean(d.title, 80), items: arr(d.sections).flatMap((s) => arr(s?.items)).map(() => ({ state: "ready" as const })) };
    }
    case "comparison": return { family: d.variant === "offer" ? "F-15" : "F-03", title: clean(d.title, 80), items: arr(d.options).map(() => ({ state: "ready" as const })) };
    default: return null;
  }
}

// A roles results list (F-05; role_results.ts, the "I want X roles" page): one item per listed role, read from the person's own records
// at the time the card is drawn: already in their applications queue (applied) is in progress; a prepared application waits for their
// yes; a role they set aside on the page is closed; any other role is ready to prepare. Nothing here counts a tap. null: not a results list.
export async function rolesCardSource(store: Pick<JobStore, "recallList" | "recall" | "prepared" | "applied" | "recallListMeta">, userId: string, listId: string): Promise<{ family: FamilyId; title: string; updatedAt: number; items: { state: CardBucket }[] } | null> {
  const meta = store.recallListMeta ? await store.recallListMeta(userId, listId) : null;
  const refs = meta?.kind === "results" ? await store.recallList(userId, listId) : null;
  if (!meta || !refs?.length) return null;
  const aside = new Set(meta.dismissed ?? []);
  const items = await Promise.all(refs.map(async (ref): Promise<{ state: CardBucket }> => {
    if (aside.has(ref)) return { state: "closed" };
    const job = (await store.recall(userId, ref))?.job;
    if (!job) return { state: "closed" };
    if (await store.applied(userId, job.job_id)) return { state: "progress" };
    return { state: (await store.prepared(userId, job.job_id))?.payload_hash ? "review" : "ready" };
  }));
  const what = clean(meta.what, 80);
  return { family: "F-05", title: what ? what.charAt(0).toUpperCase() + what.slice(1) : FAMILIES["F-05"].name, updatedAt: meta.at, items };
}

// ---------------------------------------------------------------- delivery
// A message that is exactly one File link becomes its card. resolve: the card for that link (the token checked, the record read
// for its owner), or null, and the message goes exactly as before. Everything else is sent as it was; the caller's buttons ride
// the reply's last message as before.
export type CardResolver = (link: string) => Promise<FileCardData | null>;
export function withFileCards<A extends DeliveryAdapter>(adapter: A, resolve: CardResolver): A {
  const channel = adapter.channel as CardChannel;
  if (channel !== "telegram" && channel !== "whatsapp" && channel !== "imessage") return adapter;
  const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
  const send = async (address: string, bubbles: string[], opts?: SendOptions): Promise<SendResult> => {
    const cards = await Promise.all(bubbles.map((b) => (/^https:\/\/\S+$/.test(plain(b)) ? resolve(plain(b)).catch(() => null) : Promise.resolve(null))));
    if (!cards.some(Boolean)) return adapter.send(address, bubbles, opts);
    // One group per original message: plain runs stay together; a card is its own send (its button under it), then its follow-up.
    const groups: { from: number; kind: "plain" | "card" | "follow"; msgs: CardMessage[] }[] = [];
    bubbles.forEach((b, i) => {
      const c = cards[i];
      if (c) { cardMessages(c, channel, { html: !!adapter.htmlText }).forEach((m, j) => groups.push({ from: i, kind: j ? "follow" : "card", msgs: [m] })); return; }
      const g = groups.at(-1);
      if (g?.kind === "plain") g.msgs.push({ text: b }); else groups.push({ from: i, kind: "plain", msgs: [{ text: b }] });
    });
    const ids: string[] = [];
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k], last = k === groups.length - 1, own = g.msgs[0].buttons;
      const o: SendOptions | undefined = own ? { ...(opts?.urgent ? { urgent: true } : {}), buttons: own } : last ? opts : opts?.urgent ? { urgent: true } : undefined;
      const r = await adapter.send(address, g.msgs.map((m) => m.text), o);
      if (!r.ok) {
        // How many of the ORIGINAL messages went out whole (the outbox resumes after them): a card counts once it went.
        const done = g.kind === "card" ? g.from : g.kind === "follow" ? g.from + 1 : g.from + (r.sent ?? 0);
        return { ...r, ...(done ? { sent: done, sentIds: [...ids, ...(r.sentIds ?? [])] } : {}) };
      }
      ids.push(...(r.ids ?? (r.id ? [r.id] : [])));
    }
    return { ok: true, id: ids[0] ?? null, ids };
  };
  return { ...adapter, send };
}

// The resolver the outbox uses: a link counts only when it is one of OUR File links (TRAINEE_FILE_BASE_URL, signature checked, a
// link token, not expired), and the card is drawn from that link's own record, read for the account in the token. A File that is
// missing, expired, revoked or of a kind with no family card: null, the link goes alone as before.
// jobs: the roles results lists (rolesCardSource), read when the link names no stored File.
export function fileCardResolver(o: { env: { get(k: string): string | undefined }; now: () => number; files: { get(userId: string, id: string): Promise<{ state: string; rec?: FileRecord }> }; jobs?: Parameters<typeof rolesCardSource>[0] }): CardResolver {
  return async (link) => {
    const base = (o.env.get("TRAINEE_FILE_BASE_URL") || "").trim();
    if (!/^https:\/\/[^\s?#]+$/.test(base) || !link.startsWith(`${base}?t=`)) return null;
    const c = await verifyFileToken(link.slice(base.length + 3), o.env.get("TRAINEE_FILE_LINK_SECRET"), o.now());
    if (!c.ok || c.claims.k !== "l") return null;
    const g = await o.files.get(c.claims.u, c.claims.r);
    const kind = g.state === "ok" && g.rec ? cardSourceOf(g.rec) : null;
    const src = kind && g.rec ? { ...kind, updatedAt: g.rec.created_at } : g.state === "missing" && o.jobs ? await rolesCardSource(o.jobs, c.claims.u, c.claims.r) : null;
    if (!src) return null;
    return fileCard({ ...src, url: link, webApp: await fileAppFor(o.env, link, o.now()).catch(() => null) });
  };
}
