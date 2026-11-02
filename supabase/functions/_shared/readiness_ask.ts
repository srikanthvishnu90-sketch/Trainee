// The one question a role ask may carry (spec 2.2: ask only the consequential gap, in chat, one at a time, while the result goes out).
// The words are the MODEL's (D-007): this module hands it the structured needs (apply_readiness.ts) and CHECKS what comes back.
// A question that fails a check is dropped, never replaced by canned prose: the turn simply carries no question, and the needs stay
// in the turn's meta for the next ask.
import { cannedIn, factCheck, factsForTurn, internalIn, type ModelFn, type WriterChannel } from "./career_reply_writer.ts";
import { type NeedKey, type Readiness, readinessFacts, SECRET_FIELD } from "./apply_readiness.ts";

export const ASK_MAX_CHARS = 240;
const CLAIM = /\b(sent|submitted|applied|approved|queued|scheduled|booked|confirmed)\b/i;
const URL_OR_ADDRESS = /https?:\/\/|\S+@\S+\.\S+/i;

// The question must be ABOUT the key it is tagged with: its text has to name that need (an allowlist per key), and it may not touch
// anything on the denylist (identity, protected traits, credentials, assertions about the person, promises of action).
export const KEY_WORDS: Record<NeedKey, RegExp> = {
  resume: /\bresume\b|\bresumé\b|\bCV\b|curriculum vitae/i,
  work_authorization: /authori[sz]ed|work authori[sz]ation|legally (?:able |allowed |permitted )?to work/i,
  sponsorship: /sponsor/i,
  remote_scope: /\bremote\b|\banywhere\b|work from home/i,
  seniority: /\b(?:level|seniority|senior|junior|entry|intern(?:ship)?s?|new[- ]?grad|early[- ]career|experienced)\b/i,
  location: /\b(?:where|city|cities|location|area|based|relocat\w*|commut\w*|metro)\b/i,
  email: /e-?mail/i,
  phone: /\b(?:phone|mobile|cell)\b/i,
  full_name: /\b(?:full name|legal name|name on your|your name)\b/i,
  salary_floor: /\b(?:pay|salary|compensation|floor|minimum|at least|base)\b/i,
};
const DENY = /citizen|birth|\bborn\b|gender|\brace\b|ethnic|veteran|disab|log[- ]?in\b|username|credential|pass[- ]?code|\bcode\b|social[- ]?security|\bssn\b|maiden|www\.|\.com\b|\.org\b|\.net\b|\bdob\b|religio|orientation|marital|pregnan|\bage\b|criminal|convict|\bvisa (?:number|status|type|category)\b|\bcard\b|\baddress\b|\bid\b|green card|passport|\bscan\b|photo|upload|attach|\bnational\b/i;
// Shape: exactly one plain sentence, ending in the one "?", no second interrogative, no clause that reasons from who the person is, no imperative.
const SHAPE_BAD: Array<[RegExp, string]> = [
  [/\?\s*\S/, "text after the question"],
  [/\b(?:and|or)\s+(?:do|does|are|is|will|would|can|could|have|what|which|where|how|when)\b/i, "a second question joined to the first"],
  [/\b(?:considering|given|knowing|seeing|now that|with your|for someone|someone who|people like)\b/i, "reasons from who the person is"],
  [/\byour (?:accent|name|background|school|family|country|english|resume|studies|degree|experience)\b|\bsounds?\b|\bsuggests?\b|\blooks? (?:strong|good|great)\b/i, "comments on the person"],
  [/(?:^|[.!?]\s+)(?:tell|send|give|reply|say|text|attach|confirm|just|please|let)\b/i, "an instruction, not a question"],
];
// Assertions about the person ("since you...", "you're a ...", "as a ...") and anything that promises or does an action.
const ASSERT = /\bsince you\b|\bbecause you\b|\bas (?:an?|the) \w+|\byou(?:'re|’re| are|'ve|’ve| have been| must be| seem)\b(?! (?:able|authori|open|looking|interested|willing|hoping|aiming|targeting|comfortable|ok|okay)\b)|\bI (?:see|noticed|saw|know|assume|take it)\b/i;
const PROMISE = /\b(?:appl(?:y|ies|ying|ied)|submit\w*|send(?:ing)?|sent|queue\w*|enrol\w*|register\w*|book(?:ing)?|schedul\w+|start(?:ing)? (?:now|right|on)|right away|go ahead|I(?:'ll|’ll| will| am going to|'m going to|'m gonna))\b/i;

// Problems with a written question (empty: it may be used). `key` is the need the question is tagged with: it must be the first of
// ask_now, and the text must name it. `message` is what the person said this turn; the fact check allows only that and the needs.
export function askProblems(text: string, r: Readiness, key?: string | null, message = ""): string[] {
  const t = String(text ?? "").trim(), out: string[] = [];
  if (!t) return ["empty"];
  if (!r.ask_now.length) { out.push("nothing blocking to ask"); return out; }
  const want = r.ask_now[0].key;
  if (key !== undefined) {
    if (key !== want) out.push(`tagged ${key ?? "nothing"}, not the first need (${want})`);
  }
  if (!KEY_WORDS[want]?.test(t)) out.push(`does not ask about ${want}`);
  if ((t.match(/\?/g) ?? []).length !== 1) out.push("not exactly one question");
  if (t.length > ASK_MAX_CHARS) out.push(`longer than ${ASK_MAX_CHARS}`);
  if (URL_OR_ADDRESS.test(t)) out.push("carries a link or address");
  if (/\d/.test(t)) out.push("carries a number");
  if (SECRET_FIELD.test(t)) out.push("asks for or names a secret field");
  for (const [re, why] of SHAPE_BAD) if (re.test(t)) out.push(why);
  if (DENY.test(t)) out.push("asks for or names something outside the need (identity, protected trait, credential)");
  if (ASSERT.test(t)) out.push("asserts something about the person");
  if (PROMISE.test(t)) out.push("promises or names an action");
  if (CLAIM.test(t)) out.push("states a status");
  if (/^\s{0,3}#{1,6}\s|^\s*[-*]\s/m.test(t)) out.push("a header or list");
  for (const c of cannedIn(t)) out.push(`canned phrase /${c}/`);
  for (const j of internalIn(t)) out.push(`internal word "${j}"`);
  // The facts the question may rest on: what the person said now and the needs, nothing else.
  // (A question's opening word is capitalized by grammar, not because it is a name.)
  const plain = t.replace(/(^|[.!?]\s+)(Do|Does|Did|Are|Is|Was|Were|Would|Will|Can|Could|Should|Have|Has|Which|What|Where|When|How|For|If|Any|Is there)\b/g, (_m, a, w) => a + w.toLowerCase());
  for (const v of factCheck(plain, factsForTurn({ needs: readinessFacts(r), reply: message }))) out.push(`fact check: ${v}`);
  return [...new Set(out)];
}

export function askPayload(r: Readiness, message: string, channel: WriterChannel) {
  const first = r.ask_now[0];
  return {
    system: [
      "You are Trainee, a career agent, texting one person. You have already sent them their role results and the link. Write ONE short follow-up message that asks ONE question.",
      `Reply with JSON only: {"key":"${first?.key ?? ""}","question":"<your message>"}. The key must be exactly that value.`,
      `The question is about: ${first?.label ?? "nothing"} (${first?.why ?? ""}). Ask only that, in your own words, plain and warm, under ${ASK_MAX_CHARS} characters, exactly one question mark.`,
      "Do not mention anything else that is missing, do not list, do not apologize, do not repeat the results, do not include a link, and do not say anything is sent, submitted, applied or approved. Never ask for a password, a code, or an ID number.",
      channel === "web" ? "Plain text." : "Plain text, no markdown.",
      "Do not describe the person, do not mention citizenship, age, birth, gender or any ID, and do not promise any action.",
    ].join("\n"),
    messages: [{ role: "user", content: `THEY SAID:\n${String(message ?? "").slice(0, 600)}\n\nNEEDS (data):\n${readinessFacts(r)}` }],
    max_tokens: 120, temperature: 0.4,
  };
}
// deno-lint-ignore no-explicit-any
const textOf = (msg: any) => Array.isArray(msg?.content) ? msg.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : typeof msg?.content === "string" ? msg.content : "";

export async function writeReadinessAsk(o: { readiness: Readiness; message: string; channel?: WriterChannel; model: ModelFn | null }): Promise<{ text: string | null; rejected: string[] }> {
  if (!o.model || !o.readiness.ask_now.length) return { text: null, rejected: o.model ? ["nothing blocking to ask"] : ["no model"] };
  let raw = "";
  try { raw = textOf(await o.model(askPayload(o.readiness, o.message, o.channel ?? "web"))).trim(); }
  catch (e) { return { text: null, rejected: [`model unavailable: ${(e as Error)?.message ?? String(e)}`.slice(0, 160)] }; }
  // The model must tag its question with the need it asks about.
  let key: string | null = null, text = "";
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    key = typeof j?.key === "string" ? j.key : null; text = typeof j?.question === "string" ? j.question.trim() : "";
  } catch { return { text: null, rejected: ["not tagged JSON"] }; }
  const bad = askProblems(text, o.readiness, key, o.message);
  return bad.length ? { text: null, rejected: bad } : { text, rejected: [] };
}
