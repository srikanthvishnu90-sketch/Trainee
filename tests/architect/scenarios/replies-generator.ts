// What comes back after an outreach email is sent, at scale (owner rules, 2026-10-29): a deterministic, seeded generator of
// the messages that land on the thread of a sent outreach email, each with what it must do.
//
//   bounce   a permanent failure notice from a mail system (Gmail, Outlook.com, Exchange NDRs, Yahoo, AOL, Postfix,
//            Sendmail, Exim, qmail, generic). Includes a final failure for a full mailbox or a remote server that kept
//            refusing: Gmail has stopped trying, so it is a bounce (never retried; decided conservatively, documented in
//            career_send_rail.ts deliveryNotice).
//   delay    a delivery-delay warning ("Delivery Status Notification (Delay)", "Delivery delayed:", "Delayed Mail (still
//            being retried)", "Warning: could not send message for past 4 hours", Exim's "message ... delayed"): the mail
//            system is still trying. NOT a bounce: nothing is marked bad, the thread and the sequence are untouched.
//   ooo      an automatic reply (English and other languages, subject or body, with or without Auto-Submitted / X-Autoreply
//            headers), sometimes with a return date: not a reply; the sequence goes on, after the return date when given.
//   opt_out  the contact asks not to be contacted, in many forms and cases, in the new text of the reply: opted out forever.
//   reply    a real answer: interested, a time, a question, a referral, "not hiring now but keep in touch", a forward or a
//            CC'd colleague, another address at the same domain, a signature only, HTML only, the original quoted below
//            (with an earlier "stop" or "unsubscribe" in the QUOTED history, which must not count), a colleague asking to
//            be removed (not the contact's own opt-out), read receipts excluded (see `receipt`).
//   receipt  a read receipt ("Read: <subject>"): not a reply, nothing happens.
//
// Every address is synthetic (.example / .test). Expectations are derived from `cls` and the fields below
// (tests/architect/scenarios-replies.test.ts).

export type Cls = "bounce" | "delay" | "ooo" | "opt_out" | "reply" | "receipt";
export interface Scenario {
  id: number;
  cls: Cls;
  category: string; // the report's bucket, e.g. "bounce/exchange", "reply/quoted-stop-outlook"
  recipient: string; // the contact the outreach email went to (lowercase)
  ourSubject: string; // the outreach email's subject
  from: string; // the From header of the incoming message
  subject: string;
  text: string; // the plain-text body (what the person's mail reader would show)
  html: string | null; // set when the message carries HTML (htmlOnly: no text/plain part at all)
  htmlOnly: boolean;
  headers: Record<string, string>;
  // ooo: the return date the message states in a form the product reads (start of that day, UTC ISO); null when none is
  // stated or only in a form documented as not read (another language's date, day.month numbers).
  returnAt: string | null;
}

// mulberry32: a small seeded PRNG, so every run generates the same scenarios.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = ReturnType<typeof rng>;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: R, p: number) => r() < p;

// The lane's "now" for every generated date (the year a return date without one falls in is read from it).
export const NOW = Date.parse("2026-10-29T15:00:00Z");

const FIRST = ["Avery", "Jordan", "Priya", "Mateo", "Hannah", "Wei", "Fatima", "Lukas", "Chloe", "Diego", "Aisha", "Noah", "Sofia", "Kenji", "Olivia", "Ravi", "Emma", "Tariq", "Lena", "Marcus"];
const LAST = ["Park", "Nguyen", "Shah", "Garcia", "Müller", "Chen", "Okafor", "Schmidt", "Dubois", "Rossi", "Khan", "Kim", "Silva", "Tanaka", "Brown", "Iyer", "Novak", "Haddad", "Larsen", "Cohen"];
const DOMAINS = ["acme.example", "globex.example", "initech.example", "umbrella.example", "hooli.example", "vandelay.example", "stark-industries.example", "wonka.example", "cyberdyne.example", "tyrell.example"];
const OUR_SUBJECTS = ["A quick question about the analyst role", "Coffee chat?", "Hello from a fellow NYU alum", "15 minutes this week?", "Question about your team at {firm}",
  "Your path into product management", "Advice on breaking into consulting", "Intro: Sam Lee, economics grad", "Following your talk last week", "Learning about {firm}"];
const ME = "Sam Lee <sam.lee@example.test>";
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ü/g, "u").toLowerCase();

