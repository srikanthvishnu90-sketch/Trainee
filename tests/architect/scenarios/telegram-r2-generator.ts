// TELEGRAM CHAT FLOW ROUND 2 (architect, 2026-10-30; round 1: telegram-generator.ts, #311): seeded scenarios for what
// round 1 did not cover. Every expectation is written here from how the scenario is built, never from product code.
//   conv     whole conversations of one person (or two at once): typos, emoji-only replies, voice notes, stickers, GIFs,
//            edited messages, replies to a specific message (reply_to_message), job posts forwarded from a channel or a
//            person (text, or a flyer with its caption), pasted links and "Apply here" links (text_link entities),
//            documents that are not resumes, /start, the phone share, STOP and START, an update Telegram sends twice, and
//            the next day's alert. Per step: exactly one model turn with exactly the words it should read, or exactly the
//            fixed answer, or deliberately nothing.
//   long     a message of 4,001 to 4,096 characters (Telegram's own limit; a long paste arrives as such messages): the
//            brain reads a whole-word prefix of at most 4,000 and the answer says where reading stopped.
//   api      Bot API realities: message_thread_id (topics), taps on old messages after the card changed, inline keyboard
//            limits (at most 8 a row, 100 in all), captions of at most 1,024 under a photo, logos Telegram cannot fetch,
//            "can't parse entities" (400: sent again as plain text, once), job pages whose escaping outgrows 4,096,
//            blocked (403) and deleted (403 "user is deactivated") people, "chat not found", a group migrated to a
//            supergroup, files over the 20 MB a bot may download (said or not said).
//   lang     a person writing in Spanish, Hindi or Arabic (typos, RTL marks, combining marks, emoji) and answers in that
//            language with emphasis, lists, links and code: their words reach the brain exactly; every message Telegram
//            gets is valid (HTML well formed, at most 4,096, whole characters); no word lost; their STOP still works and
//            their own words for stop ("parar", "توقف", "रुको") are not taken as a command on Telegram.
// Seeded; a failure names its scenario id (TG2_ONLY=<ids> runs it alone). No network, no model, no wall clock.
import { rng, type R } from "../scenarios-fixture.ts";
export { rng };
export type { R };

export const NOW = Date.parse("2026-10-30T15:00:00Z");
export const pick = <T>(r: R, xs: readonly T[]): T => r.pick(xs);

