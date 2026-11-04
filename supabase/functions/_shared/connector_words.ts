// CONNECTOR SCENARIOS (2026-10-29, tests/architect/scenarios-connectors.test.ts): the words a person uses about their
// connected mailboxes, read the same way by every turn that acts on them (connectors.ts connectorAsk, google_disconnect.ts
// isGoogleDisconnect, outlook_connector.ts outlookAsk). Generated asks ("disconnect google", "remove gmail access",
// "unlink outlook", "can you disconnect my gmail please", "disconect gmial", "what can you see") decided these rules:
//   - a greeting or a polite lead-in before the ask ("hey,", "please", "can you", "I'd like to") and "please", "thanks",
//     "now", "for me" after it are not part of it; case, curly apostrophes and closing punctuation do not matter;
//   - a few common typos of the verbs and the mailbox names are read as the word ("disconect", "gmial", "outlok");
//   - the whole message must be the ask: "disconnect gmail and apply to Stripe" is not acted on by code (never half);
//   - "google" and "microsoft" alone are also employers: "remove Google", "add Microsoft" (from or to a list) are never
//     a connector ask; "remove my google account", "remove google access", "disconnect google", "connect microsoft" are.
// Pure functions; no I/O.

export function askWords(message: string): string {
  let t = String(message ?? "").toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
  const strip = () => { t = t.replace(/^[\s,.:;!-]+/, "").replace(/[\s,.:;!?]+$/, ""); };
  strip();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(?:hey|hi|hello|ok|okay|so|yo|quick question)\b[,!:]?\s*/, "");
    t = t.replace(/^(?:please|pls|plz|kindly)\s+/, "");
    t = t.replace(/^(?:can|could|would|will) (?:you|u)(?: please| pls)?\s+/, "");
    t = t.replace(/^(?:i want to|i wanna|i'd like to|id like to|i would like to|go ahead and|help me|let's|lets)\s+/, "");
    strip();
    t = t.replace(/\s+(?:please|pls|plz|thanks|thank you|thx|now|right now|for me|asap)$/, "");
    strip();
    if (t === before) break;
  }
  return t
    .replace(/\b(?:disconect|dissconnect|disconnet|disconnnect|discconnect|disonnect|dicsonnect|disconnct|disconnec)\b/g, "disconnect")
    .replace(/\bunlnk\b/g, "unlink")
    .replace(/\b(?:conect|connnect|conncet|cnnect|connet)\b/g, "connect").replace(/\breconect\b/g, "reconnect")
    .replace(/\b(?:conected|connnected|conneted)\b/g, "connected")
    .replace(/\b(?:gmial|gamil|gmal|gmaill|g-mail|g mail)\b/g, "gmail")
    .replace(/\b(?:outlok|outloook|outlookk|otlook)\b/g, "outlook");
}

export type MailboxId = "gmail" | "outlook";
const GOOGLE = new Set(["gmail", "google mail", "google"]);
// "disconnect|unlink|revoke|remove [trainee|access ... from|to] [my|the] <mailbox> [account|email|inbox|mail] [access] [from trainee]"
const DISCONNECT = /^(disconnect|unlink|revoke|remove) (?:(trainee|trainee's access|your access|access) (?:from|to) )?(my |the )?(gmail|google mail|google|outlook|hotmail|microsoft|office ?365|o365|microsoft 365|work email|live|msn)( account| email| inbox| mail)?( access)?( from trainee)?$/;
export function disconnectOf(message: string): MailboxId | null {
  const m = DISCONNECT.exec(askWords(message));
  if (!m) return null;
  // An employer's name alone after "remove" is a list edit ("remove Google"), never a disconnect.
  if (m[1] === "remove" && !m[2] && !m[3] && !m[5] && !m[6] && (m[4] === "google" || m[4] === "microsoft")) return null;
  return GOOGLE.has(m[4]) ? "gmail" : "outlook";
}
const GMAIL_CONNECT = /^(connect|link|add|hook up|set up|reconnect|relink)( my| the)? (gmail|google mail|google)( account| email| inbox| mail)?( to trainee)?$/;
export function gmailConnectOf(message: string): boolean {
  const m = GMAIL_CONNECT.exec(askWords(message));
  if (!m) return false;
  return !(m[1] === "add" && !m[2] && !m[4] && m[3] === "google"); // "add google": an employer
}
const OUTLOOK_CONNECT = /^(connect|link|add|hook up|set up|use)( my| an?)? (outlook|hotmail|live|msn|office ?365|o365|microsoft 365|microsoft|exchange|work|school|university|college)((?: (?:email|e-mail|mail|account|inbox|calendar|address))*)( account| instead| too| as well| to send)?$/;
export function outlookConnectOf(message: string): boolean {
  const m = OUTLOOK_CONNECT.exec(askWords(message));
  if (!m) return false;
  if ((m[1] === "add" || m[1] === "use") && !m[2] && !m[4] && !m[5] && m[3] === "microsoft") return false; // "add Microsoft": an employer
  // "use work" / "connect school" alone say no mailbox.
  if (["work", "school", "university", "college"].includes(m[3]) && !m[4]) return false;
  return true;
}
export function outlookStatusOf(message: string): boolean {
  return /^(?:is|are) (?:my )?(?:outlook|hotmail|microsoft|work email)(?: (?:account|email|mail))? (?:still )?connected$/.test(askWords(message));
}
const WHATS = [
  /^(?:what(?:'s|s| is| are)|which (?:email )?(?:accounts?|apps?|things|services)(?: are| have| did)?|what (?:email )?(?:accounts?|apps?|services) (?:are|have|did)|what have i|what did i) (?:you )?(?:connected|linked|hooked up)(?: to (?:you|trainee))?(?: right now)?$/,
  /^what (?:do you have|(?:email )?(?:accounts?|apps?|services) do you have) access to$/,
  /^(?:show (?:me )?|list )?(?:my )?connections$/, /^what are my connections$/,
  /^what can you (?:see|access|read)$/,
  /^is (?:my )?(?:gmail|google mail|google)(?: account)? (?:still )?connected$/,
];
export function whatsConnectedOf(message: string): boolean {
  const t = askWords(message);
  return t.length <= 80 && WHATS.some((re) => re.test(t));
}
