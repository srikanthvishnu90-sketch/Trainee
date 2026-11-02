// FEATURE 10 (2026-10-25): networking from chat, code-first on the live path (agent-chat/handler-career.ts), before the
// router. Three asks, each answered from the person's OWN contacts only (there is no people source by decision: D-018a):
//   (a) a contacts CSV pasted in the message, or attached (`attachments` on the request): imported into the person's
//       contacts by career_contacts.ts importContactsFile (the same import the brain uses), with a coverage fraction.
//       Contacts are the ACCOUNT's — one list per person in the outreach store (career_watch_kv 'career:contacts'),
//       like every outreach record; the thread state carries the turn's working copy (hydrated below);
//   (b) "who do I know at Stripe", "find my connections at X": the contacts at that firm, or plainly none, and how to add them;
//   (c) "email Maya at Stripe about the data analyst role", "draft intros to my 3 contacts at X": drafts written by
//       career_outreach.ts draftFor (every claim traced to a confirmed fact by outreachLock) and shown as the outreach
//       batch, the approval card outreachTurn already answers ("send 1", "send all", "redo 2"): one approval per exact
//       message, hash-bound. Sending stays the scheduled run's (career-proactive, CAREER_OUTREACH_SEND), through the
//       database's claim (caps, do-not-contact, recipient cap). Nothing here sends.
// Never an invented address: a recipient is a row of the person's own contacts, with the address on that row, or no one.
// The model writes only when the caller passes one (CAREER_NETWORKING_DRAFT=on, metered); without it the reply names who
// would be written to and that nothing was drafted.
import { type ContactRow, contactsOf, firmKey, importContactsCsv, importContactsFile, MX_NOT_WIRED, type MxResolver, normalizeFirm, sameFirm, verifyRows } from "./career_contacts.ts";
import { legacyRows } from "./career_referrals.ts";
import { parsePeopleAsk, type PeopleDeps, type PersonRec, peopleTurn } from "./career_people.ts";
import { chatAsk, companyKey } from "./career_people_import.ts";
import { batchMessages, confirmed, draftFor, parseBatchYes, parseOutreachReply, type Drafted, emailHash, footerOf, messageOf, type ModelFn, OUTREACH_INTENT, type OutreachDraft,
  type KeyedContact, type OutreachStore, payloadHash, type Recipient, recordOutreach, blockedAddresses, BLOCKED_WHY, draftLangOf } from "./career_outreach.ts";
import type { EventStore } from "./agent/timeline.ts";
import { siteAsk, siteOfLink, trackAsk, trackTurn } from "./career_outreach_track.ts";
import { factHost, factQuestion, firmDomains, factsFromPage, factsFromPaste, factsFromStatement, isInstruction, type RecipientFact } from "./career_outreach_personalize.ts";
import { fetchHtml, pinnedGet } from "./career_people_page.ts";

export const IMPORT_INTENT = "career_contacts_import";
export const AT_INTENT = "career_contacts_at";
export const DRAFT_INTENT = "career_networking_draft";
export const SIGNATURE_INTENT = "career_outreach_signature";
export const FORGET_INTENT = "career_contacts_forget";
export const FACTS_INTENT = "career_recipient_facts"; // PERSONALIZED OUTREACH: the one question, and facts saved about someone
export const MAX_FILE_CHARS = 2_000_000, MAX_FILES = 3, LIST_MAX = 15;
export const ADD_CONTACTS = "To add people, download your LinkedIn connections (LinkedIn: Settings, Data privacy, Get a copy of your data, Connections) and send me the CSV here, or paste rows under a header line like Name,Company,Title,Email.";
export const NO_FINDER = "I don't have a people database or an email finder, and I won't guess names or addresses.";
export const SIGN_ASK = "How do you sign your emails? Send your name the way you want it at the bottom (and a phone or school line if you like), and I'll write the drafts.";

export interface Attachment { name: string; mime?: string; text: string | null }
export type Ask =
  | { kind: "who"; firm: string }
  | { kind: "draft"; target: Target; topic: string | null };
export type Target =
  | { by: "name"; name: string; firm: string | null }
  | { by: "group"; firm: string; count: number | null; role: string | null };

const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9@.]+/g, " ").trim();
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
const numberOf = (w: string | undefined) => (w ? (/^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] ?? null) : null);
const NUMW = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
const GROUP = "(?:contacts|connections|people|friends|folks|alums|alumni)";
const FILLER = /^(?:(?:so|ok|okay|hey|hi|and|now|also|please|pls|can you|could you|would you|will you|help me|actually|wait|oh|oops|no)[, ]+)+/i;
// A firm as typed: the words after "at"/"from", up to the topic or the end.
function firmOf(raw: string): string | null {
  // ROUTING SCENARIOS (2026-10-29): a second ask after the firm ("... at Stripe and apply to Stripe") is not part of it.
  const f = raw.replace(/\s+(?:about|regarding|re|for|who|that|to|and ask|asking|right now|please|and (?:apply|cancel|withdraw|connect|send|message|draft|find|show|check))\b.*$/i, "").replace(/[?.!,;:]+$/, "").replace(/^the\s+/i, "").trim();
  if (!f || f.length > 60 || /[@/\\<>]/.test(f) || f.split(/\s+/).length > 6) return null;
  return f;
}

