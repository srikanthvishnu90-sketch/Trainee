// Instinct harness: a brand-new person on one channel, talking to Trainee through that channel's real inbound webhook
// (the deployed function, reached at /functions/v1/<name>):
//   web       agent-chat, as the app sends a turn (POST with the person's bearer token; files as the app attaches them)
//   telegram  trainee-telegram, a Bot API update with Telegram's secret header (documents as Telegram sends them)
//   whatsapp  trainee-whatsapp, a Cloud API webhook signed with the app secret (documents as media ids)
//   imessage  trainee-inbound, LoopMessage's inbound webhook with the shared secret (attachments as URLs)
// What the person READ is what left through the channel's provider (the fake's send log), never the function's return
// value; on the web it is the app's response body. Every reply is kept, for the plain-words and truth checks.
// deno-lint-ignore-file no-explicit-any
import { whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { deflateSync } from "node:zlib";
import { SECRETS, SUPABASE_URL, type World } from "./world.ts";

export type Channel = "web" | "telegram" | "whatsapp" | "imessage";
export const CHANNELS: Channel[] = ["web", "telegram", "whatsapp", "imessage"];
export interface Turn { said: string; texts: string[]; text: string; status: number; body: any; ms: number }

let seq = 0;
const nextId = () => ++seq;

export interface Persona { first: string; last: string; email: string; phone: string; school: string }
export function persona(n: number, first = "Priya", last = "Raman"): Persona {
  const d = String(1000 + (n % 9000)).padStart(4, "0");
  return { first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}.${n}@example.test`, phone: `312-555-${d}`, school: "TEST University" };
}
export function resumeText(p: Persona, extra = ""): string {
  const base = Deno.readTextFileSync(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
  return base.replace(/Alex Testcase/g, `${p.first} ${p.last}`).replace(/alex\.testcase@example\.test/g, p.email).replace(/\+1 555-0100/g, `+1 ${p.phone}`) + (extra ? `\n${extra}\n` : "");
}
// The resume as a real one-page PDF (text in a Flate content stream, the shape a word processor exports).
export function resumePdf(text: string): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const ops = text.split("\n").map((l, i) => l.trim() ? `BT /F1 9 Tf 1 0 0 1 40 ${1150 - i * 12} Tm (${esc(l)}) Tj ET` : "").filter(Boolean).join("\n");
  const stream = deflateSync(new TextEncoder().encode(ops));
  const enc = new TextEncoder(), parts: Uint8Array[] = [], offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { parts.push(b); pos += b.length; };
  push(enc.encode("%PDF-1.4\n"));
  const objs: (string | Uint8Array)[][] = [
    ["<< /Type /Catalog /Pages 2 0 R >>"], ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"],
    [`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, stream, "\nendstream"], ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
  objs.forEach((o, i) => { offsets.push(pos); push(enc.encode(`${i + 1} 0 obj\n`)); for (const p of o) push(typeof p === "string" ? enc.encode(p) : p); push(enc.encode("\nendobj\n")); });
  const xref = pos;
  push(enc.encode(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(pos);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
export const sha256Hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

// Every person the harness made, for the transcripts (main.ts writes them next to the scorecard).
export const everyone: Person[] = [];
export class Person {
  readonly channel: Channel;
  readonly n: number;
  readonly p: Persona;
  readonly address: string;     // the channel's own address for this person
  readonly contact: string;     // channel_contacts.contact
  userId: string | null = null;
  token: string | null = null;  // web only
  thread: string | null = null; // web only
  turns: Turn[] = [];
  lastUpdate: any = null;       // the last raw webhook body, for a provider retry
  constructor(readonly w: World, channel: Channel, n: number, p?: Persona) {
    this.channel = channel; this.n = n; this.p = p ?? persona(n);
    this.address = channel === "telegram" ? String(800000000 + n) : channel === "whatsapp" ? `1555${String(7000000 + n)}` : channel === "imessage" ? `+1555${String(8000000 + n)}` : this.p.email;
    this.contact = channel === "telegram" ? `tg:${this.address}` : channel === "whatsapp" ? `wa:${this.address}` : this.address;
    everyone.push(this);
  }

  // Web sign-up is Supabase Auth (the app's sign-in page). Channels sign up by their first message (TRAINEE_SIGNUP=open).
  async begin() {
    if (this.channel === "web" && !this.token) {
      const a = await this.w.signUpWeb(this.p.email);
      this.userId = a.id; this.token = a.token;
    }
  }
  async resolveUser(): Promise<string | null> {
    if (this.channel === "web") return this.userId;
    const r = await this.w.one(`select coalesce((select user_id::text from public.channel_contacts where contact = ${this.w.q(this.contact)} limit 1), '')`);
    this.userId = r || null;
    return this.userId;
  }

  private mark() {
    const f = this.w.fakes;
    return this.channel === "telegram" ? f.telegram.sent.length : this.channel === "whatsapp" ? f.whatsapp.sent.length : this.channel === "imessage" ? f.loop.sent.length : 0;
  }
  private readSince(m: number): string[] {
    const f = this.w.fakes;
    return this.channel === "telegram" ? f.telegram.textsTo(Number(this.address), m) : this.channel === "whatsapp" ? f.whatsapp.textsTo(this.address, m) : this.channel === "imessage" ? f.loop.textsTo(this.address, m) : [];
  }

  // One message from the person. `replyTo`: the provider's id of the message they reply to (Telegram, WhatsApp).
  async say(text: string, o: { replyTo?: string | number | null; files?: { name: string; mime: string; bytes: Uint8Array }[]; attachments?: { name: string; mime: string; text: string }[] } = {}): Promise<Turn> {
    await this.begin();
    const m = this.mark(), t0 = performance.now();
    let status = 0, body: any = null, texts: string[] = [];
    if (this.channel === "web") {
      const res = await this.w.call("agent-chat", {
        method: "POST", headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json", origin: "http://localhost:8080" },
        body: JSON.stringify({
          message: text, ...(this.thread ? { thread_id: this.thread } : {}), ...(o.replyTo ? { reply_to_message_id: o.replyTo } : {}),
          ...(o.attachments || o.files ? { attachments: [...(o.attachments ?? []), ...(o.files ?? []).map((f) => ({ name: f.name, mime: f.mime, text: null, data_base64: b64(f.bytes) }))] } : {}),
          ...(o.files ? { files: o.files.map((f) => ({ name: f.name, mime: f.mime, data_base64: b64(f.bytes) })) } : {}),
        }),
      });
      status = res.status; body = res.body;
      if (body?.thread_id) this.thread = body.thread_id;
      const parts = Array.isArray(body?.parts) ? body.parts.map(String) : null;
      texts = parts ?? (typeof body?.reply === "string" ? [body.reply] : []);
    } else {
      const r = await this.post(text, o);
      status = r.status; body = r.body;
      texts = this.readSince(m);
    }
    const turn: Turn = { said: text, texts, text: texts.join("\n\n"), status, body, ms: Math.round(performance.now() - t0) };
    this.turns.push(turn);
    if (!this.userId) await this.resolveUser();
    return turn;
  }

  // A file the person sends (their resume as a PDF, their LinkedIn export).
  async sendFile(name: string, mime: string, bytes: Uint8Array, caption = ""): Promise<Turn> {
    await this.begin();
    if (this.channel === "web") return await this.say(caption, { files: [{ name, mime, bytes }] });
    const m = this.mark(), t0 = performance.now(), id = nextId();
    let r: { status: number; body: any };
    if (this.channel === "telegram") {
      const fileId = `INSTINCT-FILE-${id}`;
      this.w.fakes.telegram.files.set(`documents/${fileId}`, bytes);
      r = await this.postTelegram({ message: { message_id: id, from: { id: Number(this.address), is_bot: false, first_name: this.p.first }, chat: { id: Number(this.address), type: "private" }, date: Math.floor(Date.now() / 1000),
        document: { file_id: fileId, file_unique_id: `uniq-${fileId}`, file_name: name, mime_type: mime, file_size: bytes.length }, ...(caption ? { caption } : {}) } });
    } else if (this.channel === "whatsapp") {
      const mediaId = `9${String(id).padStart(14, "0")}`;
      this.w.fakes.whatsapp.media.set(mediaId, { bytes, mime, name });
      r = await this.postWhatsApp({ from: this.address, id: `wamid.in.${id}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "document", document: { id: mediaId, filename: name, mime_type: mime, ...(caption ? { caption } : {}) } });
    } else {
      // LoopMessage: an inbound message with an attachment carries the file as a URL.
      const url = `https://storage.loopmessage.com/attachments/${id}/${encodeURIComponent(name)}`;
      this.w.fakes.loop.files.set(url, { bytes, mime });
      r = await this.postLoop({ alert_type: "message_inbound", message_id: `lm-in-${id}`, recipient: this.address, text: caption, attachments: [url] });
    }
    const texts = this.readSince(m);
    const turn: Turn = { said: `[file ${name}]${caption ? ` ${caption}` : ""}`, texts, text: texts.join("\n\n"), status: r.status, body: r.body, ms: Math.round(performance.now() - t0) };
    this.turns.push(turn);
    if (!this.userId) await this.resolveUser();
    return turn;
  }

  // Several messages sent at once, the way people text ("hi" "my name is" "and my email"): each its own webhook, together.
  async burst(texts: string[]): Promise<Turn[]> {
    await this.begin();
    if (this.channel === "web") return await Promise.all(texts.map((t) => this.say(t)));
    const m = this.mark();
    const results = await Promise.all(texts.map((t) => this.post(t, {})));
    const read = this.readSince(m);
    const turns = texts.map((t, i) => ({ said: t, texts: i === 0 ? read : [], text: i === 0 ? read.join("\n\n") : "", status: results[i].status, body: results[i].body, ms: 0 }));
    this.turns.push(...turns);
    if (!this.userId) await this.resolveUser();
    return turns;
  }

  // The provider sends the same webhook again (a retry): it must run no second turn.
  async retryLast(): Promise<{ status: number; body: any; texts: string[] }> {
    const m = this.mark();
    const raw = this.lastUpdate;
    let r: { status: number; body: any };
    if (this.channel === "telegram") r = await this.postTelegram(raw, true);
    else if (this.channel === "whatsapp") r = await this.postWhatsApp(raw, true);
    else r = await this.postLoop(raw, true);
    return { ...r, texts: this.readSince(m) };
  }

  private async post(text: string, o: { replyTo?: string | number | null }) {
    const id = nextId();
    if (this.channel === "telegram") {
      return await this.postTelegram({ message: { message_id: id, from: { id: Number(this.address), is_bot: false, first_name: this.p.first }, chat: { id: Number(this.address), type: "private" }, date: Math.floor(Date.now() / 1000), text,
        ...(o.replyTo ? { reply_to_message: { message_id: Number(o.replyTo), chat: { id: Number(this.address), type: "private" }, date: 1 } } : {}) } });
    }
    if (this.channel === "whatsapp") {
      return await this.postWhatsApp({ from: this.address, id: `wamid.in.${id}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text }, ...(o.replyTo ? { context: { id: String(o.replyTo) } } : {}) });
    }
    return await this.postLoop({ alert_type: "message_inbound", message_id: `lm-in-${id}`, recipient: this.address, text });
  }
  private async postTelegram(update: any, retry = false) {
    const body = retry ? update : { update_id: 500000 + nextId(), ...update };
    this.lastUpdate = body;
    return await this.w.call("trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRETS.tgSecret }, body: JSON.stringify(body) });
  }
  private async postWhatsApp(message: any, retry = false) {
    const body = retry ? message : { object: "whatsapp_business_account", entry: [{ id: "WABA-INSTINCT", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: SECRETS.waPnid }, contacts: [{ wa_id: this.address, profile: { name: `${this.p.first} ${this.p.last}` } }],
      messages: [message] } }] }] };
    this.lastUpdate = body;
    const raw = new TextEncoder().encode(JSON.stringify(body));
    return await this.w.call("trainee-whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await whatsappSignature(SECRETS.waApp, raw) }, body: raw });
  }
  private async postLoop(body: any, retry = false) {
    this.lastUpdate = body;
    void retry;
    return await this.w.call("trainee-inbound", { method: "POST", path: `?secret=${encodeURIComponent(SECRETS.inbound)}`, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  // The id a reply to the open card carries: on the web, the card's chat message (agent_messages, meta.card_id); on a
  // texting channel, the provider's id of the message that carried it (career_outbox.provider_id).
  async cardReplyId(cardId: string): Promise<string | null> {
    if (this.channel === "web") {
      const r = await this.w.one(`select coalesce((select m.id::text from public.agent_messages m where m.thread_id = ${this.w.q(this.thread ?? "00000000-0000-0000-0000-000000000000")}::uuid and m.role = 'assistant' and m.meta->>'card_id' = ${this.w.q(cardId)} order by m.id desc limit 1), '')`);
      return r || null;
    }
    if (!this.userId) return null;
    const r = await this.w.one(`select coalesce((select provider_id from public.career_outbox where user_id = '${this.userId}' and card_id::text = ${this.w.q(cardId)} and provider_id is not null order by id desc limit 1), '')`);
    return r || null;
  }
  // The provider message id of the newest message Trainee sent this person that carried a card (career_outbox.card_id).
  async cardMessageId(): Promise<string | null> {
    if (!this.userId) return null;
    const r = await this.w.one(`select coalesce((select provider_id from public.career_outbox where user_id = '${this.userId}' and card_id is not null and provider_id is not null order by id desc limit 1), '')`);
    return r || null;
  }
}
export { SUPABASE_URL };
