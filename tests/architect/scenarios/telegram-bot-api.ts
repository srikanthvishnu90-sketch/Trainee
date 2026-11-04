// A fake Telegram Bot API for the Telegram scenarios (scenarios-telegram.test.ts, flow-scenarios-telegram.test.ts): it answers
// sendMessage, sendPhoto, editMessageText / editMessageCaption, sendDocument, answerCallbackQuery and sendChatAction as Telegram
// does, records every call, and refuses (400, as Telegram refuses) and records as a violation what Telegram would refuse:
// a private chat's id is positive (a group's or a channel's is not, and nothing of a person's goes there); a text is 1-4,096
// characters, a caption at most 1,024; every string valid UTF-8 (a lone surrogate is refused); callback_data 1-64 bytes;
// parse_mode HTML only with b/strong/i/em/u/ins/s/strike/del/code/pre/a/tg-spoiler/span/blockquote, properly nested, every
// other < > & escaped; and, after a 429, no call to that chat before its retry_after ends. No network: it is a fetch.
export const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "tg-spoiler", "span", "blockquote"]);
export function htmlProblem(s: string): string | null {
  const stack: string[] = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "<") {
      const m = /^<(\/?)([a-zA-Z-]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/.exec(s.slice(i));
      if (!m) return `an unescaped "<" at ${i}`;
      const tag = m[2].toLowerCase();
      if (!TAGS.has(tag)) return `an unsupported tag <${tag}>`;
      if (m[1]) { if (stack.pop() !== tag) return `</${tag}> closes nothing open`; }
      else { if (stack.includes("code") || stack.includes("pre")) { if (!(tag === "code" && stack.at(-1) === "pre")) return `<${tag}> inside code`; } stack.push(tag); }
      i += m[0].length; continue;
    }
    if (c === "&") { const m = /^&(lt|gt|amp|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/.exec(s.slice(i)); if (!m) return `an unescaped "&" at ${i}`; i += m[0].length; continue; }
    if (c === ">") return `an unescaped ">" at ${i}`;
    i++;
  }
  return stack.length ? `<${stack.at(-1)}> never closed` : null;
}
export const decode = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
export const bytes = (s: string) => new TextEncoder().encode(s).length;
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}
// deno-lint-ignore no-explicit-any
export type Msg = { chat: string; method: string; text: string; html: boolean; buttons: any[]; photo: string | null; replyMarkup: any; at: number; id: number };
// deno-lint-ignore no-explicit-any
export type BotCall = { method: string; body: any; at: number };
export const plainOf = (m: Msg) => (m.html ? decode(m.text) : m.text);
// deno-lint-ignore no-explicit-any
export function fakeBot(o: { token: string; now: () => number; fail?: (c: { method: string; body: any; nth: number }) => Response | null; throwFirst?: boolean }) {
  const calls: BotCall[] = [], msgs: Msg[] = [], violations: string[] = [], answers: { id: string; text: string }[] = [];
  const retryUntil = new Map<string, number>(), nth = new Map<string, number>();
  let mid = 1000, thrown = false;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = String(req ? req.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    if (!m) throw new TypeError(`network refused: ${url.split(o.token).join("<token>")}`);
    if (o.throwFirst && !thrown && m[2] === "sendMessage") { thrown = true; throw new TypeError(`error sending request for url (${url}): connection reset`); }
    const method = m[2];
    const raw = init?.body ?? (req ? (/multipart/.test(req.headers.get("content-type") ?? "") ? await req.formData() : await req.text()) : null);
    const body = raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(String(raw ?? "{}") || "{}");
    const chat = body.chat_id !== undefined ? String(body.chat_id) : null;
    calls.push({ method, body, at: o.now() });
    const bad: string[] = [];
    if (m[1] !== o.token) bad.push("a call with another bot's token");
    if (chat !== null && !(Number(chat) > 0)) bad.push(`a message to a group or channel (${chat})`);
    if (chat !== null && retryUntil.has(chat) && o.now() < retryUntil.get(chat)!) bad.push(`retry_after not honoured: a ${method} to ${chat} ${retryUntil.get(chat)! - o.now()} ms early`);
    for (const s of strings(body)) if (LONE.test(s)) { bad.push(`invalid UTF-8 (a lone surrogate) in a ${method}`); break; }
    if (method === "sendMessage" || method === "editMessageText") {
      const t = String(body.text ?? "");
      if (!t.trim()) bad.push("an empty text");
      if (t.length > 4096) bad.push(`a text of ${t.length} characters`);
    }
    if (method === "sendPhoto" || method === "editMessageCaption") { if (String(body.caption ?? "").length > 1024) bad.push(`a caption of ${String(body.caption).length} characters`); }
    if (body.parse_mode === "HTML") { const p = htmlProblem(String(body.text ?? body.caption ?? "")); if (p) bad.push(`broken HTML: ${p}`); }
    for (const b of (body.reply_markup?.inline_keyboard ?? []).flat()) {
      if (!String(b.text ?? "").trim()) bad.push("a button with no label");
      if (b.callback_data !== undefined && (bytes(b.callback_data) > 64 || !b.callback_data)) bad.push(`callback_data of ${bytes(b.callback_data)} bytes`);
    }
    if (bad.length) {
      violations.push(...bad.map((b) => `${b} | ${JSON.stringify(body).slice(0, 160)}`));
      return Response.json({ ok: false, error_code: 400, description: /HTML/.test(bad[0]) ? "Bad Request: can't parse entities" : `Bad Request: ${bad[0]}` }, { status: 400 });
    }
    if (chat) nth.set(`${chat}|${method}`, (nth.get(`${chat}|${method}`) ?? -1) + 1);
    const f = o.fail?.({ method, body, nth: chat ? nth.get(`${chat}|${method}`)! : 0 });
    if (f) {
      if (f.status === 429 && chat) { const j = await f.clone().json(); retryUntil.set(chat, o.now() + Number(j?.parameters?.retry_after ?? 0) * 1000); }
      return f;
    }
    if (method === "answerCallbackQuery") { answers.push({ id: String(body.callback_query_id), text: String(body.text ?? "") }); return Response.json({ ok: true, result: true }); }
    if (method === "sendChatAction") return Response.json({ ok: true, result: true });
    if (/^(sendMessage|sendPhoto|editMessageText|editMessageCaption|sendDocument)$/.test(method)) {
      const id = /^edit/.test(method) ? Number(body.message_id) : ++mid;
      msgs.push({ chat: String(chat), method, text: String(body.text ?? body.caption ?? ""), html: body.parse_mode === "HTML", buttons: (body.reply_markup?.inline_keyboard ?? []).flat(),
        photo: method === "sendPhoto" ? String(body.photo) : null, replyMarkup: body.reply_markup ?? null, at: o.now(), id });
      return Response.json({ ok: true, result: { message_id: id, chat: { id: Number(body.chat_id), type: "private" }, date: 1 } });
    }
    return Response.json({ ok: false, error_code: 400, description: `Bad Request: method ${method} not expected` }, { status: 400 });
  }) as typeof fetch;
  return { fetch, calls, msgs, violations, answers, to: (chat: number | string) => msgs.filter((x) => x.chat === String(chat)) };
}
