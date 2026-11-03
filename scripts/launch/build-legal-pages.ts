// Google verification (2026-10-26, review of PR #196): the legal pages are published only when every owner input is
// filled. The templates live outside site/ (docs/launch/legal-pages/*.template.html), so nothing with a placeholder is
// ever served. This build:
//   1. reads the owner's inputs (docs/launch/legal-pages/owner-inputs.json, or --inputs <file>) and refuses, naming each
//      one, while any is missing, empty or not the right shape (SUPPORT_EMAIL must be one email address);
//   2. fills the templates and refuses, naming it, if ANY placeholder or template note is left in what it would write: a
//      {{PLACEHOLDER}}, a [Bracketed instruction], or a note such as "Template. Only publish claims...". The homepage's
//      unfinished sections are removed or rewritten to what is true (patchHome); none is filled with an invented fact;
//   3. writes privacy.html, terms.html and google.html (the pre-consent notice, from _shared/google_scopes.ts
//      consentNotice) and the homepage with its legal links pointed at them (index.html), into site/ or --out <dir>.
// Run: deno run -A scripts/launch/build-legal-pages.ts [--inputs file.json] [--out dir]
// Exit 1 and nothing written on any refusal. tests/architect/google-verification.test.ts runs it both ways.
import { consentNotice, EMAIL, GMAIL_READONLY, OPENID } from "../../supabase/functions/_shared/google_scopes.ts";

export const OWNER_INPUTS = ["LEGAL_NAME", "SUPPORT_EMAIL", "GOVERNING_STATE"] as const;
export type OwnerInputs = Record<(typeof OWNER_INPUTS)[number], string>;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/g;

