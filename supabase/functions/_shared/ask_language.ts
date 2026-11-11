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
