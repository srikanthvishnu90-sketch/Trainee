// The one question a role ask may carry (spec 2.2: ask only the consequential gap, in chat, one at a time, while the result goes out).
// The words are the MODEL's (D-007): this module hands it the structured needs (apply_readiness.ts) and CHECKS what comes back.
// A question that fails a check is dropped, never replaced by canned prose: the turn simply carries no question, and the needs stay
// in the turn's meta for the next ask.
import { cannedIn, internalIn, type ModelFn, type WriterChannel } from "./career_reply_writer.ts";
import { type Readiness, readinessFacts, SECRET_FIELD } from "./apply_readiness.ts";

export const ASK_MAX_CHARS = 240;
const CLAIM = /\b(sent|submitted|applied|approved|queued|scheduled|booked|confirmed)\b/i;
const URL_OR_ADDRESS = /https?:\/\/|\S+@\S+\.\S+/i;

// Problems with a written question (empty: it may be used).
export function askProblems(text: string, r: Readiness): string[] {
  const t = String(text ?? "").trim(), out: string[] = [];
  if (!t) return ["empty"];
  if (!r.ask_now.length) out.push("nothing blocking to ask");
  if ((t.match(/\?/g) ?? []).length !== 1) out.push("not exactly one question");
  if (t.length > ASK_MAX_CHARS) out.push(`longer than ${ASK_MAX_CHARS}`);
  if (URL_OR_ADDRESS.test(t)) out.push("carries a link or address");
  if (/\d/.test(t)) out.push("carries a number");
  if (SECRET_FIELD.test(t)) out.push("asks for or names a secret field");
  if (CLAIM.test(t)) out.push("states a status");
  if (/^\s{0,3}#{1,6}\s|^\s*[-*]\s/m.test(t)) out.push("a header or list");
  for (const c of cannedIn(t)) out.push(`canned phrase /${c}/`);
  for (const j of internalIn(t)) out.push(`internal word "${j}"`);
  return out;
}

export function askPayload(r: Readiness, message: string, channel: WriterChannel) {
  const first = r.ask_now[0];
  return {
    system: [
      "You are Trainee, a career agent, texting one person. You have already sent them their role results and the link. Write ONE short follow-up message that asks ONE question.",
      `The question is about: ${first?.label ?? "nothing"} (${first?.why ?? ""}). Ask only that, in your own words, plain and warm, under ${ASK_MAX_CHARS} characters, exactly one question mark.`,
      "Do not mention anything else that is missing, do not list, do not apologize, do not repeat the results, do not include a link, and do not say anything is sent, submitted, applied or approved. Never ask for a password, a code, or an ID number.",
      channel === "web" ? "Plain text." : "Plain text, no markdown.",
      "Write only the message.",
    ].join("\n"),
    messages: [{ role: "user", content: `THEY SAID:\n${String(message ?? "").slice(0, 600)}\n\nNEEDS (data):\n${readinessFacts(r)}` }],
    max_tokens: 120, temperature: 0.4,
  };
}
// deno-lint-ignore no-explicit-any
const textOf = (msg: any) => Array.isArray(msg?.content) ? msg.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : typeof msg?.content === "string" ? msg.content : "";

export async function writeReadinessAsk(o: { readiness: Readiness; message: string; channel?: WriterChannel; model: ModelFn | null }): Promise<{ text: string | null; rejected: string[] }> {
  if (!o.model || !o.readiness.ask_now.length) return { text: null, rejected: o.model ? ["nothing blocking to ask"] : ["no model"] };
  let text = "";
  try { text = textOf(await o.model(askPayload(o.readiness, o.message, o.channel ?? "web"))).trim().replace(/^["“](.*)["”]$/s, "$1").trim(); }
  catch (e) { return { text: null, rejected: [`model unavailable: ${(e as Error)?.message ?? String(e)}`.slice(0, 160)] }; }
  const bad = askProblems(text, o.readiness);
  return bad.length ? { text: null, rejected: bad } : { text, rejected: [] };
}
