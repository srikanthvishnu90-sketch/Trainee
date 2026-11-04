// CRISIS TEXT IS CODE'S (D-035 review): a message that names self-harm or suicide is answered by code's own crisis reply,
// never by the brain. The two crisis screens the router already carries decide, word for word: CareerIntel's request
// screen (125-career-intel.js respondToRequest, action "support": 988, Crisis Text Line, 911) and CareerSafety's distress
// protocol (139-career-safety.js distressResponse, crisis: 988, Crisis Text Line). The router answers only some of their
// phrases with safety_support (its appendix runs after other modules, and it reads only 125's screen): "I'm thinking about
// suicide" fell to "unclaimed" and "I don't want to live anymore, this job search is hopeless" to career_recommendations.
// career_staged.ts keeps every such turn off the brain, and the handler answers it with this reply when the router did
// not. No new prose here: the reply is the core's text.
import { CareerIntel, CareerSafety } from "../_shared/router_core.career.js";

// Typographic apostrophes as typed on phones ("don’t") read as the plain one the screens expect.
const plain = (s: string) => String(s ?? "").replace(/[‘’ʼ]/g, "'");

// The core's crisis reply for this message, or null when neither screen calls it a crisis.
export function crisisReply(message: string): string | null {
  const text = plain(message);
  try {
    const r = (CareerIntel as any)?.respondToRequest?.(text);
    if (r && r.action === "support" && /\b988\b/.test(String(r.text ?? ""))) return String(r.text);
  } catch { /* the other screen still decides */ }
  try {
    const d = (CareerSafety as any)?.distressResponse?.({ text, profileFacts: [] });
    if (d && d.crisis === true && typeof d.text === "string") return d.text;
  } catch { /* neither screen could read it: not a crisis by code's rule */ }
  return null;
}

export const CRISIS_INTENT = "safety_support";
