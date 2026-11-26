"use strict";
// How a job page leads to its application form, shared by the cloud runner (parallel-apply.cjs) and the browser benchmarks
// (scripts/browser-eval/): the provider's own apply address one GET away, and the words of an Apply control (never a control
// that sends anything).
// D-072 (item 4, round 2): the words boards' Apply controls use in the languages of the samples (strict run 43276162667: Teamtailor
// "Søk på denne stillingen", "Ansøg om dette job", "Reageer op deze vacature", "Apply here!", Personio "Solicitar este puesto de
// trabajo"), a trailing "!" or arrow allowed. Never a word that sends (NEVER_CLICK still wins).
const APPLY_TEXT = new RegExp("^\\s*(" + [
  "apply", "apply now", "apply here", "apply for (this|the) (job|position|role|vacancy)", "apply to (this )?(job|position|role)", "apply manually",
  "apply for this job now", "apply in \\d+ (seconds|minutes)", "quick apply", "i['’]?m interested", "start (your |my )?application",
  // German
  "bewerben", "jetzt bewerben", "(auf )?diese stelle bewerben", "f[üu]r diese stelle bewerben", "online bewerben", "hier bewerben", "zur bewerbung", "bewerbung starten",
  // Swedish, Norwegian, Danish, Finnish
  "ansök( nu| här)?", "sök (tjänsten|jobbet)", "ansök (till|om) (tjänsten|jobbet)",
  "søk( nå| her)?", "søk (på )?(denne )?stillingen", "søk på denne stillingen", "søk uten søknadsbrev",
  "ansøg( nu| her)?", "ansøg om (dette|denne) (job|stilling)", "ansøg (stillingen|jobbet)", "søg (stillingen|jobbet)( nu)?",
  "hae( nyt)?", "hae (tätä )?(paikkaa|työpaikkaa)",
  // Dutch, French, Spanish, Portuguese, Italian, Polish, Czech, Baltic
  "solliciteer( nu| direct)?", "solliciteren", "reageer( nu| direct)?", "reageer op deze vacature",
  "postuler", "postuler maintenant", "je postule", "postulez", "candidater",
  "solicitar( empleo| ahora)?", "solicitar este (puesto|empleo|trabajo)( de trabajo)?", "aplicar( ahora)?", "inscr[ií]bete", "post[uú]late",
  "candidatar(-se|me)?", "candidate-se",
  "candidati( ora)?", "candidatura",
  "aplikuj( teraz)?", "odpovědět", "mám zájem", "kandideeri", "pieteikties", "kandidatuoti",
].join("|") + ")\\s*[!»>→]*\\s*$", "i");
const NEVER_CLICK = /submit|send|senden|absenden|envoyer|enviar|verzenden|skicka|finish|complete|confirm/i;
// Where a provider's application form lives, one GET away from the posting page (null: follow the page's own Apply link).
function applyUrlFor(provider, landed) {
  let u;
  try { u = new URL(landed); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, "");
  switch (provider) {
    case "lever": return /^\/[^/]+\/[0-9a-f-]{36}$/i.test(p) ? `${u.origin}${p}/apply` : null;
    case "ashby": return /^\/[^/]+\/[0-9a-f-]{36}$/i.test(p) ? `${u.origin}${p}/application` : null;
    case "breezy": return /^\/p\/[^/]+$/.test(p) ? `${u.origin}${p}/apply` : null;
    case "workable": return /^\/[^/]+\/j\/[A-Z0-9]+$/i.test(p) ? `${u.origin}${p}/apply/` : null;
    case "recruitee": return /^\/o\/[^/]+$/.test(p) ? `${u.origin}${p}/c/new` : null;
    // D-072: Workday's form is behind "Apply" then "Apply Manually" (strict run 43192269304: 76 of 80 postings stopped with no form
    // found because the two links lead to different addresses). Its own address: the posting's path + /apply/applyManually, which
    // draws the employer's account sign-in or create-account page (a wall the person finishes) or the form.
    case "workday": return /\/job\/.+_[A-Za-z0-9-]+$/.test(p) && !/\/apply(\/|$)/.test(p) ? `${u.origin}${p}/apply/applyManually` : null;
    default: return null;
  }
}
// D-072 (item 4, round 2): Teamtailor's own Apply control, by what it does rather than its words: a button outside every form whose
// declared action opens the application form's overlay (data-action "click->careersite--jobs--form-overlay#showFormOverlay"; every
// Teamtailor page of the 2026-11-12 capture, in Swedish, Norwegian, Danish, Spanish, Lithuanian and English). Its words may be
// "Skicka ansökan" / "Enviar solicitud" ("send application"): pressing it only draws the empty form (nothing has been typed, and a
// control outside a form submits nothing). Any other control still needs the Apply words and never the NEVER_CLICK words.
// SmartRecruiters' Apply link by its id and its target (#st-apply, to the board's own /oneclick-ui/ form), whatever its words ("Me
// interesa", "Je suis intéressé(e)", "我要應徵": 2026-11-12 capture); a disabled #st-apply button is a closed posting, never clicked.
const OVERLAY_APPLY = "button[data-action*='form-overlay#showFormOverlay'], [role=button][data-action*='form-overlay#showFormOverlay'], a#st-apply[href*='/oneclick-ui/']";
// A posting the board itself says is closed, read from its own page when no form is found (2026-11-12 capture): Workday's
// "page you are looking for doesn't exist" (data-automation-id invalid-content), SmartRecruiters' disabled #st-apply ("Sorry, this
// job has expired"), Breezy's "Position Closed", and the same words elsewhere.
const CLOSED_MARK = "[data-automation-id='invalid-content'], button#st-apply[disabled], #st-apply.is-disabled";
const CLOSED_TEXT = /\b(?:position closed|no longer accepting (?:candidates|applications)|this job has expired|this job is no longer available|job (?:posting )?(?:is )?(?:closed|expired)|the page you are looking for doesn['’]t exist|stellenanzeige ist abgelaufen|diese stelle ist (?:leider )?nicht mehr verf[üu]gbar|esta oferta (?:ya )?no est[áa] disponible|cette offre n['’]est plus disponible)\b/i;
module.exports = { APPLY_TEXT, NEVER_CLICK, OVERLAY_APPLY, CLOSED_MARK, CLOSED_TEXT, applyUrlFor };
