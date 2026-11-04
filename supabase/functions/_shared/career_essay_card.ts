// WO-049: a written answer drafted ON THE EXTENSION'S CARD, from the person's confirmed facts, on their tap. The card
// sends the question as the employer's form asks it; this function (career-essay-draft) answers with WO-030's draft:
//   1. The employer's own AI policy decides first (essay_draft.ts employerGate over the question and the form's other
//      labels): a form that asks for answers written without AI is never drafted for, and the model is never called.
//   2. The facts are the person's own, read here on the server from their account (never sent by the extension: a fact
//      in the request is ignored). Only confirmed ones are used; fewer than 2 that fit: no draft, and the card says what
//      would help (whatWouldHelp).
//   3. Every checkable item in the draft traces to a confirmed fact or the posting (factLock); a draft that does not is
//      written again once and then not shown. The form's limit is met by writing again, never by cutting.
//   4. The model is OpenAI only, through the gateway's callModel (essayModelConfig ignores MODEL_PROVIDER).
//   5. At most 60 drafts a person in 24 hours, counted here (one per draft that reached the model, however many tries),
//      and said plainly when reached.
// The draft is returned whole for the person to read and edit; nothing is saved or filled here. Only the card's "Use this"
// puts it on the form, and only the person's approval of the exact payload sends it.
import { type DraftOutcome, draftEssay, type EssayQuestion, factText, MIN_FACTS, type ModelFn, whatWouldHelp } from "./essay_draft.ts";
import { mapQuestion } from "./question_map.ts";
import { type ModelConfig, modelConfig } from "./model_gateway.ts";

export const DAILY_DRAFTS = 60;
export const DAY_MS = 24 * 3600_000;
export const TEXT_MAX = 2000;

// ---------------------------------------------------------------------------------------------------------------------
// The request, as the card sends it. Only these keys are read; anything else (a "facts" list above all) is ignored.
export interface EssayRequest {
  posting: string; company: string; label: string; type: string; siblings: string[];
  limit: { chars: number | null; words: number | null }; previous: string | null;
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const count = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? v as number : null);
export function readRequest(body: unknown): { ok: true; req: EssayRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "The request is not a question." };
  const b = body as Record<string, unknown>;
  const posting = str(b.posting, 300), label = str(b.label, 600), company = str(b.company, 200), type = str(b.type, 40) || "textarea";
  if (!posting) return { ok: false, message: "The request names no posting." };
  if (!label) return { ok: false, message: "The request names no question." };
  if (mapQuestion({ label, type }).kind !== "essay") return { ok: false, message: "That question is not a written answer, so there is nothing to draft." };
  const siblings = (Array.isArray(b.siblings) ? b.siblings : []).slice(0, 200).map((s) => str(s, 1200)).filter((s) => s && s !== label);
  const lim = b.limit && typeof b.limit === "object" ? b.limit as Record<string, unknown> : {};
  const previous = str(b.previous, TEXT_MAX) || null;
  return { ok: true, req: { posting, company, label, type, siblings, limit: { chars: count(lim.chars, 20, 100_000), words: count(lim.words, 5, 5000) }, previous } };
}
// The field's own limit, in the words essay_draft.ts lengthLimit reads ("max 500 characters", "in 150 words or less").
export const limitText = (l: EssayRequest["limit"]) =>
  [l.chars !== null ? `max ${Math.min(l.chars, TEXT_MAX)} characters` : "", l.words !== null ? `in ${l.words} words or less` : ""].filter(Boolean).join(" ");

// ---------------------------------------------------------------------------------------------------------------------
// What the card shows: the draft and which facts it used (by label, never the whole fact), or one line saying why not.
export type Why = "policy" | "thin" | "unverified" | "too_long" | "model" | "cap" | "invalid";
export type CardReply =
  | { ok: true; text: string; facts: { id: string; label: string }[]; fact_ids: string[]; message: string; used: number; cap: number }
  | { ok: false; why: Why; message: string; used: number | null; cap: number };

