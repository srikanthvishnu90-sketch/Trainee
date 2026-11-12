// MIRROR-1000 gaps (2026-11-11): is a chat message written mostly in a language other than English? The router's templates
// are English only, so a non-English ask that the router claimed from one English keyword ("cover letter" in Tagalog, "jobs"
// in a Spanish sentence, a French question read as a search) answered in English and often about something else. Such an
// ask is the brain's, which answers in the person's language (career_staged.ts). Payload and control turns stay code's.
//
// By code: a message in a non-Latin script (Devanagari, CJK, Hangul, Arabic, Cyrillic, Thai) is non-English; otherwise the
// function words of the common languages are counted against English's, on the words of the message.
const NON_LATIN = /[ऀ-ॿ぀-ヿ一-鿿가-힯؀-ۿЀ-ӿ฀-๿]/gu;
const FOREIGN = new Set([
  // shared by several Romance languages
  "en", "de", "la", "un", "se", "per", "da", "come", "tre", "puoi", "c'était", "très", "beaucoup",
  // Spanish
  "el", "los", "las", "del", "que", "para", "por", "pero", "todavía", "todavia", "quiero", "trabajo", "empleos", "empleo", "con", "una", "puedes", "ayudar", "ayúdame", "busco", "hola", "también", "apliques", "envíes", "mi", "mis", "como", "cómo", "qué", "sí", "gracias", "dónde", "pasantías",
  // French
  "le", "les", "des", "une", "pour", "poser", "quelles", "quels", "entretien", "je", "mon", "ma", "mes", "est", "sont", "avec", "dans", "sur", "vous", "pas", "ne", "bonjour", "merci", "d'un", "d'une", "l'entretien", "stage", "stages", "emploi", "lettre",
  // Portuguese
  "não", "nao", "uma", "você", "voce", "meu", "minha", "vaga", "vagas", "estágio", "obrigado", "currículo", "estou", "procurando", "em", "ou",
  // German
  "der", "die", "das", "und", "ich", "nicht", "mit", "ein", "eine", "für", "bitte", "stelle", "stellen", "bewerbung", "mein", "meine", "wie", "du", "meinen", "auf", "kannst", "nicht",
  // Italian
  "il", "gli", "della", "non", "sono", "lavoro", "colloquio", "domande", "fare", "mio", "mia", "grazie", "cerco", "mostrami", "ruolo",
  // Tagalog
  "mo", "ba", "ako", "akong", "sa", "ng", "ang", "mga", "pwede", "puwede", "bilang", "lang", "huwag", "ipadala", "tulungan", "trabaho", "kung", "naman", "po",
  // Hindi in Latin script
  "mera", "meri", "ka", "ke", "liye", "ko", "mat", "kisi", "bana", "karo", "hai", "nahi",
  // Polish, Vietnamese
  "jest", "nie", "dla", "jako", "tylko", "szukam", "pokaż", "się", "praca", "pracy", "tôi", "cho", "của", "việc", "làm", "không", "và",
]);
const ENGLISH = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "at", "with", "is", "are", "was", "be", "i", "i'm", "me", "my", "you", "your", "we", "it", "this", "that", "what", "how", "do", "don't", "can", "please", "want", "need", "find", "help", "show", "just", "any", "some", "about", "from", "should", "would", "will", "have", "has", "not", "no", "yes", "jobs", "roles", "so"]);

export function nonEnglishAsk(message: string): boolean {
  const m = String(message ?? "").normalize("NFC");
  const letters = (m.match(/\p{L}/gu) ?? []).length;
  if (letters && (m.match(NON_LATIN) ?? []).length / letters > 0.3) return true;
  const words = (m.toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}']+/gu) ?? []).map((w) => w.replace(/^'+|'+$/g, ""));
  const foreign = words.filter((w) => FOREIGN.has(w)).length, english = words.filter((w) => ENGLISH.has(w)).length;
  return foreign >= 3 && foreign > english;
}