// ------------------------------------------------------------------------------------------------ words
// Typos as people type them on a phone; emoji-only replies; questions a person asks a career agent.
export const TYPO_TEXTS = [
  "serch data analst jobs in austn", "any remot jobs for new grads??", "wat should i do next", "show me my aplications pls", "helo", "thx!!",
  "can u find marketing intern rolez in chicgo", "im a junoir majoring in econ", "how do i prep for an intervew at stripe", "is ths job legit",
  "wht jobs fit my resme", "i want sth in NYC or remote", "ok kool", "yes pls", "nah", "lol ok", "find nursing jobs near me",
  "tell me more abt the first one", "how much do data analysts make in denver", "can you write a cover leter for acme",
];
export const EMOJI_ONLY = ["👍", "🙏", "🔥🔥", "❤️", "😂", "👀", "✅", "🤔", "👋🏽", "🙌🏿", "👨‍💻", "🇺🇸", "💯", "😭🙏", "👍🏻👍🏻"];
export const LANG_TEXTS: Record<"es" | "hi" | "ar", string[]> = {
  es: ["hola, busco trabajo de analista de datos en Madrid", "¿qué empleos hay para recién graduados?", "gracias!! 🙏", "no entiendo, puedes explicar otra vez",
    "estoy buscando prácticas de marketing en Barcelona o remoto", "¿cuánto gana un enfermero en Texas?", "sí, por favor", "quiero aplicar al primero",
    "mi currículum está en inglés, ¿está bien?", "parar", "ayuda", "señor, ¿dónde está mi solicitud?"],
  hi: ["नमस्ते, मुझे डेटा एनालिस्ट की नौकरी चाहिए", "क्या बेंगलुरु में इंटर्नशिप है?", "धन्यवाद 🙏", "मुझे समझ नहीं आया, फिर से बताइए",
    "मेरा रिज़्यूमे देखो", "नर्स की सैलरी कितनी है?", "हाँ, ठीक है", "रुको", "पहली नौकरी के लिए आवेदन करो", "क्या यह नौकरी सही है?"],
  ar: ["مرحبا، أبحث عن وظيفة محلل بيانات في دبي", "هل توجد وظائف للخريجين الجدد؟", "شكرا جزيلا 🙏", "لم أفهم، هل يمكنك الشرح مرة أخرى",
    "‏أريد تدريبا في التسويق", "كم راتب الممرض في الرياض؟", "نعم من فضلك", "توقف", "قدم على الوظيفة الأولى", "هل هذه الوظيفة حقيقية؟"],
};
// Answers in each language, written the way the brain writes them (markdown emphasis, lists, links, code). Each has the words
// that must arrive (no markup) and the links.
export const LANG_REPLIES: Record<"es" | "hi" | "ar", string[]> = {
  es: ["**Encontré 3 empleos** para ti en Madrid:\n- Analista de Datos en *Acme* (remoto)\n- Becario de BI en Globex\n\nMira: https://jobs.lever.co/acme/123",
    "Claro. Un enfermero en Texas gana entre **$70,000 y $90,000** al año, según la fuente: https://www.bls.gov/ooh/healthcare/registered-nurses.htm",
    "No hay problema. Tu currículum en inglés está bien; usa `SQL` y *Excel* en la primera línea.", "Listo: guardé tu búsqueda de _prácticas de marketing_ en Barcelona o remoto."],
  hi: ["**मुझे 3 नौकरियाँ मिलीं**:\n- डेटा एनालिस्ट, *Acme* (रिमोट)\n- बीआई इंटर्न, Globex\n\nदेखें: https://jobs.lever.co/acme/123",
    "नर्स की औसत सैलरी **$77,600** है। स्रोत: https://www.bls.gov/ooh/healthcare/registered-nurses.htm", "ठीक है, मैंने आपकी खोज सहेज ली: _बेंगलुरु_ में इंटर्नशिप।",
    "आपके रिज़्यूमे में `Python` और *SQL* सबसे ऊपर रखें।"],
  ar: ["**وجدت 3 وظائف** لك في دبي:\n- محلل بيانات في *Acme* (عن بعد)\n- متدرب ذكاء أعمال في Globex\n\nانظر: https://jobs.lever.co/acme/123",
    "متوسط راتب الممرض **$77,600** سنويا. المصدر: https://www.bls.gov/ooh/healthcare/registered-nurses.htm", "حسنا، حفظت بحثك عن _تدريب في التسويق_.",
    "ضع `SQL` و *Excel* في أعلى سيرتك الذاتية. ‏هذا مهم."],
};
// A job post forwarded from a Telegram jobs channel (the text, or the caption under its flyer), and a recruiter's message
// forwarded from a person: someone else's words, in the first person.
export const FORWARDED_POSTS = [
  "🚀 We're hiring! Data Analyst (Junior) at Acme Corp\n📍 Austin, TX (hybrid)\n💰 $70k-$85k\nRequirements: SQL, Excel, 1+ year\nApply here",
  "HIRING: Marketing Intern - Globex\nRemote (US only) | Summer 2027\nSend your CV or apply here",
  "Hi! I'm Sarah, a recruiter at Stripe. I'm based in New York and I'm looking for new grads with Python. Interested?",
  "Senior Nurse (RN) - Orchard Health, Chicago. I am the hiring manager; I have 12 years in nursing. Apply here",
  "Software Engineer Intern @ Initech — remote — rolling deadline. Apply here",
  "STOP", "yes", "/start abc123def", "/stop",
];
export const ORIGINS = [
  { type: "channel", chat: { id: -1001234567890, type: "channel", title: "Remote Jobs Daily", username: "remotejobsdaily" }, message_id: 77, date: 1 },
  { type: "channel", chat: { id: -1009876543210, type: "channel", title: "Вакансии IT 🇺🇸" }, message_id: 12, date: 1 },
  { type: "user", sender_user: { id: 5550001, is_bot: false, first_name: "Sarah", last_name: "Recruiter" }, date: 1 },
  { type: "hidden_user", sender_user_name: "Jordan (Hiring)", date: 1 },
  { type: "chat", sender_chat: { id: -100555, type: "supergroup", title: "Austin Tech Jobs" }, date: 1 },
] as const;
export const originName = (o: (typeof ORIGINS)[number]) => o.type === "channel" ? o.chat.title : o.type === "user" ? `${o.sender_user.first_name} ${o.sender_user.last_name}` : o.type === "hidden_user" ? o.sender_user_name : o.sender_chat.title;
export const APPLY_LINKS = ["https://jobs.lever.co/acme/7f3c2a10-1111-4abc-9def-000000000001", "https://boards.greenhouse.io/globex/jobs/4455667", "https://jobs.ashbyhq.com/initech/abc-123",
  "https://careers.orchardhealth.test/jobs/nurse-rn?src=tg&utm=1", "https://www.linkedin.com/jobs/view/3900000001"];

