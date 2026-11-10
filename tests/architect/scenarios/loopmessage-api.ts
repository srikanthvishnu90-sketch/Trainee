// A fake LoopMessage send API for the channel parity suite (channel-parity-acceptance.test.ts), at the fetch boundary, as
// scenarios/telegram-bot-api.ts fakes Telegram. It answers POST https://a.loopmessage.com/api/v1/message/send/ the way
// _shared/loopmessage.ts expects (the shape the owner's test bridge used live: the raw key in Authorization, body
// { contact, text }, a message_id back), records every call, and refuses (400) and records as a violation what iMessage
// could not carry: another key, an empty text, a text over 5,000 characters, a lone surrogate, a contact that is not a
// phone number in E.164. `fail` answers a call with an error instead (429, 401, 503, a dropped connection: "throw").
// No network: it is a fetch.
import { LONE } from "./telegram-bot-api.ts";

export type LoopMsg = { contact: string; text: string; id: string; at: number };
export function fakeLoop(o: { apiKey: string; now: () => number; fail?: (c: { contact: string; text: string; nth: number }) => Response | "throw" | null }) {
  const calls: { headers: Record<string, string>; body: string }[] = [], msgs: LoopMsg[] = [], violations: string[] = [];
  const nth = new Map<string, number>();
  let mid = 5000;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "a.loopmessage.com" || u.pathname !== "/api/v1/message/send/" || req.method !== "POST") throw new TypeError(`network refused: ${u.host}${u.pathname}`);
    const raw = await req.text();
    calls.push({ headers: Object.fromEntries(req.headers.entries()), body: raw });
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* recorded below */ }
    const contact = String(body.contact ?? ""), text = String(body.text ?? "");
    const bad: string[] = [];
    if (req.headers.get("authorization") !== o.apiKey) bad.push("a call with another API key");
    if (!/^\+\d{8,15}$/.test(contact)) bad.push(`a contact that is not a phone number (${contact.slice(0, 20)})`);
    if (!text.trim()) bad.push("an empty text");
    if (text.length > 5000) bad.push(`a text of ${text.length} characters`);
    if (LONE.test(text)) bad.push("invalid UTF-8 (a lone surrogate)");
    if (bad.length) { violations.push(...bad.map((b) => `${b} | ${raw.slice(0, 160)}`)); return Response.json({ success: false, message: bad[0] }, { status: 400 }); }
    nth.set(contact, (nth.get(contact) ?? -1) + 1);
    const f = o.fail?.({ contact, text, nth: nth.get(contact)! });
    if (f === "throw") throw new TypeError("error sending request: connection refused");
    if (f) return f;
    const id = `lm-${++mid}`;
    msgs.push({ contact, text, id, at: o.now() });
    return Response.json({ success: true, message_id: id, contact, text });
  }) as typeof fetch;
  return { fetch, calls, msgs, violations, to: (contact: string) => msgs.filter((m) => m.contact === contact) };
}