// D-058 ruling 3 (architect, 2026-11-11, under the owner's "same length as Instinct"): a message that makes two asks goes to the
// model, which answers both; no splitting layer. Two asks are said by their own markers ("Two things. First, ... Second, ...",
// "1) ... 2) ...", "Quick pair of asks", "Then, unrelated:", "Also, separately:") or by a second request after a sentence end
// (". Also, draft ...", "; research Stripe ..."; "I only want media; find ..." is one ask). "Two things:" before a list of limits ("Two things: remote only, and ...") is one
// ask with two conditions, not two asks.
const TWO_ASK_MARKER = /\b(?:two things[.:]\s*(?:1\)|first\b)|quick pair of asks|pair of questions|then,?\s+unrelated\b|also,?\s+separately\b|separately:)|(?:^|[\s:])1\)\s[^]*?\s2\)\s/i;
const SECOND_REQUEST = /(?:[.?!]\s*|;\s*|,\s*and\s+)also,?\s+(?:draft|write|find|look|search|research|tell|give|show|send|log|track|prep|rework|any|what|which|is|are|can|could)\b/i;
// "X; research Stripe" is two asks only when X is itself a request ("rework my resume ...; research Stripe"): "They pay $26/hr at
// my job; draft a counter" is one ask with its context first.
const SEMI_SECOND = /;\s*(?:research|tell me about|draft|write|prep me)\b/i;
const REQUEST_HEAD = /^\s*(?:(?:please|can you|could you|pls)\s+)?(?:find|look|search|show|give|tell|draft|write|rework|tailor|update|edit|make|research|prep|send|list|check|fix|rewrite)\b|\?\s*$/i;
// D-061 G13 (several asks: answer each), the same markers, wider: a counted list whose items are split by a semicolon ("two
// things: X; and Y"), a second ask after "; and" or "and also", and two questions, each its own sentence. "Two things: remote
// only, and nothing under $35" (conditions, no semicolon) and "find X, also give me exactly 3" stay one ask.
const ASK_HEAD = String.raw`(?:what|what's|whats|which|how|is|are|can|could|should|do|does|did|have|has|will|would|when|where|who|why|draft|write|find|look|search|research|tell|give|show|send|log|track|prep|rework|make|list|check|fix|rewrite|help|explain)\b`;
const COUNTED_SEMI = new RegExp(String.raw`\b(?:two|2|three|3|couple(?:\s+of)?|few)\s+(?:things|questions|asks|q's|qs)\s*[:.,-]?\s*[^;]{3,}?;\s*(?:and\s+|also\s+|then\s+)?${ASK_HEAD}`, "i");
const AND_SECOND = new RegExp(String.raw`;\s*and\s+(?:also\s+)?${ASK_HEAD}|\band also,?\s+${ASK_HEAD}|(?:[,.;:!?—-]\s*|\s)(?:oh and|btw|one more thing|another thing|separate question|unrelated)[,:]?\s+(?:can you\s+|could you\s+|also\s+)?${ASK_HEAD}`, "i");
const QUESTION_SENTENCE = new RegExp(String.raw`^(?:(?:and|also|plus|oh|ok|so)[,\s]+)?${ASK_HEAD}[^?]{6,}\?$`, "i");
const twoQuestions = (t: string) => t.split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter((x) => QUESTION_SENTENCE.test(x)).length >= 2;
// D-061 G13: D-058's markers, or the wider ones above. The handler and the brain's note read this; the staged route's
// "multi_part" reason keeps D-058's own reading (multiAsk), and the wider reading reaches the brain through g1CodeAnswers.
export function severalAsks(message: string): boolean {
  const t = String(message ?? "").replace(/[’]/g, "'");
  return multiAsk(t) || COUNTED_SEMI.test(t) || AND_SECOND.test(t) || twoQuestions(t);
}
export function multiAsk(message: string): boolean {
  const t = String(message ?? "").replace(/[’]/g, "'");
  if (TWO_ASK_MARKER.test(t) || SECOND_REQUEST.test(t)) return true;
  const semi = SEMI_SECOND.exec(t);
  return !!semi && REQUEST_HEAD.test(t.slice(0, semi.index));
}