// ------------------------------------------------------------------------------------------------ steps
export type Media = "photo" | "video" | "animation" | "voice" | "audio" | "video_note";
export type Step =
  | { t: "text"; text: string; flavor: "typo" | "emoji" | "lang" | "link" | "plain" }
  | { t: "applyhere"; text: string; label: string; url: string } // "Apply here" as a text_link entity
  | { t: "long"; text: string } // 4,001 to 4,096 characters
  | { t: "forward"; text: string; origin: number; withLink: string | null }
  | { t: "caption"; media: Media; caption: string; link: string | null }
  | { t: "media"; media: Media | "sticker" | "dice" | "location" | "poll" } // no words
  | { t: "edit"; of: number } // the person edits their own earlier message (step index)
  | { t: "again"; of: number } // Telegram sends an earlier update again (same update_id)
  | { t: "reply"; text: string; toBot: boolean } // a reply to one of the bot's messages (or their own)
  | { t: "cmd"; cmd: "/start" | "/stop" | "/help" | "STOP" | "START" | "stop" | "Stop." }
  | { t: "contact"; own: boolean }
  | { t: "doc"; family: "pdf-resume" | "not-resume" | "png" | "zip" | "txt" | "doc" | "empty" | "big-said" | "huge-said" | "huge-unsaid" | "gif-doc" };
export interface ConvScenario {
  kind: "conv"; id: number; category: string; chat: number; start: "known" | "new-open" | "new-phone"; lang: "en" | "es" | "hi" | "ar"; native: boolean;
  steps: Step[]; second: { chat: number; steps: Step[] } | null; alertAfter: boolean;
}
export interface LongScenario { kind: "long"; id: number; category: string; chat: number; text: string; how: "plain" | "forward" | "words" | "lines" | "nospace" }
export type ApiCase =
  | { c: "thread"; private: boolean; thread: number }
  | { c: "stale"; op: "details" | "save" | "apply" | "confirm-old" | "confirm-new" | "next-old" | "details-photo"; noMessage: boolean }
  | { c: "keyboard"; postings: number; feed: boolean }
  | { c: "caption"; titleLen: number; fitLines: number; photoFails: "none" | "400-url" | "400-type" | "network" }
  | { c: "parse400"; parts: number; refuse: number[]; native: boolean }
  | { c: "escape"; amps: number; page: "details" | "apply"; native: boolean }
  | { c: "blocked"; how: "blocked" | "deactivated"; where: "answer" | "alert" | "fixed" | "parts"; at: number }
  | { c: "notfound"; where: "answer" | "alert" }
  | { c: "migrated"; how: "group-msg" | "migrate-to" | "migrate-from" | "supergroup-topic" }
  | { c: "bigfile"; size: number | null; getFile: "ok" | "too-big-400" | "stream-over" };
