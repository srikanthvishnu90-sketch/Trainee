// WO-035: the voice mock's server side, as a function of its inputs so it is testable without a database, OpenAI or a
// browser. The career-voice function (supabase/functions/career-voice) wires it. Three actions, each authorized by a
// signed token (career_voice_link.ts), never by anything else in the request:
//   start     the link's one use: mints a short-lived OpenAI Realtime client secret with the server's OPENAI_API_KEY and
//             returns that secret (never the key) with the call token. Without the key: NOT_WIRED, and the link stays
//             unused so the page can still move to the text mock.
//   finish    the transcript (the Realtime API's text events, never audio) comes in once; it is scored in memory with the
//             text mock's rubric (career_mock.ts voiceDebrief), the debrief is written into the person's thread and
//             queued to their texting thread, and the transcript is dropped. Nothing else is stored.
//   fallback  the text mock in one tap (microphone blocked, WebRTC failed, voice not wired): the same role and company,
//             started as a text mock in the person's thread.
//
// The OpenAI Realtime API, as used here (sources: OpenAI's published OpenAPI spec, github.com/openai/openai-openapi,
// master/openapi.yaml, paths /realtime/client_secrets and /realtime/calls and the Realtime server events; and OpenAI's
// reference app github.com/openai/openai-realtime-console, server.js and client/components/App.jsx; both read 2026-10-20.
// platform.openai.com could not be opened from the build sandbox):
//   - POST https://api.openai.com/v1/realtime/client_secrets, Authorization: Bearer <OPENAI_API_KEY>, JSON body
//     { expires_after: { anchor: "created_at", seconds }, session: { type: "realtime", model, instructions, audio } };
//     the response is { value: "ek_...", expires_at, session }. A secret can open sessions until it expires, so it lives
//     60 seconds (the spec allows 10 to 7200).
//   - The browser POSTs its SDP offer to https://api.openai.com/v1/realtime/calls with Authorization: Bearer <value> and
//     Content-Type: application/sdp, and gets the SDP answer; events flow on the "oai-events" data channel.
//   - audio.input.transcription { model } turns on the transcript of the person's speech
//     (conversation.item.input_audio_transcription.completed); the interviewer's words arrive as
//     response.output_audio_transcript.done. audio.input.turn_detection { type: "semantic_vad" | "server_vad" } decides
//     when the person has finished speaking (input_audio_buffer.speech_stopped); output_audio_buffer.started marks the
//     first audio of the reply (WebRTC only), which the page's latency harness uses.
import {
  companyRecords,
  firms,
  type MockState,
  recordFacts,
  sourceOf,
  start as startMock,
  type Turn,
  validState,
  voiceDebrief,
} from "./career_mock.ts";
import { signToken, type TokenKind, verifyToken, voiceWired } from "./career_voice_link.ts";

import { type BudgetGate, budgetPausedByEnv, budgetReply, type ReserveResult, resolveBudgetGate } from "./model_budget.ts";
// Worst case a minute of a realtime call can cost, in micro-USD, by model. OpenAI publishes tokens, not minutes, so this is an
// ASSUMPTION, not a verified price. Audio token rates for the minute are not published on the pages read on 2026-10-28; this
// assumes 50 audio tokens a second each way (3,000 a minute, five times the 10 a second commonly quoted) and the audio prices read on
// a third-party table for gpt-realtime-mini ($10 in, $20 out per 1M): 3,000 x $10 + 3,000 x $20 = $0.09 a minute, rounded up to $0.10 to cover
// the conversation text being re-read each turn. gpt-realtime was not read at all today: three times the mini figure. Unknown model:
// the dearer figure. The reservation is kept as spent once a key goes out. The owner can change these numbers here.
export const VOICE_WORST_CASE_MICROS_PER_MINUTE_BY_MODEL: Record<string, number> = { "gpt-realtime-mini": 100_000, "gpt-realtime": 300_000 };
export const VOICE_WORST_CASE_MICROS_PER_MINUTE = 300_000; // unknown model
export const VOICE_SESSION_MAX_MINUTES = 30;
export const voiceWorstCaseMicros = (model: string, plannedMinutes: number) =>
  Math.min(VOICE_SESSION_MAX_MINUTES, plannedMinutes + CALL_GRACE_MIN) * (VOICE_WORST_CASE_MICROS_PER_MINUTE_BY_MODEL[model] ?? VOICE_WORST_CASE_MICROS_PER_MINUTE);
