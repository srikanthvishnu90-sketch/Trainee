// Instinct harness: every outside system Trainee talks to, faked at its HTTP boundary, each keeping a log of exactly what
// it received (method, path, body, when), so a scenario is judged by what really left the product, how many times.
// Nothing here reaches a real host: tests/instinct/world.ts routes each request by host to one of these, and refuses (and
// records) any host that is not listed.
//
//   telegram   api.telegram.org                     Bot API: sendMessage, getFile, file download, answerCallbackQuery
//   whatsapp   graph.facebook.com, lookaside...     Cloud API: messages, media lookup and download
//   loop       a.loopmessage.com, server.loop...    LoopMessage (iMessage): message send
//   google     accounts/oauth2/www/gmail.google...  OAuth consent and token, userinfo, Gmail send/threads/list, Calendar
//   microsoft  login.microsoftonline.com, graph...  OAuth token, /me, sendMail, messages, getSchedule, events
//   provider   api.hunter.io, api.apollo.io         people/email data provider (domain search, finder, verifier)
//   openai     api.openai.com                       a scripted writer (no model spend): drafts only from the prompt
//
// The employer ATS pages are real HTTP servers on 127.0.0.1 (employers.ts), because a real Chromium loads them.

export interface Hit { method: string; host: string; path: string; query: Record<string, string>; body: any; auth: string | null; at: number }
export interface Fake { name: string; hosts: string[]; log: Hit[]; handle(req: Request, hit: Hit): Promise<Response> }

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const b64urlDecode = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export async function readHit(req: Request): Promise<Hit> {
  const u = new URL(req.url);
  let body: any = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = req.headers.get("content-type") ?? "";
    const raw = await req.clone().text().catch(() => "");
    if (/json/.test(ct) || /^\s*[{[]/.test(raw)) { try { body = JSON.parse(raw); } catch { body = raw; } }
    else if (/x-www-form-urlencoded/.test(ct)) body = Object.fromEntries(new URLSearchParams(raw));
    else body = raw;
  }
  return { method: req.method, host: u.hostname, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: req.headers.get("authorization"), at: Date.now() };
}

// ------------------------------------------------------------------------------------------------ Telegram
export function fakeTelegram(token: string) {
  const files = new Map<string, Uint8Array>();
  let next = 7000;
  const sent: { chat: number; text: string; message_id: number; reply_markup?: unknown }[] = [];
  const fake: Fake & { files: typeof files; sent: typeof sent; textsTo(chat: number, from?: number): string[] } = {
    name: "telegram", hosts: ["api.telegram.org"], log: [], files, sent,
    textsTo: (chat, from = 0) => sent.slice(from).filter((s) => s.chat === chat).map((s) => s.text),
    async handle(req, hit) {
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(decodeURIComponent(hit.path));
      if (req.method === "GET" && file) {
        const b = files.get(file[1]);
        return b ? new Response(b as BodyInit) : new Response("not found", { status: 404 });
      }
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(decodeURIComponent(hit.path));
      if (!m || m[1] !== token) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
      const body = hit.body ?? {};
      if (m[2] === "sendMessage") {
        const id = next++;
        sent.push({ chat: Number(body.chat_id), text: String(body.text ?? ""), message_id: id, reply_markup: body.reply_markup });
        return json({ ok: true, result: { message_id: id, chat: { id: body.chat_id, type: "private" }, date: 1, text: body.text } });
      }
      if (m[2] === "getFile") {
        const path = `documents/${body.file_id}`;
        return files.has(path) ? json({ ok: true, result: { file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_size: files.get(path)!.length, file_path: path } })
          : json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, 400);
      }
      if (["answerCallbackQuery", "sendChatAction", "editMessageReplyMarkup", "editMessageText", "setMyCommands"].includes(m[2])) return json({ ok: true, result: true });
      return json({ ok: false, error_code: 400, description: `unexpected ${m[2]}` }, 400);
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------ WhatsApp Cloud API
export function fakeWhatsApp(phoneNumberId: string) {
  const media = new Map<string, { bytes: Uint8Array; mime: string; name: string }>();
  let next = 1;
  const sent: { to: string; text: string; id: string; type: string; body: any }[] = [];
  const fake: Fake & { media: typeof media; sent: typeof sent; textsTo(to: string, from?: number): string[] } = {
    name: "whatsapp", hosts: ["graph.facebook.com", "lookaside.fbsbx.com"], log: [], media, sent,
    textsTo: (to, from = 0) => sent.slice(from).filter((s) => s.to === to).map((s) => s.text),
    async handle(req, hit) {
      if (hit.host === "lookaside.fbsbx.com") {
        const m = media.get(hit.query.mid ?? "");
        return m ? new Response(m.bytes as BodyInit, { headers: { "content-type": m.mime } }) : new Response("gone", { status: 404 });
      }
      const send = new RegExp(`^/v[0-9.]+/${phoneNumberId}/messages$`).exec(hit.path);
      if (send && req.method === "POST") {
        const b = hit.body ?? {}, id = `wamid.out.${next++}`;
        const to = String(b.to ?? b.recipient ?? "");
        const text = b.type === "text" ? String(b.text?.body ?? "") : b.type === "interactive" ? String(b.interactive?.body?.text ?? "") : b.type === "template" ? `[template ${b.template?.name}]` : "";
        sent.push({ to, text, id, type: String(b.type ?? ""), body: b });
        return json({ messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id }] });
      }
      const mediaId = /^\/v[0-9.]+\/([A-Za-z0-9_-]+)$/.exec(hit.path);
      if (mediaId && req.method === "GET" && media.has(mediaId[1])) {
        const m = media.get(mediaId[1])!;
        return json({ id: mediaId[1], mime_type: m.mime, file_size: m.bytes.length, url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId[1]}` });
      }
      return json({ error: { message: `unexpected ${req.method} ${hit.path}`, code: 100 } }, 400);
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------ LoopMessage (iMessage)
export function fakeLoop() {
  let next = 1;
  const sent: { to: string; text: string; id: string }[] = [];
  const files = new Map<string, { bytes: Uint8Array; mime: string }>();
  const fake: Fake & { sent: typeof sent; files: typeof files; textsTo(to: string, from?: number): string[] } = {
    name: "loopmessage", hosts: ["a.loopmessage.com", "server.loopmessage.com", "storage.loopmessage.com"], log: [], sent, files,
    textsTo: (to, from = 0) => sent.slice(from).filter((s) => s.to === to).map((s) => s.text),
    async handle(req, hit) {
      if (hit.host === "storage.loopmessage.com" && req.method === "GET") {
        const f = files.get(req.url);
        return f ? new Response(f.bytes as BodyInit, { headers: { "content-type": f.mime } }) : new Response("not found", { status: 404 });
      }
      if (req.method === "POST" && /\/message\/send\/?$/.test(hit.path)) {
        const b = hit.body ?? {}, id = `lm-${next++}`;
        sent.push({ to: String(b.contact ?? b.recipient ?? ""), text: String(b.text ?? ""), id });
        return json({ message_id: id, success: true, recipient: b.contact ?? b.recipient, text: b.text });
      }
      return json({ success: false, message: `unexpected ${hit.path}` }, 400);
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------ Google (OAuth, Gmail, Calendar)
// One Google account per connected person: the consent screen is answered by the harness (consent()), which returns the
// callback URL the browser would be sent to. Gmail's send log is what each account sent; threads hold the replies a
// scenario scripts for each sent message. Calendar's busy times are scripted per account; events.insert is logged.
export interface MailSent { account: string; to: string; subject: string; text: string; id: string; threadId: string; at: number; raw: string }
export interface Reply { from: string; subject: string; snippet: string; body?: string; at: number }
export function fakeGoogle() {
  const codes = new Map<string, { account: string; scopes: string }>();
  const tokens = new Map<string, { account: string; scopes: string }>();
  const refresh = new Map<string, { account: string; scopes: string }>();
  const sent: MailSent[] = [];
  const threads = new Map<string, { account: string; messages: Reply[] }>();
  const busy = new Map<string, { start: string; end: string }[]>();
  const events: { account: string; body: any; id: string }[] = [];
  const sendLimit = new Map<string, number>(); // account -> how many sends Gmail accepts before answering 429
  const inbox = new Map<string, Reply[]>();
  let n = 1;
  const who = (auth: string | null) => tokens.get(String(auth ?? "").replace(/^Bearer\s+/i, "")) ?? null;
  const fake: Fake & {
    sent: MailSent[]; events: typeof events; threads: typeof threads; busy: typeof busy; sendLimit: typeof sendLimit; inbox: typeof inbox;
    consent(authUrl: string, account: string): string; reply(threadId: string, r: Reply): void; tokenFor(account: string): string | null;
  } = {
    name: "google", hosts: ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "gmail.googleapis.com", "openidconnect.googleapis.com"],
    log: [], sent, events, threads, busy, sendLimit, inbox,
    // The person signs in as `account` and allows what the app asked for: the browser lands on redirect_uri with a code.
    consent(authUrl, account) {
      const u = new URL(authUrl);
      const code = `gcode-${n++}`;
      codes.set(code, { account, scopes: u.searchParams.get("scope") ?? "" });
      const back = new URL(u.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      return back.toString();
    },
    reply(threadId, r) { threads.get(threadId)?.messages.push(r); },
    tokenFor(account) { for (const [t, v] of tokens) if (v.account === account) return t; return null; },
    async handle(req, hit) {
      if (hit.host === "oauth2.googleapis.com" && hit.path === "/token") {
        const b = hit.body ?? {};
        if (b.grant_type === "authorization_code") {
          const c = codes.get(b.code);
          if (!c) return json({ error: "invalid_grant" }, 400);
          codes.delete(b.code);
          const at = `gat-${n++}`, rt = `grt-${n++}`;
          tokens.set(at, c); refresh.set(rt, c);
          return json({ access_token: at, refresh_token: rt, expires_in: 3599, scope: c.scopes, token_type: "Bearer" });
        }
        if (b.grant_type === "refresh_token") {
          const c = refresh.get(b.refresh_token);
          if (!c) return json({ error: "invalid_grant" }, 400);
          const at = `gat-${n++}`;
          tokens.set(at, c);
          return json({ access_token: at, expires_in: 3599, scope: c.scopes, token_type: "Bearer" });
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      const me = who(hit.auth);
      if (hit.path === "/oauth2/v2/userinfo" || hit.path === "/v1/userinfo" || hit.path === "/oauth2/v3/userinfo") {
        return me ? json({ email: me.account, verified_email: true, id: me.account }) : json({ error: "invalid_token" }, 401);
      }
      if (!me) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
      if (hit.host === "gmail.googleapis.com") {
        if (/\/messages\/send$/.test(hit.path) && req.method === "POST") {
          const limit = sendLimit.get(me.account);
          const mine = sent.filter((s) => s.account === me.account).length;
          if (limit !== undefined && mine >= limit) return json({ error: { code: 429, message: "User-rate limit exceeded", errors: [{ reason: "userRateLimitExceeded" }] } }, 429, { "retry-after": "60" });
          if (!/gmail\.send|mail\.google\.com/.test(me.scopes)) return json({ error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } }, 403);
          const raw = b64urlDecode(String(hit.body?.raw ?? ""));
          const [head, ...rest] = raw.split(/\r?\n\r?\n/);
          const h = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, "im").exec(head)?.[1] ?? "").trim();
          let text = rest.join("\n\n");
          if (/base64/i.test(raw) && /multipart/i.test(head)) {
            const part = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw);
            if (part) text = new TextDecoder().decode(Uint8Array.from(atob(part[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
          }
          const id = `gm-${n++}`, threadId = String(hit.body?.threadId ?? `gt-${n++}`);
          sent.push({ account: me.account, to: h("To"), subject: h("Subject"), text: text.replace(/\r\n/g, "\n"), id, threadId, at: Date.now(), raw });
          if (!threads.has(threadId)) threads.set(threadId, { account: me.account, messages: [] });
          return json({ id, threadId, labelIds: ["SENT"] });
        }
        const th = /\/threads\/([^/]+)$/.exec(hit.path);
        if (th && req.method === "GET") {
          const t = threads.get(th[1]);
          if (!t || t.account !== me.account) return json({ error: { code: 404, message: "Not Found" } }, 404);
          const mine = sent.filter((s) => s.threadId === th[1]);
          const msgs = [
            ...mine.map((s) => ({ id: s.id, threadId: th[1], labelIds: ["SENT"], snippet: s.text.slice(0, 120), internalDate: String(s.at),
              payload: { headers: [{ name: "From", value: s.account }, { name: "To", value: s.to }, { name: "Subject", value: s.subject }, { name: "Date", value: new Date(s.at).toUTCString() }] } })),
            ...t.messages.map((r, i) => ({ id: `${th[1]}-r${i}`, threadId: th[1], labelIds: ["INBOX"], snippet: r.snippet, internalDate: String(r.at),
              payload: { headers: [{ name: "From", value: r.from }, { name: "To", value: t.account }, { name: "Subject", value: r.subject }, { name: "Date", value: new Date(r.at).toUTCString() }],
                ...(r.body ? { body: { data: btoa(r.body).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") } } : {}) } })),
          ];
          return json({ id: th[1], messages: msgs });
        }
        if (/\/messages$/.test(hit.path) && req.method === "GET") {
          const box = inbox.get(me.account) ?? [];
          return json({ messages: box.map((_, i) => ({ id: `in-${me.account}-${i}`, threadId: `in-${i}` })), resultSizeEstimate: box.length });
        }
        const one = /\/messages\/in-(.+)-(\d+)$/.exec(hit.path);
        if (one && req.method === "GET") {
          const r = (inbox.get(me.account) ?? [])[Number(one[2])];
          if (!r) return json({ error: { code: 404 } }, 404);
          return json({ id: `in-${one[1]}-${one[2]}`, internalDate: String(r.at), snippet: r.snippet, payload: { headers: [{ name: "From", value: r.from }, { name: "Subject", value: r.subject }, { name: "Date", value: new Date(r.at).toUTCString() }] } });
        }
        return json({ error: { code: 400, message: `unexpected ${req.method} ${hit.path}` } }, 400);
      }
      if (hit.host === "www.googleapis.com" && /\/calendar\/v3\/freeBusy$/.test(hit.path)) {
        return json({ kind: "calendar#freeBusy", timeMin: hit.body?.timeMin, timeMax: hit.body?.timeMax, calendars: { primary: { busy: busy.get(me.account) ?? [] } } });
      }
      if (hit.host === "www.googleapis.com" && /\/calendar\/v3\/calendars\/[^/]+\/events$/.test(hit.path) && req.method === "POST") {
        const id = `ev-${n++}`;
        events.push({ account: me.account, body: hit.body, id });
        return json({ id, status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=${id}`, ...hit.body });
      }
      return json({ error: { code: 400, message: `unexpected ${req.method} ${hit.host}${hit.path}` } }, 400);
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------ Microsoft (Outlook)
export function fakeMicrosoft() {
  const codes = new Map<string, string>(), tokens = new Map<string, string>(), refresh = new Map<string, string>();
  const sent: { account: string; to: string[]; subject: string; text: string; at: number }[] = [];
  const events: { account: string; body: any }[] = [];
  const busy = new Map<string, { start: string; end: string }[]>();
  let n = 1;
  const who = (auth: string | null) => tokens.get(String(auth ?? "").replace(/^Bearer\s+/i, "")) ?? null;
  const fake: Fake & { sent: typeof sent; events: typeof events; busy: typeof busy; consent(authUrl: string, account: string): string } = {
    name: "microsoft", hosts: ["login.microsoftonline.com", "graph.microsoft.com"], log: [], sent, events, busy,
    consent(authUrl, account) {
      const u = new URL(authUrl), code = `mcode-${n++}`;
      codes.set(code, account);
      const back = new URL(u.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      return back.toString();
    },
    async handle(req, hit) {
      if (hit.host === "login.microsoftonline.com" && /\/oauth2\/v2\.0\/token$/.test(hit.path)) {
        const b = hit.body ?? {};
        const account = b.grant_type === "authorization_code" ? codes.get(b.code) : refresh.get(b.refresh_token);
        if (!account) return json({ error: "invalid_grant" }, 400);
        const at = `mat-${n++}`, rt = `mrt-${n++}`;
        tokens.set(at, account); refresh.set(rt, account);
        return json({ access_token: at, refresh_token: rt, expires_in: 3599, scope: "Mail.Send Mail.Read Calendars.ReadWrite offline_access User.Read", token_type: "Bearer" });
      }
      const me = who(hit.auth);
      if (!me) return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
      if (hit.path === "/v1.0/me") return json({ mail: me, userPrincipalName: me, displayName: me });
      if (hit.path === "/v1.0/me/sendMail" && req.method === "POST") {
        const m = hit.body?.message ?? {};
        sent.push({ account: me, to: (m.toRecipients ?? []).map((r: any) => r?.emailAddress?.address), subject: String(m.subject ?? ""), text: String(m.body?.content ?? ""), at: Date.now() });
        return new Response(null, { status: 202 });
      }
      if (hit.path === "/v1.0/me/calendar/getSchedule" && req.method === "POST") {
        return json({ value: [{ scheduleId: me, scheduleItems: (busy.get(me) ?? []).map((b) => ({ status: "busy", start: { dateTime: b.start, timeZone: "UTC" }, end: { dateTime: b.end, timeZone: "UTC" } })) }] });
      }
      if (/^\/v1\.0\/me\/(calendar\/)?events$/.test(hit.path) && req.method === "POST") {
        events.push({ account: me, body: hit.body });
        return json({ id: `mev-${n++}`, ...hit.body }, 201);
      }
      if (/^\/v1\.0\/me\/(mailFolders\/[^/]+\/)?messages/.test(hit.path)) return json({ value: [] });
      return json({ error: { code: "BadRequest", message: `unexpected ${req.method} ${hit.path}` } }, 400);
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------ people/email provider
// A directory per company domain: the people Hunter (or Apollo) would return, each with its own verification and
// confidence. Some are deliberately unverified or low-confidence: those must never be drafted to or sent.
export interface ProviderPerson { first: string; last: string; email: string; position: string; domain: string; company: string; verified: boolean; confidence: number }
export function fakeProvider(key: string) {
  const directory = new Map<string, ProviderPerson[]>();
  const fake: Fake & { directory: typeof directory } = {
    name: "provider", hosts: ["api.hunter.io", "api.apollo.io"], log: [], directory,
    async handle(req, hit) {
      const supplied = hit.query.api_key ?? req.headers.get("x-api-key") ?? hit.body?.api_key ?? String(hit.auth ?? "").replace(/^Bearer\s+/i, "");
      if (supplied !== key) return json({ errors: [{ id: "authentication_failed", code: 401, details: "No valid API key provided." }] }, 401);
      if (hit.host === "api.hunter.io" && hit.path === "/v2/domain-search") {
        const people = directory.get(String(hit.query.domain ?? "").toLowerCase()) ?? [];
        return json({ data: { domain: hit.query.domain, organization: people[0]?.company ?? null, emails: people.map((p) => ({
          value: p.email, type: "personal", confidence: p.confidence, first_name: p.first, last_name: p.last, position: p.position,
          verification: { status: p.verified ? "valid" : "unknown", date: "2026-10-20" }, sources: [{ domain: p.domain, uri: `https://${p.domain}/team` }] })) }, meta: { results: people.length } });
      }
      if (hit.host === "api.hunter.io" && hit.path === "/v2/email-verifier") {
        const all = [...directory.values()].flat(), p = all.find((x) => x.email === hit.query.email);
        return json({ data: { email: hit.query.email, status: p?.verified ? "valid" : "unknown", result: p?.verified ? "deliverable" : "risky", score: p?.confidence ?? 0 } });
      }
      if (hit.host === "api.apollo.io") {
        const domains: string[] = hit.body?.q_organization_domains_list ?? String(hit.body?.q_organization_domains ?? "").split(/\s+/).filter(Boolean);
        const people = domains.flatMap((d) => directory.get(d.toLowerCase()) ?? []);
        return json({ people: people.map((p) => ({ first_name: p.first, last_name: p.last, title: p.position, email: p.email, email_status: p.verified ? "verified" : "guessed", organization: { name: p.company, primary_domain: p.domain } })), pagination: { total_entries: people.length } });
      }
      return json({ errors: [{ details: `unexpected ${hit.path}` }] }, 404);
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------ the scripted writer
// No model spend: a short email written ONLY from lines the prompt itself carries (the recipient's name and firm, the ask).
// `invent` makes it add a claim that is on nobody's record, so the product's fact-lock must refuse that draft.
export function fakeOpenAI(o: { invent?: (prompt: string) => boolean } = {}) {
  const fake: Fake & { calls: number } = {
    name: "openai", hosts: ["api.openai.com"], log: [], calls: 0,
    async handle(_req, hit) {
      fake.calls++;
      const b = hit.body ?? {};
      const msgs: any[] = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : [];
      const prompt = msgs.map((m) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join(" ") : "").join("\n");
      // Only the recipient's first name and the ask: nothing a fact-lock has to trace.
      const first = /- name: ([A-Za-z'-]+)/.exec(prompt)?.[1] ?? "there";
      const extra = o.invent?.(prompt) ? " I led the infrastructure team at Google for three years." : "";
      const text = `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to hear how you got started.${extra} Would you be open to a short call?`;
      const usage = { prompt_tokens: 300, completion_tokens: 60, input_tokens: 300, output_tokens: 60 };
      if (hit.path === "/v1/responses") return json({ id: "resp-instinct", model: b.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], output_text: text, usage });
      return json({ id: "chatcmpl-instinct", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
    },
  };
  return fake;
}