// The original outreach email as it is quoted below a reply. Some carry opt-out words of their own (the footer, an
// unsubscribe line, an earlier exchange) that must never count as the contact's answer.
function original(r: R, first: string, firm: string): string {
  const body = pick(r, [
    `Hi ${first},\n\nI'm a recent economics graduate interested in analyst roles at ${firm}. Would you have 15 minutes this week to share how you got started?\n\nThank you,\nSam Lee`,
    `Hi ${first},\n\nI saw your post about the team's work and would love to learn more. Any chance you have time for a short call?\n\nBest,\nSam`,
  ]);
  const footer = pick(r, [
    "If you'd rather not hear from me, reply stop and I won't write again.",
    "If you'd rather not hear from me, reply STOP and I won't write again.",
    "Not interested? Reply unsubscribe and I won't email again.",
    "To stop receiving these emails, reply \"remove me\".",
    "If you're not interested, please let me know and I'll take you off my list.",
  ]);
  return `${body}\n\n${footer}`;
}
const quoteLines = (s: string, p = "> ") => s.split("\n").map((l) => (l ? `${p}${l}` : p.trimEnd())).join("\n");
const DATES = ["Tue, Oct 27, 2026 at 3:04 PM", "Mon, Oct 26, 2026 at 9:12 AM", "Wed, Oct 28, 2026 at 11:47 AM"];
type Quote = { kind: string; text: (orig: string, subj: string, to: string) => string; html: (orig: string, subj: string, to: string) => string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const QUOTES: Quote[] = [
  { kind: "gmail", text: (o) => `\n\nOn ${DATES[0]} ${ME} wrote:\n\n${quoteLines(o)}\n`,
    html: (o) => `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${DATES[0]} Sam Lee &lt;<a href="mailto:sam.lee@example.test">sam.lee@example.test</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${esc(o).replace(/\n/g, "<br>")}</blockquote></div>` },
  { kind: "gmail-wrapped", text: (o) => `\n\nOn ${DATES[1]} Sam Lee <\nsam.lee@example.test> wrote:\n\n${quoteLines(o)}\n`,
    html: (o) => `<div class="gmail_quote">On ${DATES[1]} Sam Lee wrote:<blockquote>${esc(o).replace(/\n/g, "<br>")}</blockquote></div>` },
  { kind: "outlook", text: (o, s, to) => `\n\n________________________________\nFrom: ${ME}\nSent: Tuesday, October 27, 2026 3:04 PM\nTo: ${to}\nSubject: ${s}\n\n${o}\n`,
    html: (o, s, to) => `<div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> Sam Lee &lt;sam.lee@example.test&gt;<br><b>Sent:</b> Tuesday, October 27, 2026 3:04 PM<br><b>To:</b> ${esc(to)}<br><b>Subject:</b> ${esc(s)}</font><div>&nbsp;</div></div><div>${esc(o).replace(/\n/g, "<br>")}</div>` },
  { kind: "outlook-desktop", text: (o, s, to) => `\n\n-----Original Message-----\nFrom: ${ME}\nSent: Tuesday, October 27, 2026 3:04 PM\nTo: ${to}\nSubject: ${s}\n\n${o}\n`,
    html: (o) => `<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Sam Lee &lt;sam.lee@example.test&gt;<br><b>Sent:</b> Tuesday, October 27, 2026 3:04 PM</p></div><p class="MsoNormal">${esc(o).replace(/\n/g, "<br>")}</p>` },
  { kind: "apple", text: (o) => `\n\n> On Oct 27, 2026, at 3:04 PM, ${ME} wrote:\n> \n${quoteLines(o)}\n`,
    html: (o) => `<div><br><blockquote type="cite">On Oct 27, 2026, at 3:04 PM, Sam Lee &lt;sam.lee@example.test&gt; wrote:<br><br>${esc(o).replace(/\n/g, "<br>")}</blockquote></div>` },
  { kind: "french", text: (o) => `\n\nLe mar. 27 oct. 2026 à 15:04, ${ME} a écrit :\n\n${quoteLines(o)}\n`,
    html: (o) => `<div class="gmail_quote"><div class="gmail_attr">Le mar. 27 oct. 2026 à 15:04, Sam Lee &lt;sam.lee@example.test&gt; a écrit&nbsp;:<br></div><blockquote class="gmail_quote">${esc(o).replace(/\n/g, "<br>")}</blockquote></div>` },
  { kind: "german", text: (o) => `\n\nAm Di., 27. Okt. 2026 um 15:04 Uhr schrieb ${ME}:\n\n${quoteLines(o)}\n`,
    html: (o) => `<div class="gmail_quote"><div class="gmail_attr">Am Di., 27. Okt. 2026 um 15:04 Uhr schrieb Sam Lee &lt;sam.lee@example.test&gt;:<br></div><blockquote class="gmail_quote">${esc(o).replace(/\n/g, "<br>")}</blockquote></div>` },
];
const SIGS = [
  (f: string, l: string, firm: string) => `\n\nBest,\n${f}`,
  (f: string, l: string, firm: string) => `\n\n--\n${f} ${l}\nDirector, ${firm}\n(555) 010-0199`,
  (f: string, l: string, firm: string) => `\n\nThanks,\n${f} ${l} | Senior Analyst | ${firm}\nThis email and any attachments are confidential and intended solely for the addressee.`,
  () => "\n\nSent from my iPhone",
  () => "",
];

// A reply's new text in the forms people write: a greeting or not, the case they type in, trailing punctuation.
function cased(r: R, s: string) {
  const k = r();
  return k < 0.12 ? s.toUpperCase() : k < 0.3 ? s.toLowerCase() : s;
}
function withGreeting(r: R, s: string) {
  return chance(r, 0.4) ? `${pick(r, ["Hi Sam,", "Hello Sam,", "Hey Sam,", "Sam,", "Hi,", "Dear Sam,"])}\n\n${s}` : s;
}

const OPT_OUTS = [
  "Please remove me from your list.", "unsubscribe", "Unsubscribe me.", "Please unsubscribe me from these emails.", "Take me off your list please.", "Please take me off your mailing list.",
  "Not interested, thanks.", "Not interested.", "not interested at this time", "We're not interested.", "I'm not interested. Thanks.", "Thanks, but I'm not interested.",
  "Stop emailing me.", "STOP", "Stop.", "stop", "Stop please.", "Please stop.", "Please stop contacting me.", "Please stop sending me emails.", "Kindly stop sending me these emails.",
  "No thank you.", "No thanks.", "no thank you", "No, thank you.", "Thanks, but no thanks.", "Do not contact me again.", "Don't email me again.", "please don't contact me",
  "Do not email me.", "Remove me.", "remove", "REMOVE ME", "I'd like to opt out.", "Opt me out please.", "Please opt me out.", "No longer interested.", "Leave me alone.",
  "Please don't reach out again.", "I'm not interested, please remove me from your mailing list.", "Please remove me from this distribution.", "take me off this list",
];
const REPLIES: { cat: string; text: (f: string, firm: string, domain: string) => string }[] = [
  { cat: "interested", text: () => "Happy to help! What would you like to know?" },
  { cat: "interested", text: () => "Sure, I'd be glad to chat." },
  { cat: "interested", text: () => "Thanks for reaching out. I'd be happy to talk." },
  { cat: "call", text: () => "Let's chat Thursday." },
  { cat: "call", text: () => "Does Thursday at 2pm work for a quick call?" },
  { cat: "call", text: () => "Happy to chat next week. What times work for you?" },
  { cat: "call", text: () => "Sure, call me at (555) 010-0123 any afternoon." },
  { cat: "question", text: () => "Can you send your resume first?" },
  { cat: "question", text: () => "What role are you looking at?" },
  { cat: "question", text: (_f, firm) => `Which team at ${firm} are you most interested in?` },
  { cat: "referral", text: (_f, _firm, d) => `Talk to my colleague Dana Park (dana.park@${d}); she runs recruiting.` },
  { cat: "referral", text: (_f, _firm, d) => `I'm not the right person, but Alex on our team might be: alex@${d}` },
  { cat: "keep-in-touch", text: () => "We're not hiring right now, but keep in touch." },
  { cat: "keep-in-touch", text: () => "Not hiring now but keep in touch!" },
  { cat: "keep-in-touch", text: () => "Nothing open at the moment, but please reach out again in the spring." },
  { cat: "keep-in-touch", text: () => "Not a fit right now, but stay in touch." },
  // Real replies with words close to an opt-out that are not one.
  { cat: "near-miss", text: () => "Don't hesitate to email me with questions." },
  { cat: "near-miss", text: () => "Please do not hesitate to contact me again next month." },
  { cat: "near-miss", text: () => "Feel free to stop by our office on Thursday afternoon." },
  { cat: "near-miss", text: () => "No problem at all, happy to help. Thursday works." },
  { cat: "near-miss", text: () => "I'm traveling this week but would love to chat next Tuesday." },
  { cat: "near-miss", text: () => "Thanks so much for the note! Interested to hear more about your background." },
];
// Return dates: [what the message says, the date it means] in forms the product reads; [text, null] for forms it does not.
// The dates are counted from `base` (UTC midnight of "the 1st"), never from the real clock inside the generator: the default
// base is Nov 1 2026 (so day 2..27 is Nov 2..27, always after NOW, which Part 1 pins), and the end-to-end part passes the day
// its own clock starts on, so a return date is always in the future of the clock that sends (2026-11-03: a fixed "Nov 2"
// was already past, the product rightly sent that follow-up at once, and the test said it should wait).
export const BASE = Date.UTC(2026, 10, 1);
const DAY_MS = 86_400_000;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SV = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
function returnPhrase(r: R, base: number, fixed?: number): [string, string | null] {
  const n = fixed ?? 2 + Math.floor(r() * 26); // the day of the month counted from base: 2..27 (base is the 1st)
  const at = new Date(base + (n - 1) * DAY_MS), day = at.getUTCDate(), mon = at.getUTCMonth(), year = at.getUTCFullYear();
  const iso = at.toISOString();
  const full = MONTH_NAMES[mon], short = full.slice(0, 3);
  const M = pick(r, [full, short, `${short}.`]);
  return pick(r, [
    [`until ${M} ${day}`, iso], [`until ${M} ${day}th`, iso], [`and will be back on Monday, ${full} ${day}`, iso], [`and will return on ${M} ${day}`, iso],
    [`until ${mon + 1}/${day}`, iso], [`through ${mon + 1}/${day}/${year}`, iso], [`until ${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, iso], [`until ${day} ${full}`, iso], [`and back on ${day} ${short}`, iso],
    ["until next week", null], ["for a few days", null], ["", null],
  ]);
}
const OOO_BODIES_EN = [
  (p: string) => `Thank you for your email. I am out of the office ${p} with limited access to email. For urgent matters, please contact my colleague.`.replace("office  with", "office with"),
  (p: string) => `I'm away ${p}. I'll reply when I'm back.`.replace("away .", "away."),
  (p: string) => `I am currently on parental leave ${p}. I will respond upon my return.`.replace("leave .", "leave."),
  (p: string) => `I am on vacation ${p} and will have no access to email.`.replace("vacation  and", "vacation and"),
  (p: string) => `I'm out of the office ${p}. Your email will not be forwarded.`.replace("office .", "office."),
];
// returnAt: Swedish "till" is "until", and the product reads "till den 10 november" as November 10 (correctly); the 10th counted from base.
const OOO_OTHER = (base: number): { lang: string; subject: (s: string) => string; body: string; returnAt?: string }[] => [
  { lang: "de", subject: (s) => `Abwesenheitsnotiz: ${s}`, body: "Vielen Dank für Ihre Nachricht. Ich bin bis zum 10.11.2026 nicht im Büro und habe keinen Zugriff auf meine E-Mails." },
  { lang: "de", subject: (s) => `Automatische Antwort: ${s}`, body: "Ich bin derzeit nicht im Büro. Ihre E-Mail wird nicht weitergeleitet." },
  { lang: "fr", subject: (s) => `Réponse automatique : ${s}`, body: "Je suis absent du bureau jusqu'au 10 novembre. Je répondrai à votre message dès mon retour." },
  { lang: "fr", subject: (s) => `Absence du bureau : ${s}`, body: "Bonjour, je suis en congé et je reviendrai lundi." },
  { lang: "es", subject: (s) => `Respuesta automática: ${s}`, body: "Estoy fuera de la oficina hasta el 10 de noviembre con acceso limitado al correo." },
  { lang: "es", subject: (s) => `Fuera de la oficina: ${s}`, body: "Gracias por su mensaje. Estaré de vacaciones hasta la próxima semana." },
  { lang: "it", subject: (s) => `Risposta automatica: ${s}`, body: "Sono fuori ufficio fino al 10 novembre." },
  { lang: "nl", subject: (s) => `Automatisch antwoord: ${s}`, body: "Ik ben afwezig tot 10 november." },
  { lang: "pt", subject: (s) => `Resposta automática: ${s}`, body: "Estou fora do escritório até 10 de novembro." },
  { lang: "sv", subject: (s) => `Autosvar: ${s}`, body: `Jag är på semester till den ${new Date(base + 9 * DAY_MS).getUTCDate()} ${MONTH_SV[new Date(base + 9 * DAY_MS).getUTCMonth()]}.`, returnAt: new Date(base + 9 * DAY_MS).getUTCMonth() === 4 ? undefined : new Date(base + 9 * DAY_MS).toISOString() }, // "maj" is not a month the product reads
];
const OOO_SUBJECTS_EN = [(s: string) => `Automatic reply: ${s}`, (s: string) => `Out of Office: ${s}`, () => "Out of office", (s: string) => `OOO: ${s}`, (s: string) => `AutoReply: ${s}`,
  (s: string) => `Auto-Reply: ${s}`, (s: string) => `[Auto-Reply] ${s}`, (s: string) => `Autoreply: ${s}`, () => "Out of the office", (s: string) => `Auto Response: ${s}`,
  (s: string) => `Away from the office: ${s}`, () => "On vacation", (s: string) => `Re: ${s}`, (s: string) => `RE: ${s}`];
const OOO_HEADERS: Record<string, string>[] = [{}, {}, { "Auto-Submitted": "auto-replied" }, { "X-Autoreply": "yes" }, { "Precedence": "auto_reply" }, { "X-Auto-Response-Suppress": "All", "Auto-Submitted": "auto-generated" }];

type Mta = { name: string; from: (d: string) => string; subject: (s: string) => string; body: (to: string) => string; headers?: (to: string) => Record<string, string> };
const REPORT = { "Content-Type": "multipart/report; report-type=delivery-status; boundary=\"000000000000abc\"" };
const BOUNCES: Mta[] = [
  { name: "gmail", from: () => "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: () => "Delivery Status Notification (Failure)",
    body: (to) => `** Address not found **\n\nYour message wasn't delivered to ${to} because the address couldn't be found, or is unable to receive mail.\n\nLearn more here: https://support.google.com/mail/?p=NoSuchUser\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.`, headers: () => REPORT },
  { name: "gmail-google", from: () => "Mail Delivery Subsystem <mailer-daemon@google.com>", subject: () => "Delivery Status Notification (Failure)",
    body: (to) => `** Message blocked **\n\nYour message to ${to} has been blocked. See technical details below for more information.\n\nThe response was:\n550 5.7.1 Message rejected by recipient's server.`, headers: () => REPORT },
  { name: "outlook.com", from: () => "Microsoft Outlook <postmaster@outlook.com>", subject: (s) => `Undeliverable: ${s}`,
    body: (to) => `Your message to ${to} couldn't be delivered.\n${to.split("@")[0]} wasn't found at ${to.split("@")[1]}.\n\nRemote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'` },
  { name: "exchange", from: (d) => `Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@${d}>`, subject: (s) => `Undeliverable: ${s}`,
    body: (to) => `Delivery has failed to these recipients or groups:\n\n${to}\nThe e-mail address you entered couldn't be found. Please check the recipient's e-mail address and try to resend the message.\n\nDiagnostic information for administrators:\n#550 5.1.1 RESOLVER.ADR.RecipientNotFound; not found ##` },
  { name: "exchange-postmaster", from: (d) => `postmaster@${d}`, subject: (s) => `Undeliverable: ${s}`, body: (to) => `Delivery has failed to these recipients or groups:\n\n${to}\nThe recipient's mailbox doesn't exist.` },
  { name: "yahoo", from: () => "MAILER-DAEMON@yahoo.com", subject: () => "Failure Notice",
    body: (to) => `Sorry, we were unable to deliver your message to the following address.\n\n<${to}>:\n554: delivery error: dd This user doesn't have a yahoo.com account (${to}) [0] - mta1003.mail.gq1.yahoo.com` },
  { name: "aol", from: () => "MAILER-DAEMON@aol.com", subject: () => "Failure Notice", body: (to) => `Sorry, we were unable to deliver your message to the following address.\n\n<${to}>:\n550: 5.1.1 <${to}>: Recipient address rejected: aol.com` },
  { name: "postfix", from: (d) => `MAILER-DAEMON@mail.${d} (Mail Delivery System)`, subject: () => "Undelivered Mail Returned to Sender",
    body: (to) => `This is the mail system at host mail.example.\n\nI'm sorry to have to inform you that your message could not\nbe delivered to one or more recipients. It's attached below.\n\n<${to}>: host mx.example said: 550 5.1.1 <${to}>:\n    Recipient address rejected: User unknown in local recipient table`, headers: () => REPORT },
  { name: "sendmail", from: (d) => `Mail Delivery Subsystem <MAILER-DAEMON@${d}>`, subject: () => "Returned mail: see transcript for details",
    body: (to) => `The original message was received at Tue, 27 Oct 2026 15:04:11 -0500\n\n   ----- The following addresses had permanent fatal errors -----\n<${to}>\n    (reason: 550 5.1.1 User unknown)` },
  { name: "sendmail-user-unknown", from: (d) => `Mail Delivery Subsystem <MAILER-DAEMON@${d}>`, subject: () => "Returned mail: User unknown", body: (to) => `----- The following addresses had permanent fatal errors -----\n<${to}>` },
  { name: "exim", from: (d) => `Mail Delivery System <Mailer-Daemon@${d}>`, subject: () => "Mail delivery failed: returning message to sender",
    body: (to) => `This message was created automatically by mail delivery software.\n\nA message that you sent could not be delivered to one or more of its\nrecipients. This is a permanent error. The following address(es) failed:\n\n  ${to}\n    No Such User Here`, headers: (to) => ({ "X-Failed-Recipients": to, "Auto-Submitted": "auto-replied" }) },
  { name: "qmail", from: (d) => `MAILER-DAEMON@${d}`, subject: () => "failure notice", body: (to) => `Hi. This is the qmail-send program at mail.example.\nI'm afraid I wasn't able to deliver your message to the following addresses.\nThis is a permanent error; I've given up. Sorry it didn't work out.\n\n<${to}>:\nSorry, no mailbox here by that name. (#5.1.1)` },
  { name: "generic-failure", from: (d) => `postmaster@${d}`, subject: () => "Delivery Failure", body: (to) => `Your message could not be delivered to ${to}. The address does not exist.` },
  { name: "generic-dsn", from: (d) => `Mail Delivery System <mailer-daemon@${d}>`, subject: () => "Delivery Status Notification", body: (to) => `Delivery to the following recipient failed permanently:\n\n     ${to}`, headers: () => REPORT },
  { name: "address-not-found", from: () => "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: () => "Address not found", body: (to) => `Your message wasn't delivered to ${to} because the address couldn't be found.` },
  // Final failures for temporary reasons (mailbox full, a server that kept refusing): the mail system gave up. A bounce.
  { name: "soft-final/gmail-mailbox-full", from: () => "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: () => "Delivery Status Notification (Failure)",
    body: (to) => `** Message not delivered **\n\nThere was a problem delivering your message to ${to}. The recipient's inbox is full and can't accept messages now.\n\nThe response was:\n452 4.2.2 The email account that you tried to reach is over quota.`, headers: () => REPORT },
  { name: "soft-final/gmail-gave-up", from: () => "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: () => "Delivery Status Notification (Failure)",
    body: (to) => `** Message not delivered **\n\nThere was a temporary problem delivering your message to ${to}. Gmail tried for 46 hours and has given up.\n\nThe response was:\n421 4.7.0 Try again later, closing connection.`, headers: () => REPORT },
  { name: "soft-final/postfix-mailbox-full", from: (d) => `MAILER-DAEMON@mail.${d} (Mail Delivery System)`, subject: () => "Undelivered Mail Returned to Sender",
    body: (to) => `I'm sorry to have to inform you that your message could not\nbe delivered to one or more recipients.\n\n<${to}>: host mx.example said: 552 5.2.2 Mailbox full`, headers: () => REPORT },
  { name: "soft-final/outlook-quota", from: () => "Microsoft Outlook <postmaster@outlook.com>", subject: (s) => `Undeliverable: ${s}`, body: (to) => `Your message to ${to} couldn't be delivered.\nThe recipient's mailbox is full and can't accept messages now.` },
];
const DELAYS: Mta[] = [
  { name: "gmail", from: () => "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: () => "Delivery Status Notification (Delay)",
    body: (to) => `** Message not delivered yet **\n\nThere's a temporary problem delivering your message to ${to}. Gmail will retry for 46 more hours. You'll be notified if the delivery fails permanently.\n\nThe response was:\n452 4.2.2 The recipient's inbox is out of storage space.`, headers: () => REPORT },
  { name: "gmail-dns", from: () => "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: () => "Delivery Status Notification (Delay)",
    body: (to) => `This is an automatically generated Delivery Status Notification\n\nTHIS IS A WARNING MESSAGE ONLY.\n\nYOU DO NOT NEED TO RESEND YOUR MESSAGE.\n\nDelivery to the following recipient has been delayed:\n\n     ${to}\n\nMessage will be retried for 2 more day(s)`, headers: () => REPORT },
  { name: "outlook.com", from: () => "Microsoft Outlook <postmaster@outlook.com>", subject: (s) => `Delivery delayed: ${s}`,
    body: (to) => `Delivery is delayed to these recipients or groups:\n\n${to}\n\nThis message hasn't been delivered yet. Delivery will continue to be attempted.\n\nThe server will keep trying to deliver this message for the next 1 days, 19 hours and 54 minutes. You'll be notified if the message can't be delivered by that time.` },
  { name: "exchange", from: (d) => `Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@${d}>`, subject: (s) => `Delivery delayed:${s}`,
    body: (to) => `Delivery is delayed to these recipients or groups:\n\n${to}\n\nThis message hasn't been delivered yet. Delivery will continue to be attempted.` },
  { name: "postfix", from: (d) => `MAILER-DAEMON@mail.${d} (Mail Delivery System)`, subject: () => "Delayed Mail (still being retried)",
    body: (to) => `This is the mail system at host mail.example.\n\n####################################################################\n# THIS IS A WARNING ONLY.  YOU DO NOT NEED TO RESEND YOUR MESSAGE. #\n####################################################################\n\nYour message could not be delivered for more than 4 hour(s).\nIt will be retried until it is 5 day(s) old.\n\n<${to}>: connect to mx.example[192.0.2.1]:25: Connection timed out`, headers: () => REPORT },
  { name: "sendmail", from: (d) => `Mail Delivery Subsystem <MAILER-DAEMON@${d}>`, subject: () => "Warning: could not send message for past 4 hours",
    body: (to) => `    **********************************************\n    **      THIS IS A WARNING MESSAGE ONLY      **\n    **  YOU DO NOT NEED TO RESEND YOUR MESSAGE  **\n    **********************************************\n\nThe original message was received at Tue, 27 Oct 2026 15:04:11 -0500\n\n   ----- Transcript of session follows -----\n<${to}>... Deferred: Connection timed out with mx.example.\nWarning: message still undelivered after 4 hours\nWill keep trying until message is 5 days old` },
  { name: "exim", from: (d) => `Mail Delivery System <Mailer-Daemon@${d}>`, subject: () => "Warning: message 1tXyZa-0004Ab-Cd delayed 24 hours",
    body: (to) => `This message was created automatically by mail delivery software.\nA message that you sent has not yet been delivered to one or more of its\nrecipients after more than 24 hours on the queue on mail.example.\n\n  ${to}\n    Delay reason: mailbox is full\n\nNo action is required on your part. Delivery attempts will continue for some time.` },
  { name: "yahoo", from: () => "MAILER-DAEMON@yahoo.com", subject: () => "Delivery delayed", body: (to) => `Message delivery to ${to} has been delayed. We will keep trying; no action is needed.` },
  { name: "generic", from: (d) => `postmaster@${d}`, subject: (s) => `Delayed: ${s}`, body: (to) => `This is a delivery delay notification. Your message to ${to} has not yet been delivered. The system will retry.` },
  { name: "generic-dsn-delay", from: (d) => `Mail Delivery System <mailer-daemon@${d}>`, subject: () => "Delivery Status Notification", body: (to) => `THIS IS A WARNING MESSAGE ONLY. Delivery to ${to} has been delayed. Delivery will continue to be attempted.`, headers: () => REPORT },
];

export function generate(o: { seed?: number; count?: number; base?: number } = {}): Scenario[] {
  const base = o.base ?? BASE;
  const oooOther = OOO_OTHER(base);
  const r = rng(o.seed ?? 20261029);
  const count = o.count ?? 10_000;
  const out: Scenario[] = [];
  const weights: [Cls, number][] = [["bounce", 0.17], ["delay", 0.1], ["ooo", 0.18], ["opt_out", 0.22], ["reply", 0.3], ["receipt", 0.03]];
  for (let id = 1; id <= count; id++) {
    let x = r(), cls: Cls = "reply";
    for (const [c, w] of weights) { if (x < w) { cls = c; break; } x -= w; }
    const first = pick(r, FIRST), last = pick(r, LAST), domain = pick(r, DOMAINS), firm = domain.split(".")[0].replace(/(^|-)\w/g, (m) => m.toUpperCase()).replace("-", " ");
    const recipient = `${ascii(first)}.${ascii(last)}${id}@${domain}`;
    const ourSubject = pick(r, OUR_SUBJECTS).replace("{firm}", firm);
    const display = chance(r, 0.15) ? `"${last}, ${first}"` : `${first} ${last}`;
    const fromRecipient = chance(r, 0.1) ? `${display} <${recipient.replace(/^[a-z]/, (c) => c.toUpperCase()).replace("@", "@").replace(domain, domain.toUpperCase())}>` : chance(r, 0.1) ? recipient : `${display} <${recipient}>`;
    const re = pick(r, ["Re: ", "RE: ", "Re: ", "Aw: ", "Re:"]);
    const s: Scenario = { id, cls, category: cls, recipient, ourSubject, from: fromRecipient, subject: `${re}${ourSubject}`, text: "", html: null, htmlOnly: false, headers: {}, returnAt: null };
    const orig = original(r, first, firm);
    if (cls === "bounce" || cls === "delay") {
      const m = pick(r, cls === "bounce" ? BOUNCES : DELAYS);
      s.category = `${cls}/${m.name}`;
      s.from = m.from(domain.split(".")[0] + "-mail.example");
      s.subject = m.subject(ourSubject);
      s.text = m.body(recipient);
      s.headers = { ...(m.headers?.(recipient) ?? {}), ...(chance(r, 0.3) ? { "Auto-Submitted": "auto-replied" } : {}) };
    } else if (cls === "ooo") {
      const other = chance(r, 0.3);
      if (other) {
        const m = pick(r, oooOther);
        s.category = `ooo/${m.lang}`;
        s.subject = m.subject(ourSubject);
        s.text = m.body;
        s.returnAt = m.returnAt ?? null;
        // Bilingual auto-replies carry the English too, often with a date the product reads (the same date: November 10).
        if (chance(r, 0.4)) { const [p, at] = returnPhrase(r, base, 10); s.text += `\n\n${OOO_BODIES_EN[0](p)}`; s.returnAt = at ?? s.returnAt; s.category += "+en"; }
      } else {
        const subj = pick(r, OOO_SUBJECTS_EN);
        const [p, at] = returnPhrase(r, base);
        s.subject = subj(ourSubject);
        s.text = pick(r, OOO_BODIES_EN)(p);
        s.returnAt = at;
        s.category = `ooo/${/^re:/i.test(s.subject) ? "body-only" : "en-subject"}${at ? "+date" : ""}`;
      }
      s.headers = pick(r, OOO_HEADERS);
      // An auto-reply from the contact's assistant or a shared mailbox is still an auto-reply.
      if (chance(r, 0.1)) { s.from = `Executive Assistant <assistant@${domain}>`; s.category += "/other-sender"; }
    } else if (cls === "receipt") {
      s.category = "receipt";
      s.subject = pick(r, [`Read: ${ourSubject}`, `Read: ${ourSubject}`, `Not read: ${ourSubject}`, `Gelesen: ${ourSubject}`, `Lu : ${ourSubject}`]);
      s.text = `Your message\n\n  To: ${recipient}\n  Subject: ${ourSubject}\n  Sent: Tuesday, October 27, 2026 3:04:11 PM (UTC-06:00)\n\nwas read on Tuesday, October 27, 2026 4:12:40 PM (UTC-06:00).`;
      s.headers = chance(r, 0.5) ? { "Content-Type": "multipart/report; report-type=disposition-notification; boundary=\"b1\"" } : {};
    } else {
      let fresh: string;
      if (cls === "opt_out") {
        fresh = withGreeting(r, cased(r, pick(r, OPT_OUTS)));
        s.category = "opt_out";
      } else {
        const rep = pick(r, REPLIES);
        fresh = withGreeting(r, rep.text(first, firm, domain));
        s.category = `reply/${rep.cat}`;
        const k = r();
        if (k < 0.08) { fresh = ""; s.category = "reply/signature-only"; }
        else if (k < 0.16) { s.from = `Dana Park <dana.park@${domain}>`; s.category = `reply/cc-colleague`; fresh = pick(r, [`${first} looped me in. Happy to chat next week.`, `Adding myself here: I run recruiting and can help.`, fresh]); }
        else if (k < 0.22) { s.from = `${first} ${last} <${ascii(first)[0]}${ascii(last)}@${domain}>`; s.category = "reply/same-domain-alias"; }
        else if (k < 0.27) { s.subject = `Fwd: ${ourSubject}`; s.category = "reply/forwarded"; fresh = `Forwarding to Dana, who handles this. Dana, see below.\n\n---------- Forwarded message ---------\nFrom: ${ME}\nDate: ${DATES[2]}\nSubject: ${ourSubject}\nTo: <${recipient}>\n\n${orig}`; }
        else if (k < 0.32) { s.from = `Dana Park <dana.park@${domain}>`; s.category = "reply/colleague-asks-removal"; fresh = pick(r, ["Please remove me from this thread.", "Unsubscribe", "Please take me off this email chain."]); }
      }
      const sig = pick(r, SIGS)(first, last, firm);
      const q = chance(r, s.category === "reply/forwarded" ? 0 : 0.7) ? pick(r, QUOTES) : null;
      if (q) s.category += `/quoted-${q.kind}`;
      s.text = `${fresh}${sig}${q ? q.text(orig, ourSubject, recipient) : ""}`;
      if (s.category.startsWith("reply/signature-only")) s.text = s.text.replace(/^\s+/, "\n");
      if (chance(r, 0.25)) {
        // HTML: some messages have only HTML (no text/plain part), the rest both.
        s.htmlOnly = chance(r, 0.6);
        s.html = `<html><head><style>p{margin:0}</style></head><body><div dir="ltr">${esc(fresh).replace(/\n/g, "<br>")}${esc(sig).replace(/\n/g, "<br>")}</div>${q ? q.html(orig, ourSubject, recipient) : ""}</body></html>`;
        s.category += s.htmlOnly ? "/html-only" : "/html+text";
      }
    }
    out.push(s);
  }
  return out;
}

// A seeded sample that covers every category first, then fills to k at random.
export function sample(all: Scenario[], k: number, seed = 7): Scenario[] {
  const r = rng(seed);
  const byCat = new Map<string, Scenario[]>();
  for (const s of all) { const c = s.category.split("/").slice(0, 2).join("/"); byCat.set(c, [...(byCat.get(c) ?? []), s]); }
  const got = new Set<Scenario>();
  for (const xs of byCat.values()) { if (got.size >= k) break; got.add(pick(r, xs)); }
  while (got.size < k) got.add(pick(r, all));
  return [...got].sort((a, b) => a.id - b.id);
}

// ------------------------------------------------------------------------------------------------ as Gmail serves it
const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
};
// Gmail's snippet: the start of the message's text with tags removed and whitespace collapsed, about 200 characters,
// HTML-escaped (an apostrophe arrives as &#39;).
export function gmailSnippet(s: Scenario): string {
  const plain = s.htmlOnly && s.html ? s.html.replace(/<(style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : s.text;
  return plain.replace(/\s+/g, " ").trim().slice(0, 200).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// The message as Gmail's API returns it with format=full (users.messages.get): text/plain, text/html only, or
// multipart/alternative with both; a delivery report is multipart/report.
export function gmailMessage(s: Scenario, ids: { id: string; threadId: string; at: number }) {
  const headers = [{ name: "From", value: s.from }, { name: "To", value: "sam.lee@example.test" }, { name: "Subject", value: s.subject },
    ...Object.entries(s.headers).filter(([k]) => k.toLowerCase() !== "content-type").map(([name, value]) => ({ name, value }))];
  const ct = Object.entries(s.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  const textPart = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=\"UTF-8\"" }], body: { data: b64url(s.text), size: s.text.length } };
  const htmlPart = s.html ? { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=\"UTF-8\"" }], body: { data: b64url(s.html), size: s.html.length } } : null;
  let payload: any;
  if (ct && /multipart\/report/i.test(ct)) payload = { mimeType: "multipart/report", headers: [...headers, { name: "Content-Type", value: ct }], body: { size: 0 }, parts: [textPart, { mimeType: "message/delivery-status", body: { data: b64url("Reporting-MTA: dns; mx.example\n"), size: 30 } }] };
  else if (htmlPart && s.htmlOnly) payload = { ...htmlPart, headers: [...headers, ...htmlPart.headers] };
  else if (htmlPart) payload = { mimeType: "multipart/alternative", headers: [...headers, { name: "Content-Type", value: "multipart/alternative; boundary=\"x\"" }], body: { size: 0 }, parts: [textPart, htmlPart] };
  else payload = { ...textPart, headers: [...headers, ...textPart.headers] };
  return { id: ids.id, threadId: ids.threadId, labelIds: ["INBOX", "UNREAD"], snippet: gmailSnippet(s), internalDate: String(ids.at), payload };
}
