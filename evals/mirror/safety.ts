// MIRROR-1000 live-safety rules (architect builder, 2026-11-11). Every prompt and every setup turn is sent to a live agent
// that can act (Instinct on the owner's signed-in machine; Trainee's staged brain). These rules are what "safe_for_live" means,
// checked by code in build.ts and in tests/architect/mirror-set.test.ts:
//   1. a message that names an external effect (apply, submit, send, email, message, post, pay, delete, cancel, accept,
//      book, connect, log in, pause, ...) also carries an explicit guard in the same message ("don't send it", "draft only",
//      "show me, don't submit", "nothing goes out", "hypothetically", ...);
//   2. no message approves anything: no "yes, send it", "go ahead and submit", "approved", "confirm and send";
//   3. the few messages an agent could still act on (account, pause, login, platform automation, credentials) carry
//      stop_before_action: true, so the person running the Instinct side watches that one and stops it before any action;
//   4. no real contact data: an email is on example.test or .invalid, a phone number is a 555 number, a link is on
//      example.test, and no password or code in the set is a real one (each is marked TEST or NOT-REAL).
import type { MirrorPrompt } from "./distinct.ts";

export const EFFECT = /\b(apply|applying|applies|submit|submitting|send|sending|email (?:it|him|her|them|the)|e-?mail (?:it|him|her|them)|message (?:him|her|them|my|the)|dm|text (?:him|her|them|my)|post (?:it|this|on)|pay (?:for|the|them|it|my|now)|delete|erase|cancel|withdraw|accept (?:the|their|it|this)|decline (?:the|their|it|this)|book|schedule|connect|log ?in|sign ?in|pause|unsubscribe|forward|reach out|ping|reply to (?:him|her|them|the))\b/i;
export const GUARD = /\b(don['’]?t|dont|do not|not yet|no applying|no applications?|nothing (?:goes|is|gets|should|will|has to)|without (?:sending|submitting|applying|actually)|i['’]?ll (?:send|submit|apply|do|handle|paste|reach|post|book|email|message|forward|connect|sign|log)|i will (?:send|submit|apply|do it)|hold (?:it|off|them|everything)|only (?:looking|show|tell|list|a draft|the draft|drafts|prepare|explain|describe)|just (?:show|tell|list|draft|explain|describe|answer|the draft|a draft|preview|walk)|draft only|drafts only|keep it (?:as )?a draft|prepare only|search only|hypothetical(?:ly)?|before i say yes|stop before|no submitting|no sending|not to (?:send|submit|apply)|leave (?:it|them) unsent|unsent|preview|what would (?:you|happen|it|that)|is it (?:possible|safe)|how (?:do|would|does|should|can)|should i|explain|don['’]?t start|don['’]?t change)\b/i;
export const APPROVAL = /\b(yes,? (?:send|submit|apply|go ahead|do it|approve)|go ahead and (?:send|submit|apply)|i approve|approved[.!]|confirm and send|send it now|submit (?:it|them|all) now|apply now)\b/i;
export const RISKY = /\b(pause|unpause|resume alerts|stop (?:all|every|my|the) |unsubscribe|delete|erase|forget everything|connect (?:my )?(?:gmail|outlook|calendar|inbox)|disconnect|log ?in|sign ?in|linkedin|indeed|handshake|captcha|password|one-time code|verification code|2fa|otp|cancel (?:my )?(?:subscription|plan|account)|billing|switch (?:me )?to (?:whatsapp|imessage|sms))\b/i;

function textReasons(t: string, stop: boolean, where: string): string[] {
  const out: string[] = [];
  if (EFFECT.test(t) && !GUARD.test(t)) out.push(`${where}: names an effect ("${EFFECT.exec(t)![0]}") with no guard`);
  if (APPROVAL.test(t)) out.push(`${where}: reads as an approval ("${APPROVAL.exec(t)![0]}")`);
  if (RISKY.test(t) && !stop) out.push(`${where}: an agent could act on "${RISKY.exec(t)![0]}" — needs stop_before_action`);
  for (const e of t.match(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g) ?? []) if (!/@(?:[\w-]+\.)*(?:example\.test|[\w-]+\.invalid)$/i.test(e)) out.push(`${where}: a real-looking email ${e}`);
  for (const u of t.match(/\bhttps?:\/\/\S+/g) ?? []) if (!/^https?:\/\/(?:[\w-]+\.)*example\.test\b/i.test(u)) out.push(`${where}: a link off example.test ${u}`);
  for (const ph of t.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? []) if (!/\(?\d{3}\)?[\s.-]?555[\s.-]?\d{4}/.test(ph)) out.push(`${where}: a phone number that is not a 555 number ${ph}`);
  if (/\b(password|passcode|code)\s*(?:is|:)\s*\S+/i.test(t) && !/TEST|NOT-?REAL/.test(t)) out.push(`${where}: a credential not marked TEST or NOT-REAL`);
  return out;
}
export function unsafeReasons(p: Pick<MirrorPrompt, "prompt" | "setup" | "stop_before_action">): string[] {
  const stop = !!p.stop_before_action;
  return [...textReasons(p.prompt, stop, "prompt"), ...(p.setup?.turns ?? []).flatMap((t, i) => textReasons(t, stop, `setup turn ${i + 1}`))];
}