// The missing or malformed inputs, by name; empty when every one is usable.
export function missingInputs(raw: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  for (const k of OWNER_INPUTS) {
    const v = raw?.[k];
    if (typeof v !== "string" || !v.trim() || /[{}<>]/.test(v)) out.push(k);
    else if (k === "SUPPORT_EMAIL" && !EMAIL_RE.test(v.trim())) out.push(k);
  }
  return out;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function fill(template: string, inputs: OwnerInputs): string {
  return template.replace(PLACEHOLDER, (m) => {
    const k = m.slice(2, -2) as keyof OwnerInputs;
    return k in inputs ? escHtml(inputs[k].trim()) : m;
  });
}
// Anything that is template text rather than a published page: {{NAME}}, [Bracketed instruction or value] (an uppercase
// word then more words, or an all-caps tag such as [DATE] or [YOUR PRICE]; code like [A-Z] or [0] is neither), the
// "Template." / "Template only." notes of any wording, and filler such as lorem ipsum or any @example.com/.org/.net address.
const LEFTOVERS: RegExp[] = [
  PLACEHOLDER,
  /\[(?:[A-Z][^\[\]<>\n]* [^\[\]<>\n]*|[A-Z]{3,}(?: [A-Z]+)*)\]/g,
  /\bTemplate(?: only)?\.[^<`]*/g,
  /lorem ipsum/gi,
  /[A-Za-z0-9._%+-]+@example\.(?:com|org|net|test)\b/gi,
];
export function placeholdersIn(html: string): string[] {
  const text = html.replace(/<svg[\s\S]*?<\/svg>/g, "");
  return [...new Set(LEFTOVERS.flatMap((re) => text.match(new RegExp(re.source, re.flags)) ?? []))];
}

// The public copy of the words shown before Google's consent screen, with the privacy page's head and footer.
export function buildNoticePage(privacy: string): string {
  const n = consentNotice([OPENID, EMAIL, GMAIL_READONLY], { modelCheck: true });
  const li = (xs: string[]) => xs.map((x) => `    <li>${escHtml(x)}</li>`).join("\n");
  const head = privacy.split('<main class="policy">')[0]
    .replace("<title>Privacy Policy — Trainee</title>", "<title>Connecting Gmail — Trainee</title>")
    .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="What Trainee reads in Gmail, what it never does, and how to disconnect.">');
  const foot = "</main>" + privacy.split("</main>")[1];
  return `${head}<main class="policy">
  <h1>${escHtml(n.title)}</h1>
  <p class="updated muted">What Trainee reads in Gmail, what it never does, and how to undo it. Last updated: October 26, 2026</p>
  <h2>What Trainee will read</h2>
  <ul>
${li(n.reads)}
  </ul>
  <h2>What Trainee never does</h2>
  <ul>
${li(n.never)}
  </ul>
  <h2>How to undo it</h2>
  <ul>
${li(n.undo)}
  </ul>
  <p>Connecting is optional: without it you type an emailed code yourself and tell Trainee how an application went. The full details are in the <a href="/privacy#google">Privacy Policy</a>.</p>
${foot}`;
}

// The tour and the home conversations (review of #196, round 3). Each line is something the product does: the job read,
// the resume tailored from confirmed facts, an application prepared and shown as the exact card the person approves, a
// status said only when the product sees it (the employer's confirmation email, through read-only Gmail), notes drafted
// from the person's own contacts, alerts, interview practice. No counts of roles, applications, people or replies.
const TOUR = `var TOUR = [
  { title:'Reads the job', slug:'job-breakdown',
    desc:'Send any job link. Trainee pulls out what the role really cares about, compares it with your background, and flags gaps before you apply.',
    bullets:['Plain-English breakdown of every post','Your fit, against the role','Gaps flagged before you apply'],
    thread:[
      {f:'stamp', t:'Today 9:41 AM'},
      {f:'me', t:'is this one worth applying to?'},
      {f:'card', side:'me', icon:'link', title:'Summer Analyst, M&A – Chicago', sub:'boards.greenhouse.io'},
      {f:'you', t:'yes. they care most about financial modeling and deal experience'},
      {f:'you', t:'your internship covers both. one gap: they list Excel VBA'},
      {f:'you', t:'want me to frame your automation project around it?'},
      {f:'me', t:'do it'}
    ]},
  { title:'Tailors your resume', slug:'resume',
    desc:'A fresh version of your resume for every role. Trainee moves the right experience to the top and matches the post’s language, using only what you’ve actually done.',
    bullets:['A new version per application','Nothing made up, ever','Every version saved'],
    thread:[
      {f:'me', t:'tailor my resume for the M&A role'},
      {f:'you', t:'done. moved your valuation work to the top and tightened every bullet'},
      {f:'card', side:'you', icon:'file-pdf', title:'Resume – M&A Analyst.pdf', sub:'PDF Document · 1 page'},
      {f:'me', t:'this is so much better'}
    ]},
  { title:'Applies for you', slug:'applying',
    desc:'Tell Trainee what you want. It prepares each application and shows you exactly what it will send; nothing goes until you say yes.',
    bullets:['You approve the exact answers','Fills the forms and short answers','Tracks every application'],
    thread:[
      {f:'me', t:'apply to summer analyst roles in Chicago'},
      {f:'you', t:'this one fits. here is exactly what I’ll send'},
      {f:'card', side:'you', icon:'check-circle', title:'Summer Analyst – Chicago', sub:'Your answers and resume, ready to approve'},
      {f:'me', t:'yes'},
      {f:'you', t:'submitted. I’ll tell you when the employer’s confirmation email arrives'}
    ]},
  { title:'Coffee chat notes', slug:'coffee-chats',
    desc:'Send Trainee your contacts. It tells you who you know at the firms you want and drafts a personal note to each for you to review and send.',
    bullets:['Works from your own contacts','Personal drafts, in your words','You review and send every note'],
    thread:[
      {f:'me', t:'who do I know at Stripe?'},
      {f:'you', t:'from the contacts you sent me: Jordan, an analyst on the finance team'},
      {f:'me', t:'write Jordan about the analyst role'},
      {f:'you', q:true, t:'“Hi Jordan, I’m a finance student and just applied to your team’s analyst program…”'},
      {f:'you', t:'here’s the draft. edit it, then copy it into your own email when you’re happy with it'}
    ]},
  { title:'Sends job alerts', slug:'job-alerts',
    desc:'Trainee keeps watching after you close the chat, and texts you when a role you’d actually want goes live.',
    bullets:['Matches what you told it','Texts you when it goes live','Pause or change alerts by text'],
    thread:[
      {f:'stamp', t:'Mon 7:02 AM'},
      {f:'you', t:'a new role just went live. strong match'},
      {f:'card', side:'you', icon:'briefcase', title:'Corporate Finance Analyst – Chicago', sub:'jobs.lever.co'},
      {f:'you', t:'want me to prepare the application?'},
      {f:'me', t:'yes!!'},
      {f:'you', t:'ready. check what I’ll send and say yes'}
    ]},
  { title:'Preps your interviews', slug:'interview-prep',
    desc:'Real practice for the real interview. Trainee asks the questions you’ll likely face for that role and firm, and gives honest feedback on every answer.',
    bullets:['Behavioral and technical questions','Built from the role and firm','Honest feedback, by text'],
    thread:[
      {f:'me', t:'superday tomorrow. prep me'},
      {f:'you', t:'let’s practice in the real format. first one: walk me through a DCF'},
      {f:'me', t:'project free cash flows, discount them at WACC, add a terminal value'},
      {f:'you', t:'solid start. say which terminal value method you’d use and why'},
      {f:'you', t:'next: why us over the other banks?'}
    ]}
];
`;
const THREADS = `var THREADS = {
  hero: [
    {f:'stamp', t:'Today 9:41 AM'},
    {f:'you', t:'Hey, I’m Trainee, your personal career agent'},
    {f:'you', t:'I find jobs, tailor your resume, prepare your applications and draft coffee chat notes. all by text'},
    {f:'me', t:'wait, you can do all that?'},
    {f:'you', t:'yep. send me your resume and tell me what you’re looking for'},
    {f:'me', t:'let’s do it'}
  ],
  intro: [
    {f:'stamp', t:'Today 9:41 AM'},
    {f:'me', t:'hey Trainee, help me land a summer analyst role'},
    {f:'you', t:'on it. send me your resume and where you want to be'},
    {f:'card', side:'me', icon:'file-pdf', title:'Resume.pdf', sub:'PDF Document · 1 page'},
    {f:'me', t:'Chicago or NYC, banking or corporate finance'},
    {f:'you', t:'here are the roles that fit best so far. want a tailored resume for each?'},
    {f:'me', t:'yes please'},
    {f:'you', t:'on it. I’ll show you each application before anything is sent'}
  ]
};
`;

// The homepage's legal links and help pages, pointed at the published pages. Each edit must find its text exactly once
// (a homepage that moved on fails the build instead of shipping half-edited).
//
// `inputs` null is the interim build (live-site fixes, 2026-11-03): the owner has not given LEGAL_NAME, SUPPORT_EMAIL and
// GOVERNING_STATE, so no Trainee privacy or terms page exists. Everything that needs one of them is removed, not guessed: the
// Privacy and Terms help pages and their links, every support and careers mailto, and the owner-only sections cut below.
export function patchHome(home: string, inputs: OwnerInputs | null): string {
  let s = inputs ? home.replaceAll('href="#product/privacy"', 'href="/privacy"').replaceAll('href="#product/terms"', 'href="/terms"') : home;
  const once = (from: string, to: string) => {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`homepage: expected one "${from.slice(0, 60)}", found ${n}`);
    s = s.replace(from, to);
  };
  const i = s.indexOf("{ slug:'privacy', group:'Trust & Legal'"), k = s.indexOf("{ slug:'sms-terms', group:'Trust & Legal'");
  if (i < 0 || k < i) throw new Error("homepage: the privacy and terms help pages were not found");
  s = s.slice(0, i) + (inputs ? `{ slug:'privacy', group:'Trust & Legal', title:'Privacy Policy',
  desc:'What we collect, why, and the choices you have.',
  html:\`
<p>Trainee's Privacy Policy, including how it uses data from a Google account you connect (Google API Services User Data Policy, Limited Use), is at <a href="/privacy">/privacy</a>.</p>
<p>What Trainee reads in Gmail, before you connect it: <a href="/google">/google</a>.</p>\`},

{ slug:'terms', group:'Trust & Legal', title:'Terms of Service',
  desc:'The rules for using Trainee.',
  html:\`
<p>Trainee's Terms of Service are at <a href="/terms">/terms</a>.</p>\`},

` : "") + s.slice(k);
  once("<p>[Describe encryption in transit and at rest, where data is hosted, and who on your team can access it.]</p>",
    "<p>Information is sent over encrypted connections. Each person can read only their own records, and the tokens of accounts you connect are kept in an encrypted secret store that only Trainee's servers use.</p>");
  once("<p>[Describe how connections are authorized, for example through OAuth, and that passwords are never stored.]</p>",
    "<p>Google is connected on Google's own page, so Trainee never sees your Google password. Saying \"disconnect gmail\" revokes Trainee's access at Google and deletes what it kept. See <a href=\"/google\">what Trainee reads in Gmail</a>.</p>");
  if (inputs) once("supportEmail: 'support@example.com',", `supportEmail: '${inputs.SUPPORT_EMAIL.trim().replace(/'/g, "")}',`);
  else once("    supportEmail: 'support@example.com',\n    careersEmail: 'careers@example.com',\n", "");
  // Unused sample numbers (nothing reads them); the WhatsApp button pointed at Twilio's shared sandbox ("join basic-rocket"),
  // which is not Trainee's number, so it goes in both builds.
  once("    agentNumber: '+10000000000',      // the number your agent texts from (E.164)\n    agentNumberPretty: '+1 (000) 000-0000',\n", "");
  // Review of #196, blocker 1: nothing the owner still has to write ships. Each piece below is a section of template text
  // (a price, a launch date, a founder story, a bio): it is removed, never filled in with a guess. Add it back when the
  // owner has the real words; the build then refuses nothing, because nothing is left to refuse.
  const cut = (marker: string, start: string, end: string) => { // the block from `start` (before marker) to `end`, once
    const m = s.split(marker).length - 1;
    if (m !== 1) throw new Error(`homepage: expected one "${marker.slice(0, 60)}", found ${m}`);
    const at = s.indexOf(marker), a = s.lastIndexOf(start, at), b = s.indexOf(end, at);
    if (a < 0 || b < 0) throw new Error(`homepage: the block around "${marker.slice(0, 60)}" was not found`);
    s = s.slice(0, a) + s.slice(b + end.length);
  };
  { // the hero button (inline, after the Telegram one, with the comment that promised its return) and the "Start chatting" one
    const h = s.indexOf(' <a href="https://wa.me/14155238886'), he = s.indexOf("Chat on WhatsApp</a>", h);
    if (h < 0 || he < 0 || s.split("wa.me/14155238886").length !== 3) throw new Error("homepage: the two WhatsApp buttons were not found");
    s = s.slice(0, h) + s.slice(he + "Chat on WhatsApp</a>".length);
    once("          <!-- WHATSAPP BUTTON: restored with the real sandbox link when the Twilio setup lands -->\n", "");
    cut("wa.me/14155238886", "        <a href=", "</a>\n");
  }
  cut("[Launch timing]", "        <details>", "</details>\n");
  cut("[YOUR PRICE]. Cancel anytime.", "        <details>", "</details>\n");
  cut("[Paragraph 1:", '  <section class="dark">', "  </section>\n");
  cut("[Your name]", '  <section class="dark">', "  </section>\n");
  once('  <section class="light">\n    <div class="wrap section">\n      <div class="head center reveal"><h2>What we believe</h2>',
    '  <section class="dark">\n    <div class="wrap section">\n      <div class="head center reveal"><h2>What we believe</h2>'); // keeps the light/dark rhythm
  cut("slug:'pricing', group:'Account'", "{ slug:'pricing'", "</tbody></table></div>\n<h2>Canceling</h2>\n<p>Text <code>cancel plan</code> to Trainee or email support. You keep access until the end of your billing period.</p>`},\n\n");
  once('<div class="note"><i class="ph" aria-hidden="true"><svg class="ic"><use href="#i-warning"/></svg></i><p>Template. Only publish claims that are true of your actual systems.</p></div>\n', "");

  // Review of #196, blocker 2: what the pages say Trainee can do with Google is what the submitted scopes allow (openid,
  // email, gmail.readonly): it reads application mail, it cannot send, and it has no Calendar. The Connections help page
  // is rewritten to that, and the sending and booking claims elsewhere are made true of drafts.
  const a = s.indexOf('<div class="note"><i class="ph" aria-hidden="true"><svg class="ic"><use href="#i-info"/></svg></i><p>[Confirm which connections'), endTag = "tell Trainee to disconnect anything at any time.</p>";
  const b = s.indexOf(endTag, a);
  if (a < 0 || b < 0 || s.split("[Confirm which connections").length !== 2) throw new Error("homepage: the Connections help page was not found");
  const seg = s.slice(a, b + endTag.length), g = seg.indexOf("Gmail</span>");
  if (g < 0) throw new Error("homepage: the Gmail logo on the Connections help page was not found");
  const gmail = seg.slice(seg.indexOf("<span>"), g + "Gmail</span>".length);
  s = s.slice(0, a) + `<h2>Gmail</h2>
<div class="brands">${gmail}</div>
<p>Connect Gmail so Trainee can read the emails that matter to your applications and update your tracker. The permission is read-only: Trainee can't send, delete, label or change any email. What it reads and keeps is listed in the <a href="/google">notice shown before you connect</a> and in the <a href="/privacy#google">Privacy Policy</a>.</p>
<h2>Disconnecting</h2>
<p>Say <code>disconnect gmail</code> to Trainee. It revokes Trainee's access at Google and deletes the stored access and what it saved from your Gmail. You can also remove Trainee yourself at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>` + s.slice(b + endTag.length);
  once("desc:'Link the accounts Trainee needs to act for you. Everything is optional and can be disconnected.',", "desc:'Connect Gmail so Trainee can track your application emails. It is optional and you can disconnect it at any time.',");
  // Review of #196 (round 3): the homepage says only what the product does.
  //   - No "Works across the tools you already use" strip: LinkedIn, Handshake, Indeed, Outlook and Calendar are not
  //     connected, and automating LinkedIn or Indeed is forbidden.
  //   - Coffee chats work from the contacts the person gives Trainee (career_networking.ts: no people database and no
  //     email finder, by decision D-018a); notes are drafts the person reviews and sends.
  //   - The tour and the home conversations claim no results the product cannot show (no "all 24 sent", no "3 under
  //     review", no counts at all): Trainee prepares, the person approves the exact card, and a status is said only as the
  //     product observes it.
  cut('<p class="muted">Works across the tools you already use</p>', '    <div class="wrap logos reveal">', "      </div>\n    </div>\n");
  const block = (start: string, end: string, to: string) => { // replaces the one block from `start` through `end`
    if (s.split(start).length !== 2) throw new Error(`homepage: expected one "${start.slice(0, 40)}"`);
    const i = s.indexOf(start), j = s.indexOf(end, i);
    if (j < 0) throw new Error(`homepage: the end of "${start.slice(0, 40)}" was not found`);
    s = s.slice(0, i) + to + s.slice(j + end.length);
  };
  block("var TOUR = [", "\n];\n", TOUR);
  block("var THREADS = {", "\n};\n", THREADS);
  once("{ slug:'coffee-chats', group:'Features', title:'Books coffee chats',\n  desc:'Trainee finds the right people at the firms you want and writes to them for you.',",
    "{ slug:'coffee-chats', group:'Features', title:'Coffee chat notes',\n  desc:'Trainee tells you who you know at the firms you want and drafts a note to each for you to review.',");
  once('data-label="Books coffee chats video"', 'data-label="Coffee chat notes video"');
  once("<p>Trainee looks for alumni and team members at the companies you’re targeting, drafts a short personal note to each, sends them from your own email once you approve, and helps book the time when they reply.</p>",
    "<p>Trainee works from the contacts you give it: send your LinkedIn connections export (LinkedIn: Settings, Data privacy, Get a copy of your data, Connections) or paste rows like Name,Company,Title,Email. Ask who you know at a firm, and Trainee drafts a short personal note to each of them for you to review and send yourself. It has no people database and never guesses names or email addresses.</p>");
  once("<ul><li>Finds alumni and team members</li><li>Personal emails, sent from you</li><li>One polite follow-up, then books the time</li></ul>",
    "<ul><li>Works from your own contacts</li><li>Personal drafts, in your words</li><li>You review and send every note</li></ul>");
  once("<p>Text Trainee: <code>find alumni at the firms I applied to</code></p>", "<p>Text Trainee: <code>who do I know at Stripe</code></p>");
  { // "lines up coffee chats" (meta description, social card, hero): Trainee drafts the notes; it books nothing.
    const n = s.split("lines up coffee chats").length - 1;
    if (n !== 3) throw new Error(`homepage: expected three "lines up coffee chats", found ${n}`);
    s = s.replaceAll("lines up coffee chats", "drafts coffee chat notes");
  }
  once("applies, sets up coffee chats and preps you for interviews.", "applies when you say yes, drafts coffee chat notes and preps you for interviews.");
  once("it reads job posts, tailors your resume, applies for you, finds people to talk to, and gets you ready for interviews.", "it reads job posts, tailors your resume, prepares applications for your yes, drafts notes to people you know, and gets you ready for interviews.");
  once('<strong>Books coffee chats</strong><span>Finds people and writes the email.</span>', "<strong>Coffee chat notes</strong><span>Drafts notes to people you know.</span>");
  // Round 3, item 1: no example address anywhere. Applications for jobs at Trainee go to the support address the owner gave;
  // the sign-up field's hint is words, not an address.
  if (inputs) once("careersEmail: 'careers@example.com',", `careersEmail: '${inputs.SUPPORT_EMAIL.trim().replace(/'/g, "")}',`);
  once('placeholder="you@example.com"', 'placeholder="Your email"');
  once('<div class="note"><i class="ph" aria-hidden="true"><svg class="ic"><use href="#i-warning"/></svg></i><p>Template. Carriers review this page when you register your texting number, so keep it accurate.</p></div>\n', "");
  if (!inputs) interim(once, cut);
  return s;
}

// The part of the interim build that needs no owner input: the pages and links that would point at a Trainee privacy policy,
// terms or support address that does not exist yet are taken out. Each edit must find its text exactly once.
function interim(once: (from: string, to: string) => void, cut: (marker: string, start: string, end: string) => void): void {
  cut('id="careersMail"', '  <section class="dark center">', "  </section>\n"); // "Email us" (careers address)
  once("  $('careersMail').href = 'mailto:' + C.careersEmail;\n", "");
  once("      <a href=\"#product/privacy\">Privacy</a>\n      <a href=\"#product/terms\">Terms</a>\n", "");
  once('See the <a href="#product/sms-terms">SMS Terms</a>, <a href="#product/terms">Terms</a> and <a href="#product/privacy">Privacy Policy</a>.', 'See the <a href="#product/sms-terms">SMS Terms</a>.');
  once("<h2>Reporting a problem</h2>\n<p>Email <a class=\"js-support\" href=\"#\">support</a> to report a security concern.</p>", "<h2>Reporting a problem</h2>\n<p>Text <code>HELP</code> to Trainee and say it is a security concern.</p>");
  once("<p>Text <code>HELP</code> for help, or contact <a class=\"js-support\" href=\"#\">support</a>.</p>", "<p>Text <code>HELP</code> for help.</p>");
  once("<h2>Privacy</h2>\n<p>See our <a href=\"#product/privacy\">Privacy Policy</a>.</p>", "");
  once("<h2>Email</h2>\n<p>Email <a class=\"js-support\" href=\"#\">our support team</a> with your name and the phone number you signed up with.</p>\n", "");
  once("If it still doesn't work, email support.", "If it still doesn't work, text <code>HELP</code> to Trainee.");
  once("<h3>How do I delete my data?</h3>\n<p>Email support and we'll delete your account and data. See the <a href=\"#product/privacy\">Privacy Policy</a>.</p>", "");
  // The Gmail pages the full build publishes (/google, /privacy#google) do not exist in the interim build.
  once(' What it reads and keeps is listed in the <a href="/google">notice shown before you connect</a> and in the <a href="/privacy#google">Privacy Policy</a>.', "");
  once(' See <a href="/google">what Trainee reads in Gmail</a>.', "");
  once("desc:'We usually reply within one business day.',", "desc:'How to get help with Trainee.',");
}

export interface Built { files: Record<string, string> }
export function buildLegal(raw: Record<string, unknown> | null, t: { privacy: string; terms: string; home: string }): { ok: true; built: Built } | { ok: false; missing: string[]; left: string[] } {
  const missing = missingInputs(raw);
  if (missing.length) return { ok: false, missing, left: [] };
  const inputs = Object.fromEntries(OWNER_INPUTS.map((k) => [k, String(raw![k])])) as OwnerInputs;
  const privacy = fill(t.privacy, inputs), terms = fill(t.terms, inputs);
  const files = { "privacy.html": privacy, "terms.html": terms, "google.html": buildNoticePage(privacy), "index.html": patchHome(t.home, inputs) };
  const left = Object.values(files).flatMap(placeholdersIn);
  if (left.length) return { ok: false, missing: [], left: [...new Set(left)] };
  return { ok: true, built: { files } };
}

// The homepage with nothing the owner still has to supply (no legal pages, no support address). Refuses on any leftover.
export function buildInterim(home: string): { ok: true; html: string } | { ok: false; left: string[] } {
  const html = patchHome(home, null), left = placeholdersIn(html);
  return left.length ? { ok: false, left } : { ok: true, html };
}

if (import.meta.main) {
  const arg = (n: string) => { const i = Deno.args.indexOf(n); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const root = new URL("../../", import.meta.url);
  const src = new URL("docs/launch/legal-pages/", root);
  const inputsPath = arg("--inputs") ?? new URL("owner-inputs.json", src).pathname;
  const out = arg("--out") ?? new URL("site/", root).pathname;
  if (Deno.args.includes("--interim")) { // deno run -A scripts/launch/build-legal-pages.ts --interim  -> site/index.html only
    const r = buildInterim(Deno.readTextFileSync(new URL("home.template.html", src)));
    if (!r.ok) { console.error(`REFUSED: placeholders left: ${r.left.join(", ")}. Nothing was written.`); Deno.exit(1); }
    Deno.writeTextFileSync(`${out.replace(/\/$/, "")}/index.html`, r.html);
    console.log(`wrote index.html (interim, no owner inputs) to ${out}`);
    Deno.exit(0);
  }
  let raw: Record<string, unknown> | null = null;
  try { raw = JSON.parse(Deno.readTextFileSync(inputsPath)); } catch (e) { console.error(`cannot read ${inputsPath}: ${(e as Error).message}`); }
  const r = buildLegal(raw, {
    privacy: Deno.readTextFileSync(new URL("privacy.template.html", src)),
    terms: Deno.readTextFileSync(new URL("terms.template.html", src)),
    home: Deno.readTextFileSync(new URL("home.template.html", src)),
  });
  if (!r.ok) {
    if (r.missing.length) console.error(`REFUSED: owner inputs missing or invalid: ${r.missing.join(", ")} (in ${inputsPath}). Nothing was written.`);
    if (r.left.length) console.error(`REFUSED: placeholders left after filling: ${r.left.join(", ")}. Nothing was written.`);
    Deno.exit(1);
  }
  for (const [name, html] of Object.entries(r.built.files)) Deno.writeTextFileSync(`${out.replace(/\/$/, "")}/${name}`, html);
  console.log(`wrote ${Object.keys(r.built.files).join(", ")} to ${out}`);
}
