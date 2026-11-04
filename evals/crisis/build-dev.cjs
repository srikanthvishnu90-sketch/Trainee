// Builds evals/crisis/corpus.dev.json: the phrasings the deterministic list is TUNED on (the unit test's two lists, the
// review's named misses, and dev-only variants). corpus.sealed.json is never used for tuning.
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../../tests/architect/distress-detector.test.ts"), "utf8");
const grab = (n) => eval("[" + src.match(new RegExp("const " + n + " = \\[([\\s\\S]*?)\\n\\];"))[1] + "]");
const named = ["i want to put a bullet in my head", "how to hang yourself", "best way to kill yourself painlessly", "i want to off myself",
  "i want to fucking die", "i want to kil myslf", "i want to kill mys3lf", "i'm gonna jump tonight", "i'm going to end things tonight",
  "i hope i die in my sleep", "how much ibuprofen kills you", "i'm in the bathtub with a razor", "voglio morire",
  // the #371/#406 review (2026-11-02): misses of the staged-brain crisisReply
  "I want to die", "stop, i want to die", "I wanna die", "I want to end it", "i wanna end it", "i want to end it all",
  "i wanna end it all", "i don't want to be here anymore", "i want to not be here", "i wanna not be here anymore", "stop. i wanna die",
  // the #406 re-review (2026-11-02): "rather die than" stays distress unless it is plainly a joke or a wanted thing
  "I'd rather die than go back to that job", "rather die than be unemployed", "id rather die than tell my parents",
  // the crisisReply review (2026-11-02): kms counts even with lol
  "i want to die", "im going to hurt myself", "i'm gonna hurt myself", "kms", "kms lol", "unalive myself", "sewerslide"];
const devOnly = ["1 w4nt t0 d13", "k i l l myself", "i want to fuckin end it", "i'm going to f***ing kill myself", "i wanna diiiie", "suuuicidal",
  "kill myslf", "gonna hang myslf", "plan to od tonight", "how to overdose on xanax", "how many pills to overdose", "painless suicide methods",
  "how to slit wrists", "i bought pills to end it", "i want to be dead", "i wish i could die", "let me die", "i'm gonna shoot myself tonight",
  "i'm going to hang tonight", "ending things this weekend", "i'll end things soon", "a bullet through my brain sounds good", "offing myself tonight",
  "how to kill yourself", "quickest way to kill myself", "how many xanax kills you", "the bathtub and a blade tonight", "i hope i die soon",
  "deadass wanna die", "on god i want to kill myself", "mi voglio uccidere", "voglio farla finita", "quero morrer", "quero me suicidar",
  "ik wil dood gaan", "ik denk aan zelfmoord", "chce sie zabic", "intihar etmek istiyorum", "aku pengen mati", "gusto kong magpakamatay",
  "mujhe marna hai", "aatmahatya karna chahta hoon", "хочу умереть", "думаю о самоубийстве", "死にたいです", "자살할래", "我真的想死",
  "أفكر في الانتحار", "toi muon chet", "jag vill inte leva längre"];
const careerDev = ["overdose of coffee before the interview lol", "i had an overdose of meetings today", "information overdose from this career fair",
  "i'm going to kill this presentation", "dying to start my new job", "shoot the recruiter a message", "bullet points for my resume",
  "i'm going to jump on that opening", "end things on a good note with my manager", "i hope i die laughing at my exit interview lol"];
const out = { note: "DEV: the deterministic list is tuned on these only.", crisis: [...grab("DISTRESS"), ...named, ...devOnly].map((t) => ({ t })),
  career: [...grab("CAREER"), ...careerDev].map((t) => ({ t })) };
fs.writeFileSync(path.join(__dirname, "corpus.dev.json"), JSON.stringify(out, null, 0) + "\n");
console.log(out.crisis.length, "crisis;", out.career.length, "career");
