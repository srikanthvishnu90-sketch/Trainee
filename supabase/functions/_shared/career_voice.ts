// WO-035, switched OFF (owner directive 2026-11-02 18:38 CT: Trainee is Claude-only, no OpenAI calls anywhere, voice stays
// off). There is no voice provider, so the voice mock cannot run: "start" always answers NOT_WIRED (reason: "voice is off:
// no provider"), the link is never used up, and the page offers the text mock. Nothing here mints a client secret, opens a
// realtime session, or contacts any host. What stays: the signed-link checks, the text-mock fallback, the debrief scorer and
// the session store, so the database and the text mock are untouched; nothing can issue a call token, so "finish" is
// unreachable in practice. Logic and tests: tests/architect/wo-035-voice-mock.test.ts.
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
import { type TokenKind, verifyToken, voiceWired } from "./career_voice_link.ts";
export const CALL_GRACE_MIN = 15; // kept for the session row's window (career_voice_start); no call can start
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
  deliver?: (userId: string, key: string) => Promise<void>; // send the debrief now instead of at the next delivery run
  log?: (line: string) => void;
}
export const NOT_WIRED_TEXT = "Voice is not available. Want the text mock instead? Tap below and it starts in your messages.";
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
    // Voice is off for good (no provider): the link is not used up, so the page can still start the text mock with it.
    const wired = voiceWired(d.env);
    d.log?.(`career-voice: NOT_WIRED (${wired.reason})`);
    return json({ status: "NOT_WIRED", message: NOT_WIRED_TEXT, text_mock: true });
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
