// WO-030: what an employer's own form says about AI help on its application. It decides first whether Trainee may draft
// a written answer for that posting; nothing downstream overrides it.
//
// Read from the form's own labels (the captured CI sets show the real wording: Canonical's "During this application
// process I agree to use only my own words. I understand that plagiarism, the use of AI or other generated content will
// disqualify my application.", Airwallex's "We encourage you to use AI tools to help research, prepare, or refine your
// application materials. However, we ask that you do not use AI tools during live, real-time interviews...", Anthropic's
// bare "AI Policy for Application"). A rule about live interviews only is not a rule about the written application. A
// question ABOUT AI (favourite AI tools, AI notetakers in interviews, AI talent matching) is not a policy at all.
//
//   prohibited  the form asks for answers written without AI (or in the person's own words, with AI named)
//   unread      the form names an AI policy for the application but does not say what it allows
//   allowed     the form says AI help on the application is fine
//   unknown     the form says nothing about AI help on the application
// A ban anywhere on the form wins over an allowance anywhere else.
export type AiPolicyKind = "prohibited" | "unread" | "allowed" | "unknown";
export interface AiPolicy { policy: AiPolicyKind; said: string | null }

const plain = (s: unknown) => String(s ?? "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const sentences = (s: string) => (s.match(/[^.!?]+[.!?]*/g) || []).map((x) => x.trim()).filter(Boolean);

const AI = /\b(ai|a\.i\.|artificial intelligence|chat ?gpt|gpt|llms?|large language models?|generative|gen ?ai|language models?|chatbots?)\b|\bgenerated (content|text|answers?|responses?)\b/i;
// A sentence only about live interviews (no word about the written application) is about the interview.
const INTERVIEW_ONLY = (s: string) =>
  /\binterview/i.test(s) && !/\b(application|answers?|responses?|written|writing|essays?|materials|submissions?|cover letter|questions?|apply)\b/i.test(s);
const BAN = [
  /\b(do not|don'?t|must not|may not|should not|shouldn'?t|cannot|can'?t|never|refrain from|avoid|without)\b[^.!?]{0,60}\b(ai|artificial intelligence|chat ?gpt|llms?|generative|gen ?ai|language models?|chatbots?)\b/i,
  /\b(ai|artificial intelligence|chat ?gpt|llms?|generative ai|gen ?ai|ai tools|generated content)\b[^.!?]{0,80}\b(not (be )?(allowed|permitted|accepted|acceptable)|prohibited|forbidden|disqualif\w*|grounds for (rejection|disqualification)|(result in|lead to) (rejection|disqualification))/i,
  /\b(not|never) (be )?(written|generated|produced|drafted|created|assisted) (by|with|using) (an? )?(ai|artificial intelligence|chat ?gpt|generative|language model|llm)/i,
  /\bnon-?ai[- ]assisted\b|\bwithout (mediation|assistance|help) (through|from|of) (an? )?ai\b/i,
];
// "only my own words" is a ban when the same statement names AI or generated content.
const OWN_WORDS = /\b(only|solely|entirely) (in )?(my|your|their) own words\b|\buse (only )?(my|your) own words\b/i;
const ALLOW = [
  /\b(encourage|welcome|invite)s? (you |candidates |applicants )?to use\b[^.!?]{0,40}\b(ai|artificial intelligence|chat ?gpt|llms?)\b/i,
  /\b(feel free|you(?:'re| are) (free|welcome)|you may|you can|it'?s (fine|ok(ay)?)|is (fine|ok(ay)?|allowed|permitted)) to use\b[^.!?]{0,40}\b(ai|artificial intelligence|chat ?gpt|llms?)\b/i,
  /\b(ai|artificial intelligence|chat ?gpt|llms?)( tools)? (is|are) (allowed|permitted|welcome|fine)\b/i,
];
const APPLICATION_SCOPE = /\b(application|applying|apply|materials|answers?|responses?|research|prepare|refine|resume|cover letter|writing)\b/i;
const NAMED_POLICY = /\bai[- ](use )?polic(y|ies)\b|\bpolicy on (the )?(use of )?(ai|artificial intelligence|generative ai)\b|\b(ai|generative ai) (usage )?guidelines\b/i;

function readOne(label: string): AiPolicyKind {
  const text = plain(label);
  if (!text || !(AI.test(text) || OWN_WORDS.test(text) || /plagiari/i.test(text))) return "unknown";
  const scoped = sentences(text).filter((s) => !INTERVIEW_ONLY(s)).join(" ");
  if (!scoped) return "unknown";
  if (BAN.some((r) => r.test(scoped))) return "prohibited";
  if (OWN_WORDS.test(scoped) && (AI.test(scoped) || /plagiari/i.test(scoped))) return "prohibited";
  if (ALLOW.some((r) => r.test(scoped)) && APPLICATION_SCOPE.test(scoped)) return "allowed";
  if (NAMED_POLICY.test(scoped)) return "unread";
  return "unknown";
}

// The labels on a form that state an AI policy for the application (the person's computer carries these with the
// posting's written questions, so the texting side reads the same words even when a standing consent filled them).
export function aiPolicyStatements(labels: unknown[]): string[] {
  const out: string[] = [];
  for (const l of labels || []) {
    const t = plain(l).slice(0, 600);
    if (t && readOne(t) !== "unknown" && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 4);
}

// The posting's policy from every text it has: its labels, a carried statement, the written question itself.
export function readAiPolicy(texts: unknown[]): AiPolicy {
  const order: AiPolicyKind[] = ["prohibited", "unread", "allowed"];
  const found = (texts || []).flatMap((t) => String(t ?? "").split(/\n+/)).map((t) => ({ t: plain(t), k: readOne(t) }));
  for (const k of order) {
    const hit = found.find((f) => f.k === k);
    if (hit) return { policy: k, said: hit.t };
  }
  return { policy: "unknown", said: null };
}
