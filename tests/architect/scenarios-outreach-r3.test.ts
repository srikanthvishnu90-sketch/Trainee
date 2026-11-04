// OUTREACH R3 (2026-10-31): a fresh-seed battery (seed 20261031) over the outreach lifecycle after the draft, in
// categories the earlier batteries did not cover (scenarios-outreach, scenarios-replies, scenarios-networking[-r2],
// scenarios-connectors). Pure functions, a fixed clock, a fake Gmail at the HTTP boundary; no database, no network, no
// model. The database side and the sampled end-to-end runs are tests/architect/outreach-r3-pg.test.ts and
// tests/db/career_outreach_r3.test.sql.
//   optout   "stop emailing me" / "unsubscribe" / "remove me from your list" / "not interested" in 25 languages, with
//            greetings, signatures and quoted history, from the contact: a stop (the do-not-contact list), never a plain
//            reply; the same words only in the quoted history, from a colleague, or a positive answer: never a stop.
//   long     a reply whose opt-out comes after Gmail's ~200-character snippet: read whole, a stop; an out-of-office with a
//            long body is still no answer; a message that cannot be read whole stays a reply (the sequence stops).
//   lapse    a retried outreach email whose approval passed 7 days: never sent again; found in Sent it is recorded as
//            sent (the truth), otherwise it lapses with a reason; one inside its 7 days is sent once.
//   handoff  an approval the sending rail refuses for good (opted out, bounced, already emailed) is never said to be going:
//            the chat says which and why; the rest are said exactly.
//   facts    D-007 on the recipient: a title, a career event or a team that is not on their row never passes the
//            fact-lock; the honest version of the same sentence (the title / team on the row) passes.
import assertNode from "node:assert/strict";
import { classifyIncoming, type Claimed, runSendWorker, threadAnswer, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { footerOf, memoryOutreachStore, messageOf, OPT_OUT_LINE, type OutreachDraft, OUTREACH_INTENT, outreachLock, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261031;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
class Report {
  total = 0; fails = new Map<string, string[]>();
  constructor(public what: string) {}
  grade(cat: string, why: string | null, got: unknown) {
    this.total++;
    if (!why) return;
    const k = `${cat}: ${why}`;
    if (!this.fails.has(k)) this.fails.set(k, []);
    this.fails.get(k)!.push(JSON.stringify(got).slice(0, 300));
  }
  done(min: number) {
    const n = [...this.fails.values()].reduce((a, b) => a + b.length, 0);
    console.log([`[outreach r3] ${this.what}: ${this.total} scenarios, ${n} failures`, ...[...this.fails].flatMap(([k, xs]) => [`  FAIL ${k}: ${xs.length}`, ...xs.slice(0, 3).map((x) => `    ${x}`)])].join("\n"));
    assertNode.ok(this.total >= min, `${this.what}: ${this.total} < ${min} scenarios`);
    eq(n, 0, `${this.what}: ${n} of ${this.total} failed (see the report above)`);
  }
}
export const R3_COUNTS = { optout: 3600, long: 1500, lapse: 1500, handoff: 1200, facts: 2400 };

// ------------------------------------------------------------------------------------------------ optout
const STOPS: Record<string, string[]> = {
  en: ["Please remove my address from your list.", "I'd prefer not to be contacted again.", "Not something I'm interested in, thanks.", "Please stop sending me these."],
  fr: ["Merci de me désabonner.", "Désabonnez-moi s'il vous plaît.", "Veuillez me retirer de votre liste.", "Je ne souhaite plus recevoir vos e-mails.", "Arrêtez de m'écrire, merci."],
  de: ["Bitte entfernen Sie mich aus Ihrem Verteiler.", "Bitte abbestellen.", "Hören Sie auf, mir zu schreiben.", "Schreiben Sie mir nicht mehr."],
  es: ["Por favor, quítenme de su lista.", "Elimíneme de su lista de correo.", "Deje de escribirme, gracias.", "No quiero recibir más correos."],
  it: ["Per favore, toglietemi dalla lista.", "Non voglio più ricevere email.", "Smettila di scrivermi.", "Disiscrivimi per favore."],
  pt: ["Por favor, remova-me da sua lista.", "Pare de me enviar e-mails.", "Não quero mais receber e-mails."],
  nl: ["Verwijder mij alstublieft van uw lijst.", "Ik wil geen e-mails meer ontvangen.", "Stop met mailen alstublieft."],
  pl: ["Proszę mnie wypisać.", "Nie piszcie do mnie więcej.", "Nie jestem zainteresowany.", "Proszę o usunięcie mojego adresu."],
  sv: ["Avregistrera mig, tack.", "Sluta mejla mig.", "Jag är inte intresserad."],
  da: ["Afmeld mig venligst.", "Jeg er ikke interesseret."], no: ["Meld meg av, takk.", "Jeg er ikke interessert."],
  tr: ["Lütfen bana bir daha yazmayın.", "Abonelikten çıkar beni.", "İlgilenmiyorum."],
  ru: ["Отпишите меня, пожалуйста.", "Удалите меня из рассылки.", "Мне это не интересно."], uk: ["Не пишіть мені більше.", "Відпишіть мене."],
  ja: ["連絡しないでください。", "メールを送らないでください。", "興味がありません。"], zh: ["请不要再给我发邮件。", "别再联系我了。", "我没兴趣。", "請不要再寄信給我。"],
  ko: ["더 이상 연락하지 마세요.", "관심 없습니다."], ar: ["إلغاء الاشتراك من فضلك", "لا تراسلني مرة أخرى"], he: ["הסירו אותי מהרשימה", "אל תשלחו לי יותר מיילים"],
  hi: ["कृपया मुझे ईमेल न भेजें"], el: ["Μην μου ξαναστείλετε email.", "Δεν ενδιαφέρομαι."], ro: ["Vă rog să mă dezabonați."], hu: ["Kérem, ne írjon többet."], fi: ["Älkää lähettäkö minulle enää viestejä."],
};
const POSITIVE: Record<string, string[]> = {
  en: ["Thanks! Happy to chat next week.", "Sure, I'm interested. Send me some times.", "Don't stop now, this sounds great."],
  fr: ["Merci, avec plaisir. Je suis disponible mardi.", "Je suis intéressée, parlons-en."], de: ["Gerne, lassen Sie uns telefonieren.", "Ich bin interessiert."],
  es: ["Gracias, me encantaría hablar.", "Estoy interesada, hablemos."], it: ["Volentieri, sentiamoci giovedì."], pt: ["Claro, podemos conversar amanhã."],
  pl: ["Jestem zainteresowany, porozmawiajmy."], sv: ["Jag är intresserad!"], tr: ["İlgileniyorum, konuşalım."], ru: ["Мне это интересно, давайте созвонимся."],
  zh: ["我有兴趣，我们聊聊吧。"], ko: ["관심 있습니다. 통화해요."], ja: ["ぜひお話ししましょう。"],
};
const GREET = ["", "Hi Sam,\n\n", "Hello,\n\n", "Bonjour,\n\n", "Hola Sam,\n\n", "Sam -\n\n", "Dear Mr. Lee,\n\n"];
const SIGN = ["", "\n\nBest,\nMaya", "\n\n-- \nMaya Chen\nAcme Capital", "\n\nSent from my iPhone"];
const QUOTE = (t: string) => `\n\nOn Tue, Oct 28, 2026 at 9:14 AM Sam Lee <sam@example.test> wrote:\n> ${t.replace(/\n/g, "\n> ")}`;
const OURS = `Hi Maya,\n\nWould you have 15 minutes this week?\n\nSam Lee\n\n${OPT_OUT_LINE}`;
const RECIP = "maya@acme.example";
function optoutBattery() {
  const rep = new Report("optout");
  const r = rng(SEED);
  const langs = Object.keys(STOPS), plangs = Object.keys(POSITIVE);
  for (let i = 0; i < R3_COUNTS.optout; i++) {
    const kind = pick(r, ["stop", "stop", "stop", "positive", "quoted_stop", "colleague_stop"] as const);
    const lang = kind === "positive" ? pick(r, plangs) : pick(r, langs);
    const words = kind === "positive" ? pick(r, POSITIVE[lang]) : pick(r, STOPS[lang]);
    const caseFn = pick(r, [(s: string) => s, (s: string) => s.toUpperCase(), (s: string) => s.toLowerCase()]);
    const fresh = kind === "quoted_stop" ? pick(r, POSITIVE.en) : caseFn(words);
    // Our own email is quoted below every reply (its "reply stop" footer too); a quoted stop is the earlier email's words.
    const quoted = kind === "quoted_stop" ? `${OURS}\n\n${words}` : OURS;
    const body = `${pick(r, GREET)}${fresh}${pick(r, SIGN)}${QUOTE(quoted)}`;
    const from = kind === "colleague_stop" ? "Jo Park <jo@acme.example>" : pick(r, [`Maya Chen <${RECIP}>`, RECIP, `"Chen, Maya" <Maya@Acme.example>`]);
    const got = classifyIncoming({ from, subject: pick(r, ["Re: A quick question", "RE: A quick question", "AW: A quick question", "Re: Quick question about Acme"]), snippet: body }, RECIP);
    const want = kind === "stop" ? "stop" : "reply";
    rep.grade(`${kind}/${lang}`, got === want ? null : `want ${want}, got ${got}`, { words, from });
  }
  rep.done(R3_COUNTS.optout);
}

// ------------------------------------------------------------------------------------------------ long
const FILLER = "Thanks so much for reaching out and for the kind words about our team. I remember the event you mentioned and it was a pleasure to meet so many students there. ";
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function longFake(msgs: { id: string; from: string; subject: string; text: string; html?: boolean; headers?: Record<string, string> }[], fullOk: boolean) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${url.pathname}?${url.searchParams.get("format") ?? url.searchParams.get("q") ?? ""}`);
    const th = /\/threads\/([^/]+)$/.exec(url.pathname), one = /\/messages\/([^/]+)$/.exec(url.pathname);
    if (th) return Response.json({ id: th[1], messages: [{ id: "m0", labelIds: ["SENT"], snippet: "Hi Maya", payload: { headers: [{ name: "From", value: "sam@example.test" }, { name: "Subject", value: "A quick question" }] } },
      ...msgs.map((m) => ({ id: m.id, labelIds: ["INBOX"], snippet: m.text.slice(0, 200), payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value }))] } }))] });
    if (one && url.searchParams.get("format") === "full") {
      const m = msgs.find((x) => x.id === one[1]);
      if (!m || !fullOk) return new Response("{}", { status: 500 });
      const part = (mime: string, s: string) => ({ mimeType: mime, body: { data: b64url(s) } });
      return Response.json({ id: m.id, payload: { mimeType: "multipart/alternative", parts: m.html ? [part("text/html", `<div>${m.text.replace(/\n/g, "<br>")}</div>`)] : [part("text/plain", m.text), part("text/html", `<p>${m.text}</p>`)] } });
    }
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
async function longBattery() {
  const rep = new Report("long");
  const r = rng(SEED + 1);
  const langs = Object.keys(STOPS);
  for (let i = 0; i < R3_COUNTS.long; i++) {
    const kind = pick(r, ["late_stop", "late_stop", "late_positive", "ooo_long", "late_stop_unreadable", "late_stop_html"] as const);
    const pad = FILLER.repeat(2 + Math.floor(r() * 5)); // past the ~200-character snippet
    const lang = pick(r, langs);
    const tail = kind === "late_positive" ? pick(r, POSITIVE.en) : kind === "ooo_long" ? "I'm currently out of the office with limited access to email." : pick(r, STOPS[lang]);
    const text = kind === "ooo_long" ? `${tail} ${pad}${QUOTE(OURS)}` : `Hi Sam,\n\n${pad}\n\n${tail}\n\nBest,\nMaya${QUOTE(OURS)}`;
    const subject = kind === "ooo_long" ? "Automatic reply: A quick question" : "Re: A quick question";
    const fake = longFake([{ id: "m1", from: `Maya Chen <${RECIP}>`, subject, text, html: kind === "late_stop_html" }], kind !== "late_stop_unreadable");
    const got = await threadAnswer({ fetch: fake.fetch }, "tok", { id: "q1", recipient_email: RECIP, gmail_id: "m0", gmail_thread: "t1", sent_at: "2026-10-28T14:00:00Z" });
    const k = "kind" in got ? got.kind : `error ${got.error}`;
    const want = kind === "late_positive" || kind === "late_stop_unreadable" ? "reply" : kind === "ooo_long" ? null : "stop";
    rep.grade(`${kind}`, k === want ? null : `want ${want}, got ${k}`, { lang, tail, calls: fake.calls });
  }
  rep.done(R3_COUNTS.long);
}

// ------------------------------------------------------------------------------------------------ lapse
// One worker run over one claimed email, through a fake database (claim, last check, completion) and a fake Gmail whose
// Sent mail may already hold the earlier try.
async function lapseBattery() {
  const rep = new Report("lapse");
  const r = rng(SEED + 2);
  for (let i = 0; i < R3_COUNTS.lapse; i++) {
    const lapsed = r() < 0.6, attempts = lapsed ? 2 + Math.floor(r() * 5) : 1 + Math.floor(r() * 4), inSent = attempts > 1 && r() < 0.35;
    const to = `p${i}@acme.example`, subject = `A quick question ${i}`;
    const d = { recipient: { name: "P", firm: "Acme", title: "Analyst", school: "", email: to, source: "t" }, subject, body: "Hi,\n\nWould you have 15 minutes?", footer: footerOf("Sam Lee") };
    const m = messageOf(d), hash = await payloadHash(m);
    const it: Claimed = { id: `q${i}`, user_id: "u1", kind: "outreach", source_id: `d${i}`, approval_hash: hash, provider: "gmail", to: m.to, subject: m.subject, body: m.text, attempts,
      first_claimed_at: "2026-10-20T10:00:00Z", follow_up_of: null, from_email: "sam@example.test", draft: d, ...(lapsed ? { lapsed: true } : {}) };
    let claimed = false;
    const outcomes: any[] = [], posts: string[] = [];
    const deps: WorkerDeps = {
      now: () => Date.parse("2026-10-31T12:00:00Z"),
      token: async (_u, scope) => `tok-${scope.slice(-4)}`,
      rpc: async (name, args: any) => {
        if (name === "career_send_claim") { if (claimed) return { data: { accounts: [] }, error: null }; claimed = true; return { data: { accounts: [{ user_id: "u1", provider: "gmail", items: [it] }] }, error: null }; }
        if (name === "career_send_go") return { data: "go", error: null };
        if (name === "career_send_complete") { outcomes.push(...args.p.results); return { data: args.p.results.map((x: any) => x.outcome), error: null }; }
        return { data: null, error: { message: `unexpected ${name}` } };
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if ((init?.method ?? "GET") === "POST") { posts.push(url.pathname); return Response.json({ id: "new-id", threadId: "new-thread" }); }
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: inSent ? [{ id: "old-id" }] : [] });
        if (/\/messages\/old-id$/.test(url.pathname)) return Response.json({ id: "old-id", threadId: "old-thread", payload: { headers: [{ name: "To", value: to }, { name: "Subject", value: subject }] } });
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    };
    await runSendWorker(deps, { worker: "w", deadlineMs: 10_000 });
    const o = outcomes[0]?.outcome;
    const want = inSent ? "already_sent" : lapsed ? "lapsed" : "sent";
    const why = posts.length > (want === "sent" ? 1 : 0) ? `sent ${posts.length} times` : o !== want ? `want ${want}, got ${o}` : want === "lapsed" && !/approval lapsed/.test(outcomes[0]?.detail ?? "") ? "no readable reason" : null;
    rep.grade(`${lapsed ? "lapsed" : "fresh"}/${inSent ? "in_sent" : "not_in_sent"}`, why, { attempts, outcomes });
  }
  rep.done(R3_COUNTS.lapse);
}

// ------------------------------------------------------------------------------------------------ handoff
const REASONS = ["opted_out", "bad_address", "already_emailed"] as const;
async function handoffBattery() {
  const rep = new Report("handoff");
  const r = rng(SEED + 3);
  const T = Date.parse("2026-10-31T15:00:00Z");
  for (let i = 0; i < R3_COUNTS.handoff; i++) {
    const store = memoryOutreachStore();
    const U = "u1", HERE = "chat";
    const n = 1 + Math.floor(r() * 10);
    const ds: Omit<OutreachDraft, "id" | "batch_id" | "thread_id">[] = [];
    for (let k = 1; k <= n; k++) {
      const recipient = { name: `Person ${k}`, firm: "Acme", title: "Analyst", school: "", email: `p${i}-${k}@acme.example`, source: "contacts.csv" };
      const d = { n: k, recipient, subject: `Question ${k}`, body: `Hi Person ${k},\n\nWould you have 15 minutes?`, footer: footerOf("Sam Lee"), shared: [], status: "shown" as const, hash: "",
        approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(T - 60_000).toISOString() };
      d.hash = await payloadHash(messageOf(d));
      ds.push(d);
    }
    const saved = await store.saveBatch(U, HERE, ds, T - 60_000);
    store.setIntent(HERE, OUTREACH_INTENT);
    const refuse = new Map<string, string>();
    for (const d of saved) if (r() < 0.35) refuse.set(d.id, pick(r, REASONS));
    let handed: string[] = [];
    const res = await outreachTurn({ message: "send all", userId: U, threadId: HERE, now: T, store, gmailConnected: async () => true,
      onApproved: async (_u, items) => { handed = items.map((x) => x.draftId); return items.filter((x) => refuse.has(x.draftId)).map((x) => ({ draftId: x.draftId, reason: refuse.get(x.draftId)! })); } });
    const all = refuse.size === n, none = refuse.size === 0;
    let why: string | null = null;
    if (!res || res.status !== "approved") why = `not approved: ${res?.status}`;
    else if (handed.length !== n) why = "every approved draft is handed to the rail";
    else if (all && /They go from your Gmail/.test(res.reply)) why = "says they go when none will";
    else if (!all && !/They go from your Gmail/.test(res.reply)) why = "says nothing of the ones that go";
    else if (!none && !/Won't be sent:/.test(res.reply)) why = "never says which won't be sent";
    else if (none && /Won't be sent/.test(res.reply)) why = "says one won't be sent when all go";
    else for (const d of saved) {
      const listed = new RegExp(`Won't be sent:[^\\n]*\\b${d.n} \\(Person ${d.n}:`).test(res.reply);
      if (refuse.has(d.id) !== listed) { why = `draft ${d.n} ${refuse.has(d.id) ? "refused but not said" : "said refused but it goes"}`; break; }
    }
    rep.grade(all ? "all_refused" : none ? "none_refused" : "some_refused", why, res?.reply.slice(0, 300));
  }
  rep.done(R3_COUNTS.handoff);
}