export const REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
// The model and voice are the owner's to change (CAREER_VOICE_MODEL). gpt-realtime-mini is in the spec's model list and
// is the cheaper one; gpt-realtime is the one OpenAI's reference app uses.
export const DEFAULT_MODEL = "gpt-realtime-mini";
export const DEFAULT_VOICE = "marin";
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const SECRET_TTL_S = 60;
export const CALL_GRACE_MIN = 15; // the call token outlives the planned minutes by this much, for a late hang-up
export const MAX_TURNS = 300;
export const MAX_TURN_CHARS = 4000;
export const MAX_TRANSCRIPT_CHARS = 80_000;
const MAX_BODY = 400_000;

// ---------- The interviewer ----------
// What the interviewer is told: the same plan of questions as the text mock, in order, a follow-up at most per answer,
// and about the company only the facts on its record (each with the record field it came from) or its sourced patterns.
export function interviewerInstructions(s: MockState, o: { lib?: any[]; firms?: any[]; checks?: unknown } = {}): string {
  const cir = s.record ? companyRecords(o.lib).find((c) => String(c.company_id) === s.record!.id) ?? null : null;
  const firm = !cir && s.patterns ? firms(o.firms).find((f) => f.id === s.patterns!.id) ?? null : null;
  const company = s.company;
  const lines: string[] = [
    "You are the interviewer in a practice job interview for Trainee, spoken out loud. The person is practicing; this is not a real interview.",
    `Role: ${s.role || "general (no role named)"}. Company: ${company || "none named"}. Length: about ${s.minutes} minutes.`,
    `Ask these ${s.questions.length} questions in this order. Before each one, say "Question N." with its number, then ask it as written:`,
    ...s.questions.map((q) => `Question ${q.n}. ${q.q}`),
    "After each answer you may ask one short follow-up about what the person just said, using only their own words. Then go to the next question.",
    "Do not score, praise at length, coach, or give model answers during the call; the written debrief after the call does that.",
    "Never invent facts about the person. Never ask for a password, a one-time code, or an ID number.",
  ];
  if (cir) {
    const facts = recordFacts(cir);
    lines.push(`What you may say about ${company}: only these facts from Trainee's record on file (record ${cir.company_id}, as of ${s.record!.as_of ?? "unknown"}), each with its record field and source. Say nothing else about ${company}: not its interview process, culture, people, numbers or news. If asked about anything not here, say you do not have that on file.`);
    for (const f of facts) lines.push(`- ${f.field}: "${f.text}" (${f.label})`);
    if (!facts.length) lines.push(`- (the record holds nothing about how ${company} interviews; say nothing about it)`);
  } else if (firm) {
    lines.push(`What you may say about ${company}: only these sourced notes (interview-patterns.json, firm ${firm.id}, checked ${firm.checked}). Say nothing else about ${company}. If asked about anything not here, say you do not have that on file.`);
    // WO-041: a note whose page the last source check found gone is left out; one no check has opened is marked so.
    for (const p of firm.patterns || []) {
      const src = sourceOf(p, o.checks);
      if (src.status === "gone") continue;
      const why = src.status === "unverified" ? "page not opened by a source check" : `the page could not be opened at the ${src.checked} source check (${src.status})`;
      lines.push(`- patterns: "${p.text}" (${p.source_type}, ${p.source_url})${src.verified ? "" : ` [unverified: ${why}; do not present it as the firm's words]`}`);
    }
  } else if (company) {
    lines.push(`There is no record of ${company} on file. Say nothing about how ${company} hires or interviews; if asked, say there is no record of it on file.`);
  }
  lines.push(
    "If the person says they are in a real interview right now, say you cannot help during a real interview and end the practice.",
    `When the last question is answered, or at about ${s.minutes} minutes, say: "That's the end of the practice. Hang up, and your debrief will come by text." Then stop.`,
    "Speak in short turns, in a calm, professional voice, in English unless the person speaks another language.",
  );
  return lines.join("\n");
}

export function realtimeSecretRequest(s: MockState, o: { model?: string; voice?: string; lib?: any[]; firms?: any[]; checks?: unknown } = {}) {
  return {
    expires_after: { anchor: "created_at", seconds: SECRET_TTL_S },
    session: {
      type: "realtime",
      model: o.model || DEFAULT_MODEL,
      instructions: interviewerInstructions(s, o),
      audio: {
        input: {
          transcription: { model: TRANSCRIBE_MODEL },
          // Semantic VAD waits through an "uhm" instead of cutting in; the latency harness measures what it costs.
          turn_detection: { type: "semantic_vad", eagerness: "auto" },
        },
        output: { voice: o.voice || DEFAULT_VOICE },
      },
    },
  };
}

export type Mint = (body: unknown) => Promise<{ ok: true; value: string; expires_at: number } | { ok: false; status: number }>;
// The one call that uses the real key. Its answer is read for the client secret only; the key never leaves this call.
export function openaiMint(apiKey: string, f: typeof fetch = fetch): Mint {
  return async (body) => {
    let res: Response;
    try {
      res = await f(REALTIME_CLIENT_SECRETS_URL, {
        method: "POST", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0 };
    }
    if (!res.ok) return { ok: false, status: res.status };
    const j = await res.json().catch(() => null) as { value?: unknown; expires_at?: unknown } | null;
    const value = typeof j?.value === "string" ? j.value : "";
    if (!/^ek_[A-Za-z0-9_-]{4,200}$/.test(value)) return { ok: false, status: 502 };
    return { ok: true, value, expires_at: Number(j?.expires_at) || 0 };
  };
}

// ---------- The session store ----------
export interface VoiceRow { thread: string; state: MockState; link_expires_at: string; started_at?: string; debriefed_at?: string; fallback_at?: string }
export interface VoiceSessions {
  read(userId: string, id: string): Promise<VoiceRow | null>;
  start(userId: string, id: string, now: number, callMinutes: number): Promise<MockState | null>;
  finish(userId: string, id: string, text: string, now: number): Promise<boolean>;
  fallback(userId: string, id: string, state: MockState, text: string, now: number): Promise<boolean>;
}
// deno-lint-ignore no-explicit-any
export function supabaseVoiceSessions(admin: any): VoiceSessions {
  const iso = (t: number) => new Date(t).toISOString();
  const must = (r: { data: unknown; error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  return {
    async read(userId, id) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", `career:voice:${id}`).maybeSingle(), "read the voice session") as { value?: VoiceRow } | null;
      return r?.value && validState(r.value.state) ? r.value : null;
    },
    async start(userId, id, now, callMinutes) {
      const st = must(await admin.rpc("career_voice_start", { p_user: userId, p_id: id, p_now: iso(now), p_call_minutes: callMinutes }), "start the voice session");
      return validState(st) ? st : null;
    },
    async finish(userId, id, text, now) {
      return must(await admin.rpc("career_voice_finish", { p_user: userId, p_id: id, p_text: text, p_now: iso(now) }), "post the voice debrief") === true;
    },
    async fallback(userId, id, state, text, now) {
      return must(await admin.rpc("career_voice_fallback", { p_user: userId, p_id: id, p_state: state, p_text: text, p_now: iso(now) }), "move to the text mock") === true;
    },
  };
}

// ---------- The transcript ----------
// The page sends [{ who, text }] in call order: the person's words from input_audio_transcription.completed, the
// interviewer's from output_audio_transcript.done. Anything else in the body (audio, a recording, a blob) is refused.
export function parseTranscript(raw: unknown): { ok: true; turns: Turn[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "transcript must be a list of turns" };
  if (raw.length > MAX_TURNS) return { ok: false, error: `at most ${MAX_TURNS} turns` };
  const turns: Turn[] = [];
  let total = 0;
  for (const t of raw) {
    if (!t || typeof t !== "object") return { ok: false, error: "each turn is { who, text }" };
    const keys = Object.keys(t);
    if (keys.some((k) => k !== "who" && k !== "text")) return { ok: false, error: "a turn holds only who and text" };
    const who = (t as any).who, text = (t as any).text;
    if (who !== "interviewer" && who !== "candidate") return { ok: false, error: "who is interviewer or candidate" };
    if (typeof text !== "string" || text.length > MAX_TURN_CHARS) return { ok: false, error: `text is a string of at most ${MAX_TURN_CHARS} characters` };
    total += text.length;
    turns.push({ who, text });
  }
  if (total > MAX_TRANSCRIPT_CHARS) return { ok: false, error: `the transcript is over ${MAX_TRANSCRIPT_CHARS} characters` };
  return { ok: true, turns };
}
// The latency harness's samples, summarized for the function log; never stored.
export function latencySummary(raw: unknown): { n: number; median_ms: number | null; p90_ms: number | null } {
  const xs = (Array.isArray(raw) ? raw : []).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x < 60_000).sort((a, b) => a - b).slice(0, 500);
  const at = (q: number) => xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]) : null;
  return { n: xs.length, median_ms: at(0.5), p90_ms: at(0.9) };
}

// ---------- The HTTP side ----------
export interface VoiceDeps {
  env: (k: string) => string | undefined;
  now: () => number;
  cors: Record<string, string>;
  sessions: VoiceSessions;
  mint: (apiKey: string) => Mint;
  // The global daily budget (model_budget.ts). A voice call is paid by the minute in the person's browser, so the whole
  // call's worst case is reserved before the key is minted and is never refunded once a key has gone out.
  budget?: BudgetGate;
  deliver?: (userId: string, key: string) => Promise<void>; // send the debrief now instead of at the next delivery run
  log?: (line: string) => void;
}
export const NOT_WIRED_TEXT = "Voice mocks aren't on yet. Want the text mock instead? Tap below and it starts in your messages.";
const REFUSAL: Record<string, string> = {
  bad_link: "This link isn't valid. Text \"start a voice mock\" for a new one.",
  expired: "This link has expired (links last 10 minutes). Text \"start a voice mock\" for a new one.",
  used: "This link was already used. Each link works once. Text \"start a voice mock\" for a new one.",
  done: "This call's debrief was already sent, or the call has closed.",
};

export async function handleVoice(req: Request, d: VoiceDeps): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...d.cors, "content-type": "application/json", "cache-control": "no-store" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: d.cors });
  if (req.method !== "POST") return json({ status: "REFUSED", reason: "method" }, 405);
  const secret = d.env("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!secret) return json({ status: "NOT_WIRED", message: NOT_WIRED_TEXT, text_mock: false }, 200);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ status: "REFUSED", reason: "too_large" }, 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ status: "REFUSED", reason: "bad_request" }, 400); }
  const action = String(body?.action ?? "");
  const want: TokenKind | "any" = action === "start" ? "start" : action === "finish" ? "call" : "any";
  if (!["start", "finish", "fallback"].includes(action)) return json({ status: "REFUSED", reason: "bad_request" }, 400);
  const now = d.now();
  const v = await verifyToken(body?.token, secret, now, want);
  if (!v.ok) {
    const reason = v.why === "expired" ? "expired" : "bad_link";
    return json({ status: "REFUSED", reason, message: REFUSAL[reason] }, reason === "expired" ? 410 : 401);
  }
  const { s: id, u: userId } = v.claims;

  if (action === "start") {
    // Not wired (no OpenAI key, or the owner has not turned voice on): the link is not used up, so the page can still
    // start the text mock with it.
    const wired = voiceWired(d.env);
    if (!wired.ok) {
      d.log?.(`career-voice: NOT_WIRED (${wired.missing.join(", ")} missing)`);
      return json({ status: "NOT_WIRED", message: NOT_WIRED_TEXT, text_mock: true });
    }
    const key = d.env("OPENAI_API_KEY")!;
    const row = await d.sessions.read(userId, id);
    if (!row) return json({ status: "REFUSED", reason: "bad_link", message: REFUSAL.bad_link }, 401);
    const minutes = Math.max(5, Math.min(30, Number(row.state.minutes) || 20));
    // Reserve first: over the day's budget the key is never minted and the link is not used up.
    const gate = budgetPausedByEnv(d.env) ? null : resolveBudgetGate(d.budget);
    const worst = voiceWorstCaseMicros(d.env("CAREER_VOICE_MODEL") || DEFAULT_MODEL, minutes);
    const got: ReserveResult = budgetPausedByEnv(d.env) ? { ok: false, reason: "paused" } : gate ? await gate.reserve(worst, { model: d.env("CAREER_VOICE_MODEL") || DEFAULT_MODEL, role: "voice" }) : { ok: false, reason: "unavailable" };
    if (!got.ok) {
      d.log?.(`career-voice: budget ${got.reason}; no key minted`);
      return json({ status: "REFUSED", reason: "budget", message: budgetReply(got.reason), text_mock: true }, 429);
    }
    const st = await d.sessions.start(userId, id, now, minutes + CALL_GRACE_MIN);
    if (!st) { await gate!.release(got.id); return json({ status: "REFUSED", reason: "used", message: REFUSAL.used }, 410); }
    const callExp = now + (minutes + CALL_GRACE_MIN) * 60_000;
    const call_token = await signToken({ s: id, u: userId, k: "call", exp: callExp }, secret);
    const model = d.env("CAREER_VOICE_MODEL") || DEFAULT_MODEL;
    const minted = await d.mint(key)(realtimeSecretRequest(st, { model }));
    if (!minted.ok) {
      await gate!.release(got.id); // no key reached the browser: proven no call
      d.log?.(`career-voice: client secret not minted (HTTP ${minted.status})`);
      return json({ status: "UPSTREAM_ERROR", message: "The voice service did not answer. You can switch to the text mock.", call_token, text_mock: true }, 502);
    }
    await gate!.settle(got.id, null); // a key went out: the browser's call cannot be metered here, so the worst case is spent
    return json({
      status: "OK", client_secret: minted.value, expires_at: minted.expires_at, model, calls_url: REALTIME_CALLS_URL,
      call_token, minutes, questions: st.questions.length, what: `${st.role || "general"} mock${st.company ? ` for ${st.company}` : ""}`,
    });
  }

  if (action === "finish") {
    const t = parseTranscript(body?.transcript);
    if (!t.ok) return json({ status: "REFUSED", reason: "bad_transcript", message: t.error }, 400);
    const row = await d.sessions.read(userId, id);
    if (!row || !row.started_at) return json({ status: "REFUSED", reason: "done", message: REFUSAL.done }, 409);
    const t0 = performance.now();
    const r = voiceDebrief({ ...row.state, started_at: Date.parse(row.started_at) || now }, t.turns, now);
    const debrief_ms = Math.round((performance.now() - t0) * 10) / 10;
    const text = r.reply.slice(0, 4000);
    if (!(await d.sessions.finish(userId, id, text, now))) return json({ status: "REFUSED", reason: "done", message: REFUSAL.done }, 409);
    const lat = latencySummary(body?.latency?.silence_to_audio_ms), vad = latencySummary(body?.latency?.vad_to_audio_ms);
    d.log?.(`career-voice: debrief posted in ${debrief_ms} ms; reached ${r.reached} of ${row.state.questions.length}; reply delay after silence n=${lat.n} median=${lat.median_ms} p90=${lat.p90_ms}; after VAD n=${vad.n} median=${vad.median_ms} p90=${vad.p90_ms}`);
    if (d.deliver) {
      try { await d.deliver(userId, `mock:${id}`); } catch (e) { d.log?.(`career-voice: immediate send failed, the delivery run will send it: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return json({ status: "OK", debrief_ms, reached: r.reached, latency: { silence_to_audio: lat, vad_to_audio: vad } });
  }

  // fallback: the same role and company, as a text mock in the person's thread.
  const row = await d.sessions.read(userId, id);
  if (!row) return json({ status: "REFUSED", reason: "bad_link", message: REFUSAL.bad_link }, 401);
  const s = startMock({ role: row.state.role, company: row.state.company, minutes: row.state.minutes, now });
  const text = `Here is the text mock instead.\n\n${s.reply.replace("by text (voice comes later)", "by text")}`;
  if (!(await d.sessions.fallback(userId, id, s.state, text.slice(0, 4000), now))) return json({ status: "REFUSED", reason: "done", message: REFUSAL.done }, 409);
  if (d.deliver) {
    try { await d.deliver(userId, `mock:${id}:text`); } catch (e) { d.log?.(`career-voice: immediate send failed, the delivery run will send it: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return json({ status: "OK", message: "The text mock is in your messages now. Its first question is waiting there." });
}