// (b) and (c): what the message asks, or null when it is not a networking ask (the rest of the chain answers it).
export function parseNetworkingAsk(message: string): Ask | null {
  const t = chatAsk(message).replace(FILLER, "").replace(/[?!.]+$/, "").replace(/,?\s+instead$/i, "").trim();
  if (!t || t.length > 300) return null;
  const who = [
    /^(?:who|which (?:people|contacts|connections))(?: else)? (?:do i know|do i have|in my (?:network|contacts|connections)|(?:are|is) (?:in )?my (?:contacts|connections|network))(?: (?:who |that )?works?| working)? (?:at|from|in) (.+)$/i,
    /^(?:find|show|list|get|give|pull up)(?: me)? (?:all )?(?:of )?(?:my |the )?(?:connections|contacts|people i know|network)(?: i have)? (?:at|from) (.+)$/i,
    /^(?:do i (?:know|have) (?:anyone|anybody|any (?:contacts|connections))|(?:is there )?(?:anyone|anybody) (?:i know|in my (?:network|contacts|connections))) (?:at|from) (.+)$/i,
    /^find(?: me)? (?:someone|somebody|anyone|anybody|a person|people|a contact|contacts) (?:at|from) (.+)$/i,
    /^(?:my|any) (?:contacts|connections) (?:at|from) (.+)$/i,
    // "I want to reach people at Stripe": the people on file there, named, as "who do I know at Stripe" answers.
    /^(?:i(?: want| need| would like|'d like| wanna) to |let'?s )?(?:reach|contact|connect with|network with|get in touch with) (?:people|someone|somebody|anyone|anybody|folks|contacts|connections)(?: i know)? (?:at|from) (.+)$/i,
  ];
  for (const rx of who) {
    const m = rx.exec(t);
    if (m) { const firm = firmOf(m[1]); return firm ? { kind: "who", firm } : null; }
  }
  const verb = new RegExp(`^(?:email|e-mail|emial|emal|eamil|message|reach out to|intro(?:duce)? me to|write(?: an?)?(?: (?:email|note|intro|message))? to|send(?: an?)?(?: (?:email|intro|note|message))? to|draft(?: me)?(?: an?| some| ${NUMW})?(?: cold| short| quick| networking)?(?: (?:emails?|intros?|introductions?|notes?|messages?|outreach(?: emails?)?))(?: to| for)?) (.+)$`, "i").exec(t);
  if (!verb) return null;
  // Anything routed through LinkedIn, Indeed or Handshake is never a draft, and "via LinkedIn" is never part of a name
  // (trackTurn refuses it).
  if (/\blinked ?in\b|\beasy ?apply\b/i.test(t) || siteAsk(t)) return null;
  const verbCount = numberOf(verb[1]);
  let rest = verb[2].trim(), topic: string | null = null;
  const tm = /\s+(?:(?:about|regarding|re|asking about|to ask about)(?=\s)|re:|for (?:an?|the|my)(?=\s))\s*(.+)$/i.exec(rest);
  if (tm) {
    topic = (/^for /i.test(tm[0].trim()) ? tm[0].trim().replace(/^for\s+/i, "") : tm[1]).replace(/https?:\S+|\S+@\S+/g, "").trim().slice(0, 200) || null;
    rest = rest.slice(0, tm.index).trim();
  }
  rest = rest.replace(/[?.!,;:]+$/, "").trim();
  // "my 3 contacts at X", "people at X", "everyone I know at X", "someone at X"
  const g = new RegExp(`^(?:all (?:of )?)?(?:my |the )?(?:${NUMW} )?(?:${GROUP})(?: i (?:know|have))? (?:at|from) (.+)$`, "i").exec(rest);
  if (g) { const firm = firmOf(g[2]); return firm ? { kind: "draft", topic, target: { by: "group", firm, count: numberOf(g[1]) ?? verbCount, role: null } } : null; }
  const e = /^(everyone|everybody|anyone|anybody|someone|somebody|a person)(?: i know)? (?:at|from) (.+)$/i.exec(rest);
  if (e) { const firm = firmOf(e[2]); return firm ? { kind: "draft", topic, target: { by: "group", firm, count: /^some|^a person/i.test(e[1]) ? 1 : verbCount, role: null } } : null; }
  // "Maya at Stripe", "Maya Chen", "a recruiter at Stripe", "the hiring manager at X"
  const at = /^(.+?) (?:at|from) (.+)$/i.exec(rest);
  const who2 = (at ? at[1] : rest).trim(), firm = at ? firmOf(at[2]) : null;
  if (at && !firm) return null;
  const role = /^(?:an?|the|my|some|any)\s+(.+)$/i.exec(who2);
  if (role && firm && /^[a-z][a-z -]{1,40}$/i.test(role[1])) {
    const many = /s$/i.test(role[1].trim()) && !/ss$/i.test(role[1].trim());
    return { kind: "draft", topic, target: { by: "group", firm, count: many ? verbCount : 1, role: role[1].trim().replace(/s$/i, "") } };
  }
  // NETWORKING SCENARIOS (2026-10-29): a plural role with no article ("reach out to engineers at Stripe", "draft intros to
  // technical recruiters at X") is the group of people with that title among their contacts at the firm, never a person
  // named "engineers".
  const plur = /^(?:all\s+(?:of\s+)?(?:the\s+)?)?((?:[a-z][a-z-]*\s+){0,3}(?:recruiter|engineer|manager|scientist|designer|analyst|director|lead|founder|partner|developer|associate|intern|executive|banker|consultant|researcher|architect|specialist|coordinator|officer|vp|leader|head|alum)s)$/i.exec(who2);
  if (plur && firm) return { kind: "draft", topic, target: { by: "group", firm, count: verbCount, role: plur[1].trim().replace(/s$/i, "") } };
  const words = who2.split(/\s+/);
  // ROUTING SCENARIOS (2026-10-29): "email status" / "email updates" are the send rail's asks, never a draft to "status".
  const STOP = /^(?:my|the|a|an|your|our|me|him|her|them|it|this|that|these|those|resume|cv|cover|letter|application|everyone|someone|anyone|recruiters?|people|contacts|connections|status|updates?)$/i;
  if (words.length < 1 || words.length > 3 || words.some((w) => !/^[A-Za-z][A-Za-z.'’-]*$/.test(w) || STOP.test(w))) return null;
  return { kind: "draft", topic, target: { by: "name", name: who2, firm } };
}

// (a): a contacts CSV pasted in the message: a header with a name column and a company or email column, and at least one row.
export function pastedCsv(message: string): string | null {
  const text = String(message ?? "");
  if (!/\n/.test(text) || !/,/.test(text)) return null;
  const r = importContactsCsv("pasted", text);
  return !r.error && r.rows.length ? text : null;
}

// One person once: the same name at the same firm on two lists is one contact, kept as the row with a usable address.
function uniq(rows: ContactRow[]): ContactRow[] {
  const by = new Map<string, ContactRow>();
  for (const r of rows) {
    const k = `${plain(r.name)}@${plain(r.firm)}`, x = by.get(k);
    if (!x || (!x.verified && r.verified) || (!x.email && r.email)) by.set(k, r);
  }
  return [...by.values()];
}
const atFirm = (rows: ContactRow[], firm: string) => uniq(rows.filter((r) => r.firm && (sameFirm(r.firm, firm) || sameFirm(r.firm_raw, firm))));
const lineOf = (r: ContactRow) => `- ${r.name}${r.title ? `, ${r.title}` : ""}${r.email ? ` (${r.email})` : " (no email address)"}`;
const fileWord = (rows: ContactRow[]) => { const f = [...new Set(rows.map((r) => r.file))]; return f.length === 1 ? f[0] : `${f.length} lists`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const CONTACTED = "you already have a draft or email to them";
// Why a row can't be written to, or null when it can (draft_outreach's rule: an address that passed every check that ran,
// never anyone already written to, never the do-not-contact list).
async function heldWhy(r: ContactRow, contacted: Set<string>, dnc: Set<string>, blocked: Map<string, "opted_out" | "bounced"> = new Map()): Promise<string | null> {
  if (!r.email) return "no email address in your contacts, and I never guess one";
  if (!r.verified) {
    const c = r.check;
    return c?.syntax === "fail" ? `"${r.email}" is not a valid address` : c?.role === "flagged" ? `${r.email} is a shared inbox, not a person` : c?.disposable === "flagged" ? `${r.email} is a throwaway address` : c?.mx === "fail" ? `${r.email}'s domain has no mail server` : `${r.email} did not pass the address checks`;
  }
  if (contacted.has(r.email.toLowerCase())) return CONTACTED;
  if (dnc.has(await emailHash(r.email))) return "they asked not to be contacted";
  const b = blocked.get(r.email.toLowerCase());
  if (b) return BLOCKED_WHY[b];
  return null;
}
const recipientOf = (r: ContactRow): Recipient => ({ name: r.name, firm: r.firm, title: r.title, school: r.school, email: r.email!, source: r.row ? `${r.file}, row ${r.row}` : r.file,
  ...(r.address ? { address: r.address } : {}), ...(r.facts?.length ? { facts: r.facts } : {}) });

// FAMILY NETWORKING: an address the person typed for the person they named ("email Maya Chen at Stripe about a coffee
// chat, her email is maya@stripe.com"): taken out of the ask, and kept as their own contact row (never guessed, never
// a name made up for an address).
const ADDR = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/;
export function typedAddress(message: string): { text: string; email: string | null } {
  const m = String(message ?? "");
  const a = ADDR.exec(m);
  if (!a || (m.match(new RegExp(ADDR.source, "g")) ?? []).length > 1) return { text: m, email: null };
  const clause = new RegExp(`\\s*(?:[,;.(-]\\s*)?(?:and\\s+)?(?:(?:her|his|their|the|my contact's)\\s+)?(?:(?:e-?mail|email address|address)\\s*(?:is|:|=)?\\s*|(?:she|he|they)(?:'s| is| are)\\s+(?:at\\s+)?|at\\s+|<)?${a[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>?\\)?`, "i");
  const text = m.replace(clause, "").replace(/\s+/g, " ").trim();
  return { text, email: a[0].toLowerCase() };
}
export const TYPED_FILE = "what you typed in chat";
async function keepTyped(o: NetworkingDeps, name: string, firm: string | null, email: string): Promise<void> {
  const book = bookOf(o);
  if ((await book.byEmail(email)).length) return;
  const row = Math.max(0, ...(await book.inFile(TYPED_FILE)).map((r) => r.row)) + 1;
  const f = firm ? normalizeFirm(firm) : "";
  const [checked] = await verifyRows([{ file: TYPED_FILE, row, name, email, firm: f, firm_raw: firm ?? "", company: f, title: "", school: "", connected_on: null }], o.mx ?? MX_NOT_WIRED);
  await book.put([checked]);
}

export interface NetworkingDeps {
  message: string; userId: string; threadId: string; now: number;
  state: Record<string, unknown>; // the thread's career state (ctx): the contacts working copy and the profile
  attachments?: Attachment[];
  store: OutreachStore; events?: EventStore | null;
  model: ModelFn | null; // null: drafting is not switched on here (no model call is made)
  mx?: MxResolver;
  previousAsk?: () => Promise<string | null>; // the person's message before this one (for the signature answer)
  // R2: whether follow-up reminders are pushed (CAREER_OUTREACH_FOLLOWUPS=on, read by the caller) and the channel one
  // would reach this person on (null: none linked). Injected, never read from the environment here.
  reminderPush?: boolean;
  textingChannel?: () => Promise<string | null>;
  people?: PeopleDeps | null; // D-033 people finding, wired by the caller; absent or null: no people turn
}
export interface NetworkingResult { reply: string; intent: string; status: string; parts?: string[] }

// Contacts belong to the person's account, not a chat (architect ruling R1, 2026-10-27), at any size: they live in
// career_account_contacts (20261027160100) and every read here is an indexed, paged query for exactly what the ask needs
// (the people at one firm, the people of one name, one address, a count); no chat keeps a copy, so no copy is capped and
// none can go stale. A chat state saved before this still carrying `contacts` is moved to the account once (skipping
// anyone the person told Trainee to forget) and dropped from the chat. Writes carry the account's privacy epoch read
// at the start of the turn, so a turn that began before "forget everything" writes nothing after it. People the router
// kept from an earlier export (the profile's connections) are read from the profile as before.
// A store without the account methods keeps the old per-chat list exactly (o.state.contacts).
const rowKey = (r: ContactRow) => `${r.file}#${r.row}`;
// Who a row is: the address, else the name at the firm. The forgotten list remembers this, so another list's row of the
// same person can't bring them back either.
export const personKey = (r: ContactRow) => (r.email ? `e:${r.email.trim().toLowerCase()}` : `n:${plain(r.name)}@${plain(r.firm)}`);
// The address that may make a domain the firm's verified one: only one the person gave (#361 re-review, 2026-11-01).
const givenEmail = (r: ContactRow): string | null => (r.discovered || r.unverified ? null : r.email ?? null);
// A row with the keys the account table indexes: what any writer (this turn, people finding) hands putContacts.
export const keyedContact = (r: ContactRow): KeyedContact => ({ row_key: rowKey(r), person_key: personKey(r), file: r.file, name_key: plain(r.name),
  email: r.email ? r.email.trim().toLowerCase() : null, firm_key: firmKey(r.firm), firm_raw_key: firmKey(r.firm_raw), data: r });
type Sel = { all?: boolean; linkedin?: boolean; rowKeys?: string[] };
interface Book {
  atFirm(firm: string): Promise<ContactRow[]>;      // one person once (uniq), as atFirm did
  named(nameKey: string, every?: boolean): Promise<ContactRow[]>; // plain(name) = nameKey or starts `${nameKey} `; every: each row, not one per person
  byEmail(email: string): Promise<ContactRow[]>;
  inFile(file: string): Promise<ContactRow[]>;
  total(): Promise<{ total: number; files: string }>; // how many, and "from" what (a file's name, or "N lists")
  put(rows: ContactRow[], o?: { replaceFile?: string; unlessForgotten?: boolean }): Promise<boolean>;
  forget(sel: Sel): Promise<number | null>;
}
const books = new WeakMap<NetworkingDeps, Book>();
function bookOf(o: NetworkingDeps): Book {
  let b = books.get(o);
  if (!b) { b = makeBook(o); books.set(o, b); }
  return b;
}
function makeBook(o: NetworkingDeps): Book {
  const b = makeBookInner(o);
  const isNamed = (r: ContactRow, k: string) => { const n = plain(r.name); return !!k && (n === k || n.startsWith(`${k} `)); };
  return {
    ...b,
    atFirm: async (firm) => uniq([...await b.atFirm(firm), ...await savedPeople(o, { firm })]),
    named: async (k, every) => {
      const rows = [...await b.named(k, every), ...(await savedPeople(o, { name: k })).filter((r) => isNamed(r, k))];
      return every ? rows : uniq(rows);
    },
  };
}
function makeBookInner(o: NetworkingDeps): Book {
  // People the router kept from an earlier export (the profile's connections and graph people), given the same checks.
  let legacyP: Promise<ContactRow[]> | null = null;
  const legacy = () => legacyP ??= (async () => {
    const p: any = o.state.profile ?? {}, g: any = o.state.graph ?? o.state.graphStore ?? {};
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const older = legacyRows([...list(g.people), ...list(p._careerGraphPeople), ...list(p.connections)]);
    return older.length ? await verifyRows(older, o.mx ?? MX_NOT_WIRED) : [];
  })();
  const named = (rows: ContactRow[], k: string) => rows.filter((r) => { const n = plain(r.name); return !!k && (n === k || n.startsWith(`${k} `)); });
  const s = o.store;
  if (!(s.contactsSummary && s.contactsAtFirm && s.contactsNamed && s.contactsByEmail && s.contactsInFile && s.putContacts && s.forgetContacts)) {
    // The old per-chat list (a store without the account table).
    const mine = () => contactsOf(o.state);
    return {
      atFirm: async (firm) => atFirm([...mine(), ...await legacy()], firm),
      named: async (k, every) => { const rows = named([...mine(), ...await legacy()], k); return every ? rows : uniq(rows); },
      byEmail: async (e) => mine().filter((r) => (r.email ?? "").toLowerCase() === e.toLowerCase()),
      inFile: async (f) => mine().filter((r) => r.file === f),
      total: async () => { const all = [...mine(), ...await legacy()]; return { total: all.length, files: fileWord(all) }; },
      put: async (rows, opt = {}) => { const keys = new Set(rows.map(rowKey)); o.state.contacts = [...mine().filter((r) => !keys.has(rowKey(r)) && (opt.replaceFile === undefined || r.file !== opt.replaceFile)), ...rows]; return true; },
      forget: async (sel) => {
        const keys = new Set(sel.rowKeys ?? []), all = mine();
        const people = new Set(all.filter((r) => sel.all || (sel.linkedin && (/connections/i.test(r.file) || (r as any).linkedin_export === true)) || keys.has(rowKey(r))).map(personKey));
        o.state.contacts = all.filter((r) => !people.has(personKey(r)));
        return all.length - contactsOf(o.state).length;
      },
    };
  }
  // The account's privacy epoch, read once at the start of the turn (networkingTurn starts it); a write after it moved is
  // refused by the database (null), and an unreadable epoch writes nothing.
  const epoch = epochOf(o);
  return {
    atFirm: async (firm) => uniq([...await s.contactsAtFirm!(o.userId, firmKey(firm)), ...(await legacy()).filter((r) => sameFirm(r.firm, firm) || sameFirm(r.firm_raw, firm))]),
    named: async (k, every) => { const rows = [...await s.contactsNamed!(o.userId, k), ...named(await legacy(), k)]; return every ? rows : uniq(rows); },
    byEmail: (e) => s.contactsByEmail!(o.userId, e),
    inFile: (f) => s.contactsInFile!(o.userId, f),
    total: async () => {
      const [x, old] = await Promise.all([s.contactsSummary!(o.userId), legacy()]);
      const files = [...new Set([...x.files, ...old.map((r) => r.file)])];
      const count = x.fileCount + (old.length ? 1 : 0);
      return { total: x.total + old.length, files: count === 1 ? files[0] : `${count} lists` };
    },
    put: async (rows, opt = {}) => {
      const e = await epoch;
      if (e === null) return false;
      return (await s.putContacts!(o.userId, e, rows.map(keyedContact), opt)) !== null;
    },
    forget: async (sel) => { const e = await epoch; return e === null ? null : await s.forgetContacts!(o.userId, e, sel); },
  };
}
const epochs = new WeakMap<NetworkingDeps, Promise<number | null>>();
function epochOf(o: NetworkingDeps): Promise<number | null> {
  let p = epochs.get(o);
  if (!p) { p = o.store.accountEpoch ? o.store.accountEpoch(o.userId).then((e) => e, () => null) : Promise.resolve(0); epochs.set(o, p); }
  return p;
}

const tracked_ = (o: NetworkingDeps) => trackTurn({ message: o.message, userId: o.userId, threadId: o.threadId, now: o.now, store: o.store, events: o.events,
  facts: (((o.state.profile as any)?.facts ?? []) as unknown[]), model: o.model,
  reminderPush: o.reminderPush === true, textingChannel: o.textingChannel,
  contactsWithEmail: async (name) => (await bookOf(o).named(plain(name))).filter((r) => r.email && plain(r.name).split(" ")[0] === plain(name)).map((r) => `${r.name}${r.firm ? ` at ${r.firm}` : ""}`) });

// LinkedIn, Indeed and Handshake: an ask to act on one of them (or a link to one) declined plainly, naming the site, with
// what Trainee can do instead (career_outreach_track.ts siteAsk). The chat runs this before every apply, link-read and
// batch turn, so nothing is queued, read or left waiting for a "yes". Null when the message is not such an ask, and for a
// page sent to find people on ("find people at Ramp on <linkedin link>"): the people turn refuses that one unopened itself
// (career_people.ts blocked_site), and no apply or batch turn takes it.
export async function siteRefusedTurn(o: NetworkingDeps): Promise<NetworkingResult | null> {
  if (!siteAsk(o.message) || parsePeopleAsk(o.message)?.kind === "page") return null;
  return await tracked_(o);
}

export async function networkingTurn(o: NetworkingDeps): Promise<NetworkingResult | null> {
  epochOf(o); // the epoch as the turn starts
  // A chat state saved before contacts moved to the account: moved there once, minus anyone forgotten, then dropped.
  const old = contactsOf(o.state);
  if (old.length && o.store.putContacts) {
    const moved = await bookOf(o).put(old, { unlessForgotten: true }).catch((e) => { console.error("networking: move this chat's contacts to the account:", e instanceof Error ? e.message : e); return null; });
    if (moved !== null) delete o.state.contacts; // moved, or refused because an erase ran (then they must not come back)
  }
  return await networkingTurnInner(o);
}

// "forget my contacts", "delete my linkedin connections", "remove Maya Chen from my contacts": deleted from the person's
// contacts (the account's: every conversation), each person remembered as forgotten.
export function forgetAsk(message: string): { all: true } | { linkedin: true } | { name: string } | null {
  const t = String(message ?? "").replace(/\s+/g, " ").trim().replace(FILLER, "").replace(/[?!.]+$/, "").trim().toLowerCase();
  if (!/^(?:forget|delete|remove|erase|clear|wipe)\b/.test(t) || t.length > 120) return null;
  if (/^(?:forget|delete|remove|erase|clear|wipe) (?:all (?:of )?)?(?:my |the )?(?:linked ?in) (?:contacts|connections|export|list)$/.test(t)) return { linkedin: true };
  if (/^(?:forget|delete|remove|erase|clear|wipe) (?:all (?:of )?)?(?:my |the )?(?:contacts|connections|contact list|contacts list|imported contacts)$/.test(t)) return { all: true };
  const m = /^(?:forget|delete|remove|erase) ([a-z][a-z.'-]*(?: [a-z][a-z.'-]*){0,2}) from (?:my |the )?(?:contacts|connections|contact list|list)$/.exec(t);
  return m ? { name: m[1] } : null;
}
async function forgetTurn(o: NetworkingDeps, a: NonNullable<ReturnType<typeof forgetAsk>>): Promise<NetworkingResult> {
  const book = bookOf(o);
  const notSaved: NetworkingResult = { reply: "I couldn't delete them from your contacts just now, so nothing was deleted. Please try again in a minute.", intent: FORGET_INTENT, status: "not_saved" };
  let sel: Sel, what: string | null = null;
  if ("name" in a) {
    const want = plain(a.name);
    const rows = (await book.named(want.split(" ")[0], true)).filter((r) => plain(r.name) === want || (!want.includes(" ") && plain(r.name).split(" ")[0] === want));
    const whoIs = (r: ContactRow) => `${plain(r.name)}@${plain(r.firm)}`; // one person: the same name at the same firm, on any list
    if (new Set(rows.map(whoIs)).size > 1) {
      return { reply: `More than one ${a.name} is in your contacts: ${[...new Set(rows.map((r) => `${r.name}${r.firm ? ` at ${r.firm}` : ""}`))].join("; ")}. Say the full name. Nothing was deleted.`, intent: FORGET_INTENT, status: "which" };
    }
    if (!rows.length) return { reply: `No one named ${a.name} is in your contacts, so nothing was deleted.`, intent: FORGET_INTENT, status: "nothing" };
    // Every row of that person, on any list (the same name at the same firm).
    sel = { rowKeys: [...new Set(rows.map(rowKey))] };
    what = rows[0].name;
  } else sel = "all" in a ? { all: true } : { linkedin: true };
  // A deletion is said only once the account holds it.
  const n = await book.forget(sel).catch((e) => { console.error("networking: forget contacts:", e instanceof Error ? e.message : e); return null; });
  if (n === null) return notSaved;
  if (!n) return { reply: `There are no ${"linkedin" in a ? "LinkedIn " : ""}contacts on record to delete.`, intent: FORGET_INTENT, status: "nothing" };
  return { reply: `Deleted ${what ?? `${n} ${"linkedin" in a ? "LinkedIn " : ""}contact${n === 1 ? "" : "s"}`} from your contacts, in every conversation. They won't come back unless you send them to me again. Emails already drafted or sent stay on record.`, intent: FORGET_INTENT, status: "forgotten" };
}

// The people turn (#222) reads and writes a contacts list on the chat; contacts belong to the account (R1, #225). So it
// sees the account's rows for the firm or name asked about (never the whole list), what it adds goes to the account, no
// copy stays on the chat, and its "forget my LinkedIn contacts" forgets them on the account too.
async function peopleWithBook(o: NetworkingDeps): Promise<NetworkingResult | null> {
  if (!o.people) return null;
  const ask = parsePeopleAsk(o.message), book = bookOf(o);
  const pre: ContactRow[] = [];
  // "who do I know" / alumni: people they know, never someone web discovery found for them (2026-10-29).
  if (ask?.kind === "who" || ask?.kind === "alumni") pre.push(...(await book.atFirm(ask.firm).catch(() => [])).filter((r) => !r.discovered));
  if (ask?.kind === "intro") {
    if (ask.firm) pre.push(...await book.atFirm(ask.firm).catch(() => []));
    if (ask.name) pre.push(...await book.named(plain(ask.name).split(" ")[0], true).catch(() => []));
  }
  const preKeys = new Set(pre.map(rowKey));
  const had = o.state.contacts;
  if (pre.length) o.state.contacts = pre;
  let r: NetworkingResult | null;
  try {
    r = await peopleTurn(o);
  } finally {
    const added = contactsOf(o.state).filter((x) => !preKeys.has(rowKey(x)));
    if (had === undefined) delete o.state.contacts; else o.state.contacts = had;
    if (added.length) {
      const files = [...new Set(added.map((x) => x.file))];
      await book.put(added, files.length === 1 ? { replaceFile: files[0] } : {}).catch((e) => { console.error("networking: keep the imported contacts on the account:", e instanceof Error ? e.message : e); return false; });
    }
  }
  if (r && ask?.kind === "forget" && (ask.what === "linkedin" || ask.what === "all")) {
    await book.forget(ask.what === "all" ? { all: true } : { linkedin: true }).catch(() => null);
  }
  return r;
}

async function networkingTurnInner(o: NetworkingDeps): Promise<NetworkingResult | null> {
  // PERSONALIZED OUTREACH: what the person tells Trainee about someone they write to (the answer to the one question, a
  // pasted bio, a team page or filing link, "Maya spoke at ..."), before anything else reads the message.
  const facts = await factIntakeTurn(o); if (facts) return facts;
  // PEOPLE FINDING (D-033): the LinkedIn export kept per person, Gmail correspondents, public pages, job emails, intros.
  const people = await peopleWithBook(o); if (people) return people;
  const files = (o.attachments ?? []).slice(0, MAX_FILES);
  const pasted = files.length ? null : pastedCsv(o.message);
  if (files.length || pasted) return await importTurn(o, files, pasted);
  const fg = forgetAsk(o.message);
  if (fg) return await forgetTurn(o, fg);
  // FAMILY NETWORKING: after the draft: marked sent by the person, replies, follow-up reminders, the list of who they
  // reached out to, a follow-up drafted, and LinkedIn automation refused (career_outreach_track.ts).
  const tracked = await tracked_(o);
  if (tracked) return tracked;
  const typed = typedAddress(o.message);
  let ask = parseNetworkingAsk(typed.text);
  // An address with no name for it: never a name made up from the address; ask once for who it is.
  if (typed.email && !(ask?.kind === "draft" && ask.target.by === "name")) {
    ask = parseNetworkingAsk(o.message);
    if (!ask && /^\s*(?:please\s+|can you\s+|could you\s+)?(?:email|e-mail|emial|write(?: an?)?(?: email)? to|draft(?: an?)? (?:email|note|intro) to|send(?: an?)? (?:email|note|intro) to)\b/i.test(o.message))
      return { reply: `Who is ${typed.email}? Send their name and firm with the address, for example "email Maya Chen at Stripe about a coffee chat, ${typed.email}", and I'll draft it for your approval. I never make up a name for an address.`, intent: DRAFT_INTENT, status: "needs_name" };
  }
  if (ask?.kind === "who") return await whoTurn(o, ask.firm);
  if (ask?.kind === "draft") return await draftTurn(o, ask, typed.email);
  // The answer to "how do you sign your emails?": saved, then the ask that needed it runs.
  if ((await o.store.lastAssistantIntent(o.threadId).catch(() => null)) === SIGNATURE_INTENT) return await signatureTurn(o);
  return null;
}

// ------------------------------------------------------------------------------------------------ facts about a recipient
const NAME = String.raw`(\p{Lu}[\p{L}'’.-]+(?:[ \t]+\p{Lu}[\p{L}'’.-]+){0,2})`;
const ABOUT_RX = new RegExp(String.raw`^\s*(?:here(?:'s|’s| is)\s+)?(?:some\s+)?(?:(?:info|background|context|notes?)\s+)?(?:about|on|re:?)\s+${NAME}\s*[:\-–—]\s*([\s\S]+)$`, "u");
const POSS_RX = new RegExp(String.raw`^\s*(?:here(?:'s|’s| is)\s+)?${NAME}(?:'s|’s)\s+(?:bio|background|profile|team page|page|talk|paper|post|article|filing|blog)\s*(?:is\s+)?[:\-–—]?\s*([\s\S]+)$`, "u");
const SAID_RX = new RegExp(String.raw`^\s*${NAME}\s+((?:spoke at|spoke on|presented|wrote|published|worked on|works on|built|leads|led|launched|shipped|is from|grew up in|co-?founded|founded|advised on|gave (?:a|the) talk)\b[\s\S]{3,600})$`, "u");
const DECLINE_RX = /^\s*(?:i\s+)?(?:don'?t|do not)\s+know\b|^\s*(?:no idea|nothing|not sure|skip|never ?mind|idk|none)\b/i;
const URL_RX = /https?:\/\/[^\s<>"')]+/i;
// replay: the ask to run again once the answer is saved (an intro ask); without it, the email to that one person.
export interface FactAsk { key: string; name: string; firm: string; email: string | null; topic: string | null; at: string; replay?: string }
const SOURCE_SAY: Record<string, string> = { user_pasted: "what you pasted", user_stated: "what you told me", company_page: "their firm's page", sec_edgar: "an SEC filing", paper: "the paper's page" };
// The waiting question lives in the store (the chat state keeps only the router's keys); a store without it uses the state.
async function getFactAsk(o: NetworkingDeps): Promise<FactAsk | null> {
  if (o.store.factAsk) return (await o.store.factAsk(o.userId, o.threadId).catch(() => null)) as FactAsk | null;
  return (o.state.fact_ask ?? null) as FactAsk | null;
}
export async function setFactAsk(o: { store: OutreachStore; userId: string; threadId: string; state: Record<string, unknown> }, v: FactAsk | null): Promise<void> {
  if (o.store.setFactAsk) { await o.store.setFactAsk(o.userId, o.threadId, v as any).catch((e) => console.error("networking: the waiting question:", e instanceof Error ? e.message : e)); return; }
  if (v) o.state.fact_ask = v; else delete o.state.fact_ask;
}
async function namedOnce(o: NetworkingDeps, name: string): Promise<ContactRow[]> {
  const k = plain(name);
  const rows = [...await bookOf(o).named(k).catch(() => []), ...await savedPeople(o, { name }).catch(() => [])];
  const seen = new Set<string>();
  return rows.filter((r) => { const p = personKey(r); if (seen.has(p)) return false; seen.add(p); return true; });
}
async function factIntakeTurn(o: NetworkingDeps): Promise<NetworkingResult | null> {
  const msg = String(o.message ?? "").trim();
  if (!msg || (o.attachments ?? []).length) return null;
  const pending = await getFactAsk(o);
  const answering = !!pending && (await o.store.lastAssistantIntent(o.threadId).catch(() => null)) === FACTS_INTENT;
  if (answering) {
    // Any other ask (an approval, an intro, a status, another email) is that ask: the question closes unanswered.
    // #361 re-review (2026-11-01): a link on its own (or "her team page: <link>") while the question is open is the answer,
    // read under the firm-site check below, never handed to the people-page reader (which would file whoever that page
    // names under the firm). "People at Ramp on <link>" names a firm, and is that ask.
    const pa = parsePeopleAsk(msg);
    const nameWords0 = plain(pending!.name).split(" ").filter((w) => w.length > 1);
    const linkAnswer = URL_RX.test(msg) && (!pa || (pa.kind === "page" && !pa.firm && (!pa.owner || nameWords0.some((w) => plain(pa.owner!).split(" ").includes(w)))));
    if (parseNetworkingAsk(typedAddress(msg).text) || forgetAsk(msg) || (pa && !linkAnswer) || parseOutreachReply(msg) || parseBatchYes(msg) || trackAsk(msg) || (siteAsk(msg) && !linkAnswer)) { await setFactAsk(o, null); return null; }
    // Only something about them is an answer: a pronoun, their name, a link, or a sentence about what they did. Anything
    // else ("find me internships in Chicago") is another ask: the question closes and that ask runs.
    const nameWords = plain(pending!.name).split(" ").filter((w) => w.length > 1);
    const aboutThem = DECLINE_RX.test(msg) || URL_RX.test(msg) || /\b(?:she|he|they|her|his|their|him|them)\b/i.test(msg) || nameWords.some((w) => ` ${plain(msg)} `.includes(` ${w} `))
      || /^\s*(?:spoke|wrote|works?|worked|leads?|led|built|builds|runs|ran|published|presented|went|studied|grew|gave|launched|founded|co-?founded|maintains|manages|is|was|has)\b/i.test(msg);
    if (!aboutThem) { await setFactAsk(o, null); return null; }
    if (DECLINE_RX.test(msg)) {
      await setFactAsk(o, null);
      return { reply: `Then I'll hold off on writing to ${pending!.name}: an email that could go to anyone rarely gets a reply, and I won't make something up. When you learn one thing about their work, tell me ("${pending!.name.split(" ")[0]} spoke at ...") and I'll write it.`, intent: FACTS_INTENT, status: "declined" };
    }
    // The contact asked about, looked up again: its address counts only if the person gave it (never pending.email, which
    // may be one a page published).
    const me = (await namedOnce(o, pending!.name).catch(() => [])).find((r) => personKey(r) === pending!.key);
    return await saveFacts(o, { key: pending!.key, name: pending!.name, firm: pending!.firm, email: me ? givenEmail(me) : null }, msg, pending);
  }
  const m = ABOUT_RX.exec(msg) ?? POSS_RX.exec(msg), said = m ? null : SAID_RX.exec(msg);
  const hit = m ?? said;
  if (!hit) return null;
  const who = await namedOnce(o, hit[1]);
  if (!who.length) return null; // not someone in their contacts (a firm's page, a name they haven't sent): another turn's
  if (who.length > 1) return { reply: `More than one ${hit[1]} is in your contacts (${who.slice(0, 5).map((r) => `${r.name}${r.firm ? ` at ${r.firm}` : ""}`).join("; ")}). Say it again with the full name.`, intent: FACTS_INTENT, status: "which" };
  const r = who[0];
  return await saveFacts(o, { key: personKey(r), name: r.name, firm: r.firm, email: givenEmail(r) }, said ? `${r.name.split(" ")[0]} ${hit[2]}` : hit[2], pending && pending.key === personKey(r) ? pending : null);
}
async function saveFacts(o: NetworkingDeps, who: { key: string; name: string; firm: string; email?: string | null }, text: string, pending: FactAsk | null): Promise<NetworkingResult> {
  const at = new Date(o.now).toISOString(), ref = `${o.now.toString(36)}`, first = who.name.split(" ")[0];
  const add: RecipientFact[] = [];
  const notes: string[] = [];
  const url = URL_RX.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "") ?? null;
  if (url) {
    // The firm's verified domain: the contact's work email.
    const known = [who.email ?? null];
    const kind = factHost(url, who.firm, known);
    if (siteOfLink(url)) notes.push(`I never open ${siteOfLink(url)}, so I didn't read that link; paste the text you want me to use instead.`);
    else if (!kind) notes.push(firmDomains(known).length
      ? `I read only ${who.firm ? `${who.firm}'s own site, ` : ""}SEC EDGAR and paper sites, so I didn't open that link; paste the part about ${first} instead.`
      : `I read only SEC EDGAR and paper sites, and a firm's own site only at the domain of a work email I have for them (I have none for ${first}), so I didn't open that link; paste the part about ${first} instead.`);
    else {
      const page = await fetchHtml(o.people?.pageGet ?? pinnedGet(), url, o.people?.resolve, (u) => factHost(u.toString(), who.firm, known) === kind);
      if (!page.ok) notes.push(`I couldn't read that page (${page.why === "robots" ? "the site asks not to be read by tools" : page.why === "blocked_site" ? "I never open that site" : page.detail ?? page.why}); paste the part about ${first} instead.`);
      else {
        const got = factsFromPage(page.html, { name: who.name, url: page.url, at, source_kind: kind });
        if (got.length) add.push(...got); else notes.push(`That page doesn't mention ${who.name}, so I saved nothing from it.`);
      }
    }
  }
  const rest = text.replace(URL_RX, " ").replace(/\s+/g, " ").trim();
  if (rest && rest.split(/\s+/).length >= 3 && !(url && rest.split(/\s+/).length < 6)) {
    const long = rest.length > 160 || (rest.match(/[.!?](?:\s|$)/g) ?? []).length >= 2;
    add.push(...(long ? factsFromPaste(rest, { at, ref }) : factsFromStatement(rest, { at, ref })));
  }
  if (!add.length) {
    // still waiting for something usable (the question stays open)
    return { reply: `${notes.join(" ") || `I couldn't use that as something about ${first}'s work.`} ${factQuestion({ name: who.name, firm: who.firm })}`.trim(), intent: FACTS_INTENT, status: "nothing_saved" };
  }
  if (!o.store.addRecipientFacts) return { reply: `I can't save notes about people here yet, so nothing was kept.`, intent: FACTS_INTENT, status: "not_saved" };
  try { await o.store.addRecipientFacts(o.userId, who.key, add); }
  catch (e) { console.error("networking: save recipient facts:", e instanceof Error ? e.message : e); return { reply: `I couldn't save that just now, so nothing was kept. Please send it again in a minute.`, intent: FACTS_INTENT, status: "not_saved" }; }
  const kinds = [...new Set(add.map((f) => SOURCE_SAY[f.source_kind] ?? f.source_kind))].join(" and ");
  const saved = `Saved ${add.length === 1 ? "one thing" : `${add.length} things`} about ${who.name} from ${kinds} (${at.slice(0, 10)}).${notes.length ? ` ${notes.join(" ")}` : ""}`;
  if (pending) {
    await setFactAsk(o, null);
    const r = pending.replay ? (await networkingTurnInner({ ...o, message: pending.replay })) ?? { reply: `Say the ask again and I'll write it from that.`, intent: FACTS_INTENT, status: "saved" }
      : await draftTurn(o, { kind: "draft", topic: pending.topic, target: { by: "name", name: who.name, firm: who.firm || null } }, null);
    return { ...r, reply: `${saved}\n\n${r.reply}`, parts: r.parts ? [saved, ...r.parts] : undefined };
  }
  return { reply: `${saved} Say "email ${first}${who.firm ? ` at ${who.firm}` : ""} about <what you want to ask>" and I'll write it from that.`, intent: FACTS_INTENT, status: "saved" };
}

async function importTurn(o: NetworkingDeps, files: Attachment[], pasted: string | null): Promise<NetworkingResult> {
  const stamp = new Date(o.now).toISOString().slice(0, 16).replace("T", " ");
  const inputs = pasted ? [{ name: `pasted list ${stamp} UTC`, text: pasted }] : files.map((f) => ({ name: String(f.name || "contacts.csv").slice(0, 120), mime: f.mime ?? "", text: f.text }));
  const lines: string[] = [];
  let imported = 0;
  for (const f of inputs) {
    const csv = /\.csv$/i.test(f.name) || /csv|comma-separated/i.test((f as any).mime ?? "") || !!pasted;
    if (!csv || f.text === null) { lines.push(`${f.name}: not read. I can read a CSV of contacts here; this file type isn't one.`); continue; }
    if (f.text.length > MAX_FILE_CHARS) { lines.push(`${f.name}: not read. It is over ${MAX_FILE_CHARS / 1_000_000} MB; send the connections CSV on its own.`); continue; }
    const parsed = importContactsCsv(f.name, f.text);
    // Read and checked into a scratch list, then written to the account (a file's rows replace its earlier rows).
    const scratch: Record<string, unknown> = {};
    const r = await importContactsFile(scratch, { name: f.name, text: f.text }, o.mx ?? MX_NOT_WIRED);
    if (!r.ok || !r.report) { lines.push(`${f.name}: no contacts imported. It needs a header row with a name column and a company or email column.`); continue; }
    const rows = contactsOf(scratch).filter((x) => x.file === f.name);
    if (!await bookOf(o).put(rows, { replaceFile: f.name }).catch((e) => { console.error("networking: save contacts:", e instanceof Error ? e.message : e); return false; })) {
      lines.push(`${f.name}: read, but I couldn't save it to your contacts just now, so nothing was imported. Please send it again in a minute.`); continue;
    }
    imported += rows.length;
    const total = parsed.rows.length + parsed.duplicates + parsed.skipped.length;
    const out = [...(parsed.duplicates ? [`${plural(parsed.duplicates, "duplicate")}`] : []),
      ...summarizeSkipped(parsed.skipped)];
    const noEmail = rows.filter((x) => !x.email).length;
    const firms = r.report.by_firm.filter((x) => x.firm !== "(no company)").slice(0, 5).map((x) => `${x.firm} ${x.contacts}`).join(", ");
    lines.push([
      `${f.name}: imported ${rows.length}/${total} rows into your contacts${out.length ? ` (left out: ${out.join("; ")})` : ""}.`,
      `${rows.length - noEmail}/${rows.length} have an email address${noEmail ? `; the other ${noEmail} can be looked up by firm but not written to, since I never guess an address (LinkedIn's export includes an email only when the person allowed it)` : ""}.`,
      rows.some((x) => x.email) ? r.report.label : "",
      firms ? `Most contacts: ${firms}.` : "",
    ].filter(Boolean).join(" "));
  }
  const next = imported ? `\n\nAsk "who do I know at <firm>", or "email <name> at <firm> about <what you want to ask>" and I'll draft it for your approval. Nothing is sent without your yes on the exact email.` : `\n\n${ADD_CONTACTS}`;
  return { reply: lines.join("\n") + next, intent: IMPORT_INTENT, status: imported ? "imported" : "not_imported" };
}
function summarizeSkipped(skipped: { row: number; why: string }[]): string[] {
  const by = new Map<string, number[]>();
  for (const s of skipped) by.set(s.why, [...(by.get(s.why) ?? []), s.row]);
  return [...by.entries()].map(([why, rows]) => `${rows.length === 1 ? "row" : "rows"} ${rows.slice(0, 5).join(", ")}${rows.length > 5 ? ` and ${rows.length - 5} more` : ""}: ${why}`);
}

// NO LIMITS: the thread's copy of an export is capped; the person's whole saved export lives in career_people, so a firm
// or name asked about is also read there (indexed), and someone past the copy's first rows is still found.
async function savedPeople(o: NetworkingDeps, want: { firm?: string | null; name?: string | null }): Promise<ContactRow[]> {
  const store = o.people?.store;
  if (!store || (!want.firm && !want.name)) return [];
  const recs: PersonRec[] = [];
  if (want.name) recs.push(...await store.named(o.userId, want.name).catch(() => []));
  if (want.firm) recs.push(...await store.atCompany(o.userId, companyKey(normalizeFirm(want.firm))).catch(() => []));
  const firm = want.firm ? normalizeFirm(want.firm) : null;
  // NETWORKING SCENARIOS (2026-10-29): a person web discovery found (source "provider") is written to only at an address
  // that may be sent to (published or inferred, its domain's mail server found, never bounced: sendable), and the draft
  // card says how it was found. Before, an inferred address went out unlabeled, and one whose domain has no mail server
  // (not sendable) could be drafted to.
  const rows = recs.filter((r) => r.name && (!firm || sameFirm(normalizeFirm(r.company), firm))).map((r): ContactRow => {
    const found = r.source === "provider";
    const usable = !found || (r.sendable === true && !!r.email && (r.email_status === "published" || r.email_status === "inferred"));
    return {
      file: found ? `named on ${r.source_url ?? "a public page"}` : r.source_ref.replace(/, row \d+$/, "") || r.source, row: found ? 0 : Number(/row (\d+)$/.exec(r.source_ref)?.[1] ?? 0),
      name: r.name!, email: usable ? r.email : null,
      firm: normalizeFirm(r.company), firm_raw: r.company, company: normalizeFirm(r.company), title: r.position, school: r.school, connected_on: r.connected_on,
      ...(found ? { discovered: true as const } : {}),
      ...(!found && r.source !== "linkedin_export" && r.source !== "thread_list" ? { unverified: true as const } : {}),
      ...(found && usable ? { address: r.email_status === "inferred" ? "inferred" as const : "published" as const } : {}),
    };
  });
  return rows.length ? await verifyRows(rows, o.mx ?? MX_NOT_WIRED) : [];
}

async function whoTurn(o: NetworkingDeps, firmAsked: string): Promise<NetworkingResult> {
  const firm = normalizeFirm(firmAsked), book = bookOf(o);
  const here = (await book.atFirm(firm)).filter((r) => !r.discovered); // people they know, not people discovery found
  if (!here.length) {
    const all = await book.total();
    if (!all.total) return { reply: `You haven't sent me any contacts yet, so I can't say who you know at ${firm}. ${NO_FINDER} ${ADD_CONTACTS}`, intent: AT_INTENT, status: "no_contacts" };
    return { reply: `None of your ${plural(all.total, "contact")} (from ${all.files}) is at ${firm}. ${NO_FINDER} ${ADD_CONTACTS}`, intent: AT_INTENT, status: "none_at_firm" };
  }
  const withEmail = here.filter((r) => r.email).length;
  const shown = here.slice(0, LIST_MAX);
  const ex = here.find((r) => r.email) ?? here[0];
  return {
    reply: [`You have ${plural(here.length, "contact")} at ${firm} (from ${fileWord(here)}), ${withEmail} with an email address:`, ...shown.map(lineOf),
      ...(here.length > shown.length ? [`and ${here.length - shown.length} more.`] : []),
      withEmail ? `\nSay "email ${ex.name} at ${firm} about <what you want to ask>" and I'll draft it from your confirmed facts for your approval.` : `\nNone has an email address in your contacts, so I can't write to them; I never guess an address. Send a CSV with their emails (Name,Company,Email) to add them.`].join("\n"),
    intent: AT_INTENT, status: "listed",
  };
}

async function draftTurn(o: NetworkingDeps, ask: Extract<Ask, { kind: "draft" }>, typedEmail: string | null = null): Promise<NetworkingResult> {
  if (typedEmail && ask.target.by === "name") await keepTyped(o, ask.target.name.trim(), ask.target.firm, typedEmail);
  const book = bookOf(o), t = ask.target;
  const firmName = t.firm ? normalizeFirm(t.firm) : null;
  const none = async () => (await book.total()).total === 0;
  const noneYet = { reply: `You haven't sent me any contacts yet, so there's no one I can write to${firmName ? ` at ${firmName}` : ""}. ${NO_FINDER} ${ADD_CONTACTS}`, intent: DRAFT_INTENT, status: "no_contacts" };
  // Who: the rows the ask names, from the person's own contacts only.
  let pool: ContactRow[];
  let label: string;
  if (t.by === "name") {
    const want = plain(t.name), first = want.split(" ")[0];
    const atThatFirm = firmName ? await book.atFirm(firmName) : [];
    const scope = firmName ? atThatFirm : await book.named(want.includes(" ") ? want : first);
    const exact = scope.filter((r) => plain(r.name) === want);
    pool = exact.length ? exact : scope.filter((r) => { const n = plain(r.name); return want.includes(" ") ? n.startsWith(`${want} `) : n.split(" ")[0] === first; });
    label = `${t.name}${firmName ? ` at ${firmName}` : ""}`;
    if (!pool.length && await none()) return noneYet;
    if (!pool.length) return { reply: `No one named ${t.name}${firmName ? ` at ${firmName}` : ""} is in your contacts${atThatFirm.length ? ` (your contacts there: ${atThatFirm.slice(0, 5).map((r) => r.name).join(", ")})` : ""}. ${NO_FINDER} ${ADD_CONTACTS}`, intent: DRAFT_INTENT, status: "not_in_contacts" };
    if (pool.length > 1) return { reply: `More than one ${t.name} is in your contacts:\n${pool.slice(0, LIST_MAX).map((r) => `${lineOf(r)}${r.firm ? ` at ${r.firm}` : ""}`).join("\n")}\nSay which, with the full name and firm ("email ${pool[0].name} at ${pool[0].firm || "<firm>"}").`, intent: DRAFT_INTENT, status: "which" };
  } else {
    const here = await book.atFirm(firmName!);
    const rw = t.role ? plain(t.role) : "";
    const isRecruiter = /recruit|talent|hr|people team/.test(rw);
    pool = !rw ? here : here.filter((r) => { const tt = plain(r.title); return isRecruiter ? /recruit|talent|sourc/.test(tt) : rw.split(" ").every((w) => tt.includes(w.replace(/s$/, ""))); });
    label = `${t.role ? `${t.role}s` : "your contacts"} at ${firmName}`;
    if (!pool.length) {
      const there = here.length ? ` Your contacts at ${firmName}: ${here.slice(0, 5).map((r) => `${r.name}${r.title ? ` (${r.title})` : ""}`).join(", ")}.` : "";
      const all = await book.total();
      if (!all.total) return noneYet;
      return { reply: `${t.role ? `No ${t.role} at ${firmName}` : `No one at ${firmName}`} is in your ${plural(all.total, "contact")}.${there} ${NO_FINDER} ${ADD_CONTACTS}`, intent: DRAFT_INTENT, status: "none_at_firm" };
    }
  }
  // NO LIMITS: a group draft covers everyone asked for (or everyone matching), not a batch of Trainee's size.
  const want = Math.max(1, t.by === "group" && t.count ? t.count : pool.length);
  const [dnc, contacted] = await Promise.all([o.store.dnc(o.userId), o.store.contacted(o.userId)]);
  // OUTREACH SCENARIOS (2026-10-30): an address that said "stop" to anyone, or bounced for anyone, is never drafted to.
  const blocked = await blockedAddresses(o.store, o.userId, pool.map((r) => r.email ?? "").filter(Boolean));
  // FAMILY NETWORKING: who was already written to, and how far it went. A by-name ask for someone whose only draft is
  // still waiting (never approved or sent) replaces that draft: the person changed their mind about what to say.
  const hist = o.store.history ? await o.store.history(o.userId, 500).catch(() => []) : [];
  const live = (email: string) => hist.filter((d) => d.recipient.email.toLowerCase() === email && d.status !== "skipped");
  const replace: OutreachDraft[] = [];
  const pick: ContactRow[] = [], held: { name: string; why: string }[] = [];
  for (const r of pool) {
    if (pick.length >= want) break;
    let why = await heldWhy(r, contacted, dnc, blocked);
    const mine = r.email ? live(r.email.toLowerCase()) : [];
    if (why === CONTACTED && t.by === "name" && mine.length && mine.every((d) => d.status === "shown")) { replace.push(...mine); why = null; }
    else if (why === CONTACTED && mine.some((d) => d.status === "approved")) why = `you approved an email to them that isn't sent yet (draft ${mine.find((d) => d.status === "approved")!.n}; say "cancel ${mine.find((d) => d.status === "approved")!.n}" to write a new one)`;
    else if (why === CONTACTED && mine.some((d) => ["sent", "replied"].includes(d.status))) why = `you already emailed them; say "follow up with ${r.name.split(" ")[0]}" for a follow-up`;
    if (why) held.push({ name: r.name, why }); else pick.push(r);
  }
  const considered = pick.length + held.length;
  const heldLine = held.length ? `Not drafted: ${held.map((h) => `${h.name} (${h.why})`).join("; ")}.` : "";
  if (!pick.length) return { reply: `I can't write to ${label}: ${held.map((h) => `${h.name}: ${h.why}`).join("; ")}. Nothing was drafted. To add an address, send a CSV with Name,Company,Email.`, intent: DRAFT_INTENT, status: "held" };
  const facts = confirmed(((o.state.profile as any)?.facts ?? []) as unknown[]);
  if (!facts.length) return { reply: `I write only from facts you've confirmed, and there are none on record yet, so nothing was drafted. Paste your resume here and confirm it, then ask again.`, intent: DRAFT_INTENT, status: "no_facts" };
  if (!o.model) return { reply: `Drafting emails isn't switched on here yet, so nothing was written or sent. From your contacts I would write to: ${pick.map((r) => `${r.name}${r.title ? `, ${r.title}` : ""}${r.firm ? ` at ${r.firm}` : ""} <${r.email}>`).join("; ")}.${heldLine ? ` ${heldLine}` : ""}`, intent: DRAFT_INTENT, status: "drafting_off" };
  const prefs = await o.store.prefs(o.userId);
  if (!prefs.signature) return { reply: SIGN_ASK, intent: SIGNATURE_INTENT, status: "needs_signature" };
  return await writeBatch(o, pick, held, considered, ask.topic, prefs.signature, facts, replace);
}

// The role the person named in their ask ("about the data analyst role"): the only role a referral or a recruiter's
// "consider me" may name.
export const roleOf = (topic: string | null) => (topic ? /(?:^|\b(?:the|a|an|for)\s+)([\p{L}0-9 ,&/-]{2,60}?)\s+(?:role|position|internship|opening|job)\b/iu.exec(topic)?.[1]?.trim() ?? null : null);
async function writeBatch(o: NetworkingDeps, pickIn: ContactRow[], held: { name: string; why: string }[], considered: number, topic: string | null, signature: string, facts: unknown[], replace: OutreachDraft[] = []): Promise<NetworkingResult> {
  // PERSONALIZED OUTREACH (2026-10-31): every new draft goes through the personalization engine, with what the person told
  // Trainee about each recipient (their words, a pasted bio, a page they sent) read from the account.
  const keys = pickIn.map(personKey);
  const known: Map<string, RecipientFact[]> = o.store.recipientFacts ? await o.store.recipientFacts(o.userId, keys).catch((e) => { console.error("networking: read recipient facts:", e instanceof Error ? e.message : e); return new Map(); }) : new Map();
  const pick = pickIn.map((r, k) => ({ ...r, facts: [...(r.facts ?? []), ...(known.get(keys[k]) ?? [])] }));
  const results: Drafted[] = [];
  const role = roleOf(topic);
  for (let k = 0; k < pick.length; k += 5) results.push(...await Promise.all(pick.slice(k, k + 5).map((r) => draftFor({ model: o.model!, facts, r: recipientOf(r), topic, lang: draftLangOf(o.message), personal: { role, now: o.now } }))));
  // Nothing specific about anyone asked for: one question about the first of them, then the draft (never a generic email).
  const unsourced = pick.filter((_, k) => { const d = results[k]; return !d.ok && d.why === "unsourced"; });
  if (unsourced.length && !results.some((d) => d.ok)) {
    const r = unsourced[0];
    await setFactAsk(o, { key: personKey(r), name: r.name, firm: r.firm, email: r.email, topic, at: new Date(o.now).toISOString() });
    const rest = unsourced.slice(1).map((x) => x.name);
    return { reply: `${factQuestion(r)}${rest.length ? ` (I'll ask about ${rest.join(", ")} after.)` : ""}`, intent: FACTS_INTENT, status: "needs_facts" };
  }
  const footer = footerOf(signature), ok: Omit<OutreachDraft, "id" | "batch_id" | "thread_id">[] = [];
  const failed: { name: string; why: string }[] = [];
  for (const [k, d] of results.entries()) {
    if (!d.ok) { failed.push({ name: pick[k].name, why: d.why === "unsourced" ? `nothing specific about them yet; tell me one thing about their work ("${pick[k].name.split(" ")[0]} spoke at ...") and I'll write it` : d.why === "unverified" || d.why === "not_personal" ? `I couldn't write it without saying something not on record (${d.detail.slice(0, 2).join("; ")})` : d.why === "model" ? "the writing model didn't answer" : d.detail.join("; ") }); continue; }
    // PERSONALIZED OUTREACH: what made it personal rides on the stored recipient and is shown on the card.
    const { facts: _sourced, ...rec } = recipientOf(pick[k]);
    const draft = { n: ok.length + 1, recipient: { ...rec, ...(d.personal ? { personal: d.personal } : {}) }, subject: d.subject, body: d.body, footer, shared: d.shared, status: "shown" as const, hash: "",
      approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
    draft.hash = await payloadHash(messageOf(draft));
    ok.push(draft);
  }
  const notDone = [...held, ...failed];
  const notLine = notDone.length ? `Not drafted: ${notDone.map((h) => `${h.name} (${h.why})`).join("; ")}.` : "";
  if (!ok.length) return { reply: `Nothing was drafted (0/${considered}). ${notLine}`, intent: DRAFT_INTENT, status: "not_drafted" };
  const saved = await o.store.saveBatch(o.userId, o.threadId, ok, o.now);
  for (const d of saved) await recordOutreach(o.events, o.userId, "outreach_drafted", d, o.now, { from: "chat" });
  // The waiting drafts this one replaces are dropped, so only the new one can be approved.
  const gone: string[] = [];
  for (const d of replace) {
    if (!saved.some((x) => x.recipient.email.toLowerCase() === d.recipient.email.toLowerCase())) continue;
    if (await o.store.update(o.userId, { ...d, status: "skipped", approved_hash: null, approved_at: null, result: "replaced" }, { status: "shown" })) gone.push(d.recipient.name);
  }
  const head = `Drafted ${saved.length}/${considered}.${notLine ? ` ${notLine}` : ""}${gone.length ? ` This replaces your earlier draft to ${[...new Set(gone)].join(", ")}, which won't be sent.` : ""}`;
  const parts = [head, ...batchMessages(saved)];
  return { reply: parts.join("\n\n"), intent: OUTREACH_INTENT, status: "drafted", parts };
}

async function signatureTurn(o: NetworkingDeps): Promise<NetworkingResult | null> {
  const lines = String(o.message ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const sig = lines.slice(0, 4).join("\n");
  if (!sig || sig.length > 300 || lines.length > 4 || /\?\s*$/.test(sig) || /https?:/i.test(sig)) return null;
  await o.store.setPrefs(o.userId, { signature: sig });
  const before = o.previousAsk ? await o.previousAsk().catch(() => null) : null;
  const typed = before ? typedAddress(before) : null;
  const ask = typed ? parseNetworkingAsk(typed.text) : null;
  if (ask?.kind === "draft") {
    const r = await draftTurn(o, ask, typed?.email ?? null);
    return { ...r, reply: `Saved your signature.\n\n${r.reply}`, parts: r.parts ? [`Saved your signature.`, ...r.parts] : undefined };
  }
  return { reply: `Saved your signature:\n${sig}\nIt goes at the bottom of every email I draft for you.`, intent: "career_outreach_signature_saved", status: "saved" };
}