// ------------------------------------------------------------------------------------------------ facts (D-007)
const FIRMS = ["Acme Capital", "Blue Harbor Partners", "Northwind Advisors", "Granite Street Bank"];
const TITLES = ["Partner", "Principal", "Founder", "Recruiter", "Professor"];
const TEAMS = ["healthcare coverage", "credit research", "campus recruiting", "fintech investing"];
const EVENTS = ["Congrats on your promotion", "Congratulations on your new role", "I saw your recent appointment", "I heard you were promoted recently"];
function factsBattery() {
  const rep = new Report("facts");
  const r = rng(SEED + 4);
  const facts = ["BS Economics, NYU", "Interned at Riverbend Group"];
  for (let i = 0; i < R3_COUNTS.facts; i++) {
    const firm = pick(r, FIRMS), title = pick(r, TITLES), team = pick(r, TEAMS);
    const kind = pick(r, ["invented_title", "honest_title", "invented_team", "honest_team", "invented_event"] as const);
    const other = pick(r, TITLES.filter((t) => t !== title));
    const row = { name: "Maya Chen", firm, title: kind === "honest_team" ? `${title}, ${team}` : title, school: "", email: RECIP, source: "contacts.csv" };
    const line = kind === "invented_title" ? `I saw you're a ${other.toLowerCase()} at ${firm} now.` : kind === "honest_title" ? `I saw you're a ${title.toLowerCase()} at ${firm}.`
      : kind === "invented_team" ? `You lead the ${pick(r, TEAMS.filter((t) => t !== team))} team at ${firm}.` : kind === "honest_team" ? `You lead the ${team} team at ${firm}.` : `${pick(r, EVENTS)} at ${firm}.`;
    const text = `Hi Maya,\n\n${line} Would you have 15 minutes to talk?`;
    const lock = outreachLock(text, { facts, recipient: row, shared: [] });
    const honest = kind.startsWith("honest");
    rep.grade(kind, lock.pass === honest ? null : honest ? `an honest sentence was refused (${[...lock.untraced, ...lock.misattributed].join("; ")})` : "an invented claim about them passed", line);
  }
  rep.done(R3_COUNTS.facts);
}

Deno.test(`outreach r3: opt-outs in 25 languages are stops; the same words quoted, from a colleague, or a yes are not (${R3_COUNTS.optout})`, () => optoutBattery());
Deno.test(`outreach r3: an opt-out after Gmail's snippet is read whole; an out-of-office is no answer (${R3_COUNTS.long})`, () => longBattery());
Deno.test(`outreach r3: a retried email whose approval lapsed is never sent again (${R3_COUNTS.lapse})`, () => lapseBattery());
Deno.test(`outreach r3: an approval the rail refuses is never said to be going (${R3_COUNTS.handoff})`, () => handoffBattery());
Deno.test(`outreach r3: D-007, nothing about the recipient that is not on their row (${R3_COUNTS.facts})`, () => factsBattery());