const idOf = (f: any) => String(f?.id || f?.fact_id || "");
export function factLabel(f: any): string {
  const own = [f?.label, f?.title].find((x) => typeof x === "string" && x.trim());
  if (own) return String(own).replace(/\s+/g, " ").trim().slice(0, 80);
  const text = String(f?.text ?? factText(f)).replace(/\s+/g, " ").trim();
  const cut = text.length > 48 ? `${text.slice(0, 48).replace(/\s+\S*$/, "")}...` : text;
  return `${f?.kind ? `${f.kind}: ` : ""}${cut}`;
}
const quote = (s: string | null) => (s ? ` ("${s.length > 90 ? `${s.slice(0, 87)}...` : s}")` : "");
const firm = (company: string) => company || "This employer";
export function cardMessage(req: EssayRequest, d: DraftOutcome | { ok: false; why: "cap" }, cap = DAILY_DRAFTS): string {
  if (d.ok) {
    const policy = d.policy.policy === "allowed"
      ? `${firm(req.company)}'s form allows AI help${quote(d.policy.said)}.`
      : `${firm(req.company)}'s form doesn't say whether AI help is allowed, so this is a draft for you to edit.`;
    return `Drafted by Trainee only from your confirmed facts. ${policy} It goes on the form only if you tap Use this.`;
  }
  switch (d.why) {
    case "cap":
      return `You've had ${cap} drafts in the last 24 hours, Trainee's daily limit, so nothing was drafted. Answer this one in your own words, or try again tomorrow.`;
    case "policy":
      if (d.policy?.policy === "prohibited") return `${firm(req.company)} asks for answers written without AI${quote(d.policy.said)}, so Trainee won't draft this one: it needs your own words.`;
      if (d.policy?.policy === "unread") return `${firm(req.company)}'s form names its own AI policy${quote(d.policy.said)} without saying what it allows, so Trainee won't draft this one: it needs your own words.`;
      return `${d.detail[0] ?? "This application doesn't allow AI-written answers."} It needs your own words.`;
    case "thin":
      return `Only ${d.detail[0]} of your confirmed facts fit this question and Trainee needs ${MIN_FACTS}, so nothing was drafted. Tell Trainee ${whatWouldHelp(req.label, req.company || null)}, confirm it, then tap Draft again.`;
    case "unverified":
      return `No draft shown: it kept naming things you haven't confirmed (${d.detail.slice(0, 6).join("; ")}). The question is still yours to answer.`;
    case "too_long":
      return `No draft shown: it couldn't fit the form's limit (${d.detail[0]}) without cutting a sentence off. The question is still yours to answer.`;
    default:
      return "Trainee couldn't draft this right now, so nothing changed and the question is still open. Try again in a few minutes.";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The counter: one row per draft that reached the model, on the person's own timeline (career_events, kind note, source
// essay_card). Reserved before the first model call and counted after it, so two taps at once can never pass the cap.
export interface DraftCounter {
  used(userId: string, sinceIso: string): Promise<number>;
  reserve(userId: string, atIso: string, what: { posting: string; company: string; label: string }): Promise<string>;
  release(id: string): Promise<void>;
}
export interface EssayCardDeps {
  facts(userId: string): Promise<unknown[]>; // the person's facts, read on the server
  model: ModelFn; // OpenAI, through the gateway (a stub in tests)
  counter: DraftCounter;
  now(): number;
  cap?: number;
}
class CapReached extends Error {}

export async function essayCardDraft(userId: string, body: unknown, deps: EssayCardDeps): Promise<CardReply> {
  const cap = deps.cap ?? DAILY_DRAFTS;
  const r = readRequest(body);
  if (!r.ok) return { ok: false, why: "invalid", message: r.message, used: null, cap };
  const req = r.req;
  const since = () => new Date(deps.now() - DAY_MS).toISOString();
  let used: number;
  try { used = await deps.counter.used(userId, since()); }
  catch { return { ok: false, why: "model", message: cardMessage(req, { ok: false, why: "model", policy: null, detail: [], tries: 0 }), used: null, cap }; }
  if (used >= cap) return { ok: false, why: "cap", message: cardMessage(req, { ok: false, why: "cap" }, cap), used, cap };
  // The facts are read here, once, from the person's account; the request's own keys never reach them.
  let loaded: unknown[] = [];
  const facts = async () => (loaded = await deps.facts(userId));
  // One reservation per draft, taken at its first model call (a policy refusal or thin facts cost nothing).
  let reserved: string | null = null, capHit = false;
  const model: ModelFn = async (payload) => {
    if (!reserved) {
      reserved = await deps.counter.reserve(userId, new Date(deps.now()).toISOString(), { posting: req.posting, company: req.company, label: req.label });
      used = await deps.counter.used(userId, since());
      if (used > cap) {
        await deps.counter.release(reserved).catch(() => {});
        capHit = true;
        throw new CapReached("the daily draft limit was reached");
      }
    }
    return await deps.model(payload);
  };
  const q: EssayQuestion = { id: "card", label: req.label, type: req.type, kind: "essay", company: req.company || null, job_ids: [req.posting], ai_policy: null };
  const out = await draftEssay({ q, siblingLabels: req.siblings, deps: { model, facts }, previous: req.previous, limitText: limitText(req.limit) })
    .catch((e): DraftOutcome => ({ ok: false, why: "model", policy: null, detail: [String(e?.message ?? e)], tries: 0 }));
  if (capHit) return { ok: false, why: "cap", message: cardMessage(req, { ok: false, why: "cap" }, cap), used: cap, cap };
  if (!out.ok) return { ok: false, why: out.why, message: cardMessage(req, out, cap), used, cap };
  const byId = new Map((Array.isArray(loaded) ? loaded : []).map((f: any) => [idOf(f), f]));
  const used_ = out.factIds.filter((id) => byId.has(id));
  return { ok: true, text: out.text, facts: used_.map((id) => ({ id, label: factLabel(byId.get(id)) })), fact_ids: used_, message: cardMessage(req, out, cap), used, cap };
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI only (owner rule): the gateway's config with MODEL_PROVIDER pinned, whatever the environment says. The model is
// CAREER_MODEL when set (as the chat's drafts), else the gateway's own default.
type Env = { get(name: string): string | undefined };
export function essayModelConfig(env: Env): ModelConfig {
  const pinned: Env = { get: (k) => (k === "MODEL_PROVIDER" ? "openai" : env.get(k)) };
  const cfg = modelConfig(pinned, "chat");
  return { ...cfg, model: env.get("CAREER_MODEL") || cfg.model };
}

// ---------------------------------------------------------------------------------------------------------------------
// The person's facts, from every one of their career threads (agent_flow_state.state.career.stores.profile.facts), newest
// thread first; one fact per id. Only the service client reads them, scoped to the signed-in person.
export function supabaseFacts(admin: any) {
  return async (userId: string): Promise<unknown[]> => {
    const r = await admin.from("agent_flow_state").select("facts:state->career->stores->profile->facts,updated_at").eq("user_id", userId)
      .order("updated_at", { ascending: false }).limit(50);
    if (r.error) throw new Error(`read your facts: ${r.error.message}`);
    const out: unknown[] = [], seen = new Set<string>();
    for (const row of r.data ?? []) {
      for (const f of Array.isArray(row?.facts) ? row.facts : []) {
        if (!f || typeof f !== "object") continue;
        const id = idOf(f) || JSON.stringify(f);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(f);
      }
    }
    return out;
  };
}
export const COUNTER_SOURCE = "essay_card";
export function supabaseDraftCounter(admin: any): DraftCounter {
  return {
    async used(userId, sinceIso) {
      const r = await admin.from("career_events").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "note")
        .eq("source", COUNTER_SOURCE).gte("at", sinceIso);
      if (r.error) throw new Error(`count drafts: ${r.error.message}`);
      return Number(r.count ?? 0);
    },
    async reserve(userId, atIso, what) {
      const r = await admin.from("career_events").insert({
        user_id: userId, at: atIso, kind: "note", source: COUNTER_SOURCE, subject: what.company.slice(0, 200),
        detail: { what: "a written answer drafted on the card from confirmed facts", posting: what.posting.slice(0, 300), question: what.label.slice(0, 300) },
      }).select("id").single();
      if (r.error) throw new Error(`count this draft: ${r.error.message}`);
      return String(r.data.id);
    },
    async release(id) {
      await admin.from("career_events").delete().eq("id", Number(id)).eq("source", COUNTER_SOURCE);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The HTTP edge: the signed-in person only (their own session token, checked with Supabase Auth; a service key is
// refused), POST only. Every answer is JSON; a refusal is a 200 with ok:false and the one line the card shows.
export interface HandlerDeps {
  cors: Record<string, string>;
  user(token: string): Promise<{ id: string } | null>;
  card(userId: string): EssayCardDeps;
  done?(userId: string): Promise<void>; // after the draft: the turn's cost is recorded
}
const jwtRole = (token: string): string | null => {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4))).role ?? null;
  } catch {
    return null;
  }
};
export async function handleEssayDraft(req: Request, d: HandlerDeps): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...d.cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: d.cors });
  if (req.method !== "POST") return json(405, { ok: false, why: "invalid", message: "POST only." });
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return json(401, { ok: false, why: "invalid", message: "Sign in to Upmore first." });
  if (jwtRole(m[1]) !== "authenticated") return json(403, { ok: false, why: "invalid", message: "Only a person's own sign-in can ask for a draft." });
  const user = await d.user(m[1]).catch(() => null);
  if (!user?.id) return json(401, { ok: false, why: "invalid", message: "Sign in to Upmore first." });
  const body = await req.json().catch(() => null);
  const reply = await essayCardDraft(user.id, body, d.card(user.id));
  if (d.done) await d.done(user.id).catch(() => {});
  return json(reply.ok || reply.why !== "invalid" ? 200 : 400, reply);
}
