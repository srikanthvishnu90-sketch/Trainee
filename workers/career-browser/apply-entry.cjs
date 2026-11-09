"use strict";
// How a job page leads to its application form, shared by the cloud runner (parallel-apply.cjs) and the browser benchmarks
// (scripts/browser-eval/): the provider's own apply address one GET away, and the words of an Apply control (never a control
// that sends anything).
const APPLY_TEXT = /^\s*(apply|apply now|apply here|apply for (this|the) (job|position|role)|apply to (this )?(job|position|role)|apply manually|i['’]?m interested|start (your )?application|bewerben|jetzt bewerben|ansök( nu)?|ansøg( nu)?|søk( nå)?|solliciteer( nu)?|postuler|candidatar(-se|me)?|inscr[ií]bete|candidati)\s*[»>→]?\s*$/i;
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
    default: return null;
  }
}
module.exports = { APPLY_TEXT, NEVER_CLICK, applyUrlFor };