export interface ApiScenario { kind: "api"; id: number; category: string; chat: number; a: ApiCase }
export interface LangScenario {
  kind: "lang"; id: number; category: string; chat: number; lang: "es" | "hi" | "ar"; native: boolean;
  said: string; reply: string; long: number; // long: the answer repeated to this many characters (0: as written)
}
export type Scenario = ConvScenario | LongScenario | ApiScenario | LangScenario;

const typo = (r: R, s: string) => {
  // one more slip of the thumb: a doubled letter, a dropped letter or two swapped
  if (s.length < 6 || r.next() < 0.5) return s;
  const i = r.int(1, s.length - 3), k = r.int(0, 2);
  return k === 0 ? s.slice(0, i) + s[i] + s.slice(i) : k === 1 ? s.slice(0, i) + s.slice(i + 1) : s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
};
function step(r: R, lang: "en" | "es" | "hi" | "ar", i: number): Step {
  const x = r.next();
  const words = () => lang === "en" ? typo(r, r.pick(TYPO_TEXTS)) : r.pick(LANG_TEXTS[lang]);
  if (x < 0.22) return { t: "text", text: words(), flavor: lang === "en" ? "typo" : "lang" };
  if (x < 0.30) return { t: "text", text: r.pick(EMOJI_ONLY), flavor: "emoji" };
  if (x < 0.35) return { t: "text", text: `${r.pick(["what about this one", "can you apply to this?", "is this a good fit", "check this"])} ${r.pick(APPLY_LINKS)}`, flavor: "link" };
  if (x < 0.41) { const label = r.pick(["Apply here", "Apply", "apply now 👉", "here", "Подать заявку"]); return { t: "applyhere", text: `${r.pick(["Data Analyst at Acme.", "Nurse role, Orchard Health:", "Found this:"])} ${label}`, label, url: r.pick(APPLY_LINKS) }; }
  if (x < 0.49) return { t: "forward", text: r.pick(FORWARDED_POSTS), origin: r.int(0, ORIGINS.length - 1), withLink: r.next() < 0.5 ? r.pick(APPLY_LINKS) : null };
  if (x < 0.56) return { t: "caption", media: r.pick(["photo", "photo", "video", "animation", "voice"] as const), caption: r.next() < 0.6 ? r.pick(FORWARDED_POSTS.slice(0, 5)) : words(), link: r.next() < 0.5 ? r.pick(APPLY_LINKS) : null };
  if (x < 0.66) return { t: "media", media: r.pick(["photo", "voice", "audio", "video", "video_note", "sticker", "animation", "dice", "location", "poll"] as const) };
  if (x < 0.71 && i > 0) return { t: "edit", of: r.int(0, i - 1) };
  if (x < 0.75 && i > 0) return { t: "again", of: r.int(0, i - 1) };
  if (x < 0.81) return { t: "reply", text: r.next() < 0.3 ? r.pick(EMOJI_ONLY) : words(), toBot: r.next() < 0.7 };
  if (x < 0.88) return { t: "cmd", cmd: r.pick(["/start", "/stop", "/help", "STOP", "START", "stop", "Stop."] as const) };
  if (x < 0.91) return { t: "contact", own: r.next() < 0.5 };
  if (x < 0.97) return { t: "doc", family: r.pick(["pdf-resume", "not-resume", "png", "zip", "txt", "doc", "empty", "big-said", "huge-said", "huge-unsaid", "gif-doc"] as const) };
  return { t: "long", text: longText(r, "words") };
}
export function longText(r: R, how: LongScenario["how"]): string {
  const n = r.int(4001, 4096);
  const unit = how === "nospace" ? "数据分析😀" : how === "lines" ? `- ${r.pick(["Built dashboards in SQL and Tableau", "Led a team of 4 interns", "Cut report time by 30%"])}\n` : r.pick(["word ", "experience ", "नमस्ते ", "مرحبا ", "data😀 ", "👍🏽 "]);
  let s = how === "lines" ? "here is my resume:\nEXPERIENCE\n" : "";
  while (s.length < n) s += unit;
  s = s.slice(0, n);
  // never end in half a character (Telegram never sends one)
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xd800 && c <= 0xdbff) s = s.slice(0, -1) + "x";
  return s.length > 4000 ? s : s + "x".repeat(4001 - s.length);
}

// ------------------------------------------------------------------------------------------------ the generator
export function generate(o: { seed: number }): Scenario[] {
  const r = rng(o.seed);
  const out: Scenario[] = [];
  let id = 0;
  const chat = () => 880000000 + id;
  // conversations: 4,000
  for (let k = 0; k < 4000; k++) {
    id++;
    const lang = r.next() < 0.7 ? "en" : r.pick(["es", "hi", "ar"] as const);
    const start = r.next() < 0.6 ? "known" : r.next() < 0.5 ? "new-open" : "new-phone";
    const n = r.int(4, 14);
    const steps: Step[] = [];
    for (let i = 0; i < n; i++) steps.push(step(r, lang, i));
    const second = r.next() < 0.15 ? { chat: 990000000 + id, steps: Array.from({ length: r.int(2, 6) }, (_, i) => step(r, "en", i)) } : null;
    out.push({ kind: "conv", id, category: `conv/${start}/${lang}`, chat: chat(), start, lang, native: r.next() < 0.5, steps, second, alertAfter: r.next() < 0.6 });
  }
  // long messages: 600
  for (let k = 0; k < 600; k++) {
    id++;
    const how = r.pick(["plain", "forward", "words", "lines", "nospace"] as const);
    out.push({ kind: "long", id, category: `long/${how}`, chat: chat(), text: longText(r, how), how });
  }
  // Bot API realities: 3,000
  const api = (n: number, f: () => ApiCase) => { for (let k = 0; k < n; k++) { id++; const a = f(); out.push({ kind: "api", id, category: `api/${a.c}`, chat: chat(), a }); } };
  api(300, () => ({ c: "thread", private: r.next() < 0.7, thread: r.int(2, 9999) }));
  api(400, () => ({ c: "stale", op: r.pick(["details", "save", "apply", "confirm-old", "confirm-new", "next-old", "details-photo"] as const), noMessage: r.next() < 0.25 }));
  api(250, () => ({ c: "keyboard", postings: r.int(1, 14), feed: r.next() < 0.3 }));
  api(300, () => ({ c: "caption", titleLen: r.pick([20, 80, 160, 400, 1200]), fitLines: r.int(0, 30), photoFails: r.pick(["none", "none", "400-url", "400-type", "network"] as const) }));
  api(350, () => { const parts = r.int(1, 4); return { c: "parse400", parts, refuse: Array.from({ length: parts }, (_, i) => i).filter(() => r.next() < 0.4), native: r.next() < 0.8 }; });
  api(300, () => ({ c: "escape", amps: r.pick([0, 40, 120, 300, 900]), page: r.pick(["details", "apply"] as const), native: r.next() < 0.75 }));
  api(500, () => ({ c: "blocked", how: r.pick(["blocked", "deactivated"] as const), where: r.pick(["answer", "alert", "fixed", "parts"] as const), at: r.int(0, 2) }));
  api(150, () => ({ c: "notfound", where: r.pick(["answer", "alert"] as const) }));
  api(150, () => ({ c: "migrated", how: r.pick(["group-msg", "migrate-to", "migrate-from", "supergroup-topic"] as const) }));
  api(300, () => ({ c: "bigfile", size: r.pick([null, null, 10 * 1024 * 1024 + 1, 15_000_000, 20 * 1024 * 1024, 20 * 1024 * 1024 + 1, 52_428_800, 2_000_000_000]), getFile: r.pick(["ok", "too-big-400", "stream-over"] as const) }));
  // languages: 2,400
  for (let k = 0; k < 2400; k++) {
    id++;
    const lang = r.pick(["es", "hi", "ar"] as const);
    out.push({ kind: "lang", id, category: `lang/${lang}`, chat: chat(), lang, native: r.next() < 0.7, said: r.pick(LANG_TEXTS[lang]) + (r.next() < 0.3 ? ` ${r.pick(EMOJI_ONLY)}` : ""),
      reply: r.pick(LANG_REPLIES[lang]), long: r.pick([0, 0, 0, 1600, 3200, 5200]) });
  }
  return out;
}
