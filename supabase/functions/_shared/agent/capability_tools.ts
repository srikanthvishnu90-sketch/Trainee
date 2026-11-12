// D-062 (owner, 2026-11-11, in chat: "your job is to know exactly what any job posting requires, be able to answer emails, find
// alumni, do all of it. not gmail read, but gmail read and send"): the brain's tools for Instinct's capabilities, built under D-061
// (G1: the model decides; code guards). Tools return data; the model writes the words (no reply prose here, except the exact
// message card code shows word for word, as draft_followup does).
//   read_application_mail  C6: the person's applications with evidence from their connected Gmail confirmations, researched roles
//                          and unsubmitted drafts kept apart, coverage, and what changed since last shown (G9).
//   export_tracker         C16: the same record as a tracker File (file_kinds.ts "tracker", built by code only).
//   find_people            C19: public people search from web search excerpts (career_alumni_search.ts): leads "not verified",
//                          nobody contacted.
//   find_email             answering an email: search the person's inbox, or read the one email they chose.
//   draft_email_reply      answering an email: the reply card, shown word for word; only a yes to it sends (career_mail_reply.ts).
import type { ToolSpec, ToolCtx } from "./loop.ts";
import type { MailStore } from "../career_mail_store.ts";
import type { Situation } from "../career_situation.ts";
import type { MailNow } from "../career_inbox_followups.ts";
import type { FileService } from "../file_service.ts";
import type { OutreachStore } from "../career_outreach.ts";
import { appsFromTracker } from "../career_mail_store.ts";
import { buildRecord, type MailCoverage, type Snapshot, snapshotOf, trackerData, type ApplicationRecord } from "../career_application_record.ts";
import { type AlumniResult, searcher, type PeopleSearchFn } from "../career_alumni_search.ts";
import { draftReply, type Inbox } from "../career_mail_reply.ts";
import { confirmed, factText } from "../career_outreach.ts";

export interface CapabilityDeps {
  // C6 / C16
  mail: Pick<MailStore, "applications" | "events"> | null;
  tracking: boolean; // CAREER_MAIL_TRACKING
  grant: ((userId: string) => Promise<{ status: "ok" | "not_connected" | "not_allowed"; mailbox: string | null }>) | null;
  cursor: ((userId: string) => Promise<string | null>) | null;
  readNow: ((userId: string) => Promise<MailNow>) | null; // one mail run for this person before answering (career_inbox_followups.ts mailNow)
  connectUrl: string; // where the person connects Gmail themselves (they sign in to Google; no password in chat)
  situation: Situation | null;
  snapshot: { get(userId: string): Promise<Snapshot | null>; set(userId: string, s: Snapshot): Promise<void> } | null;
  files: FileService | null;
  // C19
  people: { on: boolean; search: PeopleSearchFn | null; cache?: Map<string, { at: number; out: AlumniResult }>; onResult?: (r: AlumniResult) => void } | null;
  // answering an email
  inbox: Inbox | null;
  reply: { outreach: OutreachStore; sendOn: boolean; canSend: (userId: string) => Promise<boolean>; name: () => string | null } | null;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object" as const, properties, required });
const str = (description: string) => ({ type: "string", description });
const profileOf = (c: ToolCtx): any => (c.state as any)?.profile ?? {};

async function recordFor(d: CapabilityDeps, c: ToolCtx): Promise<ApplicationRecord> {
  const unreadable: string[] = [];
  const g = d.grant ? await d.grant(c.userId).catch(() => null) : null;
  const mail: MailCoverage = { tracking_on: d.tracking, gmail: g ? (g.status === "ok" ? "connected" : g.status) : "unknown", mailbox: g?.mailbox ?? null, read_through: null,
    accounts_connected: g?.status === "ok" ? 1 : 0, multiple_accounts_supported: false };
  // A live read of new mail first (the scheduled run's own code, for this person only), so the answer is as of now.
  if (d.tracking && mail.gmail === "connected" && d.readNow) {
    const r = await d.readNow(c.userId).catch(() => null);
    mail.read_now = r?.status === "ok" ? "read" : r?.status === "ERROR" ? "error" : "not_read";
    if (r?.status === "ok") mail.read_through = r.read_through;
  }
  if (!mail.read_through && d.cursor && mail.gmail === "connected") mail.read_through = await d.cursor(c.userId).catch(() => null);
  const here = appsFromTracker((c.state as any)?.trackStore?.rows ?? []);
  let stored: any[] = [], events: any[] = [];
  if (d.mail) {
    stored = await d.mail.applications(c.userId).catch(() => { unreadable.push("applications"); return []; });
    events = await d.mail.events(c.userId).catch(() => { unreadable.push("mail events"); return []; });
  }
  const apps = [...here.filter((h) => !stored.some((s) => s.ref === h.ref)), ...stored];
  const previous = d.snapshot ? await d.snapshot.get(c.userId).catch(() => null) : null;
  return buildRecord({ now: c.now, apps, events, situation: d.situation, listed: (c.state as any)?.discovery?.lastShortlist, mail, previous, unreadable });
}
const remember = async (d: CapabilityDeps, c: ToolCtx, r: ApplicationRecord) => { await d.snapshot?.set(c.userId, snapshotOf(r)).catch(() => {}); };

const RECORD_NOTE = "Answer from this record only. Keep three groups apart: applications that went (with the evidence for each: the employer's email, " +
  "Trainee's submission record, or their word), roles that were only researched in this conversation, and drafts not submitted or sent. " +
  "Say what the record covers in the same reply (coverage): it is based on one connected Gmail, so an application confirmed to another address " +
  "or a status shown only on an employer's portal is missed. If Gmail is not connected, say so and give connect_url so they can connect it " +
  "themselves (they sign in to Google; never ask for a password). If changes is not empty, correct what you said before, naming what changed. " +
  "Offer to keep this as a running tracker (export_tracker) when they have not asked for one yet. Never add an application the record does not hold.";

export function capabilityTools(d: CapabilityDeps): ToolSpec[] {
  const tools: ToolSpec[] = [{
    name: "read_application_mail", effect: "read",
    description: "Use when the person asks what they have applied to, whether they applied somewhere, or wants to keep track of applications. Reads their applications with evidence from their connected Gmail confirmations (mail tracking), Trainee's own submissions and what they told you; keeps roles only researched in this conversation and unsubmitted drafts apart; says what the record covers and what changed since it was last shown. Nothing is sent.",
    input_schema: obj(),
    run: async (_i, c) => {
      const r = await recordFor(d, c);
      await remember(d, c, r);
      return { ...r, connect_url: r.mail.gmail === "connected" ? null : d.connectUrl, note: RECORD_NOTE };
    },
  }];
  if (d.files) tools.push({
    name: "export_tracker", effect: "write_own",
    description: "Use when the person wants an application tracker (\"set up that tracker\", \"make me a tracker\"). Builds a tracker page from their records and Gmail confirmations: past applications with evidence and dates, researched roles, unsubmitted drafts, each with its status, and what it covers. The link is added by the system; do not write it. Say what it holds, state its coverage, and correct anything in changes.",
    input_schema: obj(),
    effectOf: (out) => ((out as any)?.status === "ok" ? "write_own" : "read"),
    run: async (_i, c) => {
      const r = await recordFor(d, c);
      const made = await d.files!.create(c.userId, "tracker", trackerData(r), { trusted: true });
      if (!made.ok) return { status: "not_made", why: made.error, record: r, note: "The tracker page could not be made: say so plainly, and give the record in chat instead (three groups, coverage). Do not claim a page exists." };
      const url = made.url ?? made.webApp;
      if (url && c.turn) (c.turn.fileLinks ??= []).push(url);
      await remember(d, c, r);
      return { status: "ok", counts: { applied: r.applied.length, researched: r.researched.length, drafts: r.drafts.length }, coverage: r.coverage, changes: r.changes, applied: r.applied.map((a) => ({ company: a.company, role: a.role, status: a.status, confirmed_by: a.confirmed_by })),
        researched: r.researched, drafts: r.drafts, mail: r.mail, connect_url: r.mail.gmail === "connected" ? null : d.connectUrl,
        note: "The tracker page was made; the system adds its link. Say what it holds in a sentence or two, state the coverage, correct anything in changes out loud, and say it updates from their Gmail confirmations when they ask again. Nothing was submitted or sent." };
    },
  });
  if (d.people?.on) {
    const find = searcher({ search: d.people.search, now: Date.now, cache: d.people.cache });
    tools.push({
      name: "find_people", effect: "read",
      description: "Use when the person asks to find people to reach out to by a school they share (alumni) at one or more employers (\"find me 3 Lakeshore alumni at Google or trading firms\"). Searches public web pages (never LinkedIn or Indeed) and returns leads with name, role, employer, whether the page shows the school, and the page link, each not verified. Nobody is contacted.",
      input_schema: obj({
        school: str("The school, as the person named it or from their confirmed education"),
        employers: { type: "array", items: { type: "string" }, description: "Employers to look at, as the person named them (for \"trading firms\", name 2 or 3 well-known ones and say you chose them)" },
        count: { type: "integer", description: "How many people they asked for (default 3)" },
        role: str("A role, only if they named one"),
      }, ["school", "employers"]),
      run: async (i) => {
        const r = await find({ school: String(i.school ?? ""), employers: Array.isArray(i.employers) ? i.employers.map(String) : [], count: Number(i.count) || 3, role: i.role ? String(i.role) : null });
        d.people!.onResult?.(r);
        return r;
      },
    });
  }
  if (d.inbox) {
    const inbox = d.inbox;
    tools.push({
      name: "find_email", effect: "read",
      description: "Use when the person wants to answer or read an email in their inbox (\"reply to the recruiter from Acme\", \"answer Dana's email\"). With query (Gmail search words like a sender, company or subject), lists matching received emails: ref, sender, subject, date, snippet. With ref, reads that one email's text. Read only.",
      input_schema: obj({ query: str("Gmail search words, e.g. 'from:acme.com' or 'Dana interview'"), ref: str("An email's ref from an earlier find_email result, to read it in full") }),
      run: async (i, c) => {
        if (i.ref) {
          const r = await inbox.read(c.userId, String(i.ref));
          if (r.status === "NOT_WIRED") return { status: "not_connected", connect_url: d.connectUrl, note: "No Gmail that Trainee may read is connected. Say so and give connect_url: they connect it themselves (they sign in to Google). Nothing was read." };
          return r;
        }
        const r = await inbox.search(c.userId, String(i.query ?? ""), 5);
        if (r.status === "NOT_WIRED") return { status: "not_connected", connect_url: d.connectUrl, note: "No Gmail that Trainee may read is connected. Say so and give connect_url: they connect it themselves (they sign in to Google). Nothing was read." };
        return r.status === "ok" ? { ...r, note: r.mails.length > 1 ? "If more than one could be the email they mean, ask which one (one question)." : r.mails.length ? "Read it with ref before you write a reply." : "Nothing matched: say so and ask for the sender or subject." } : r;
      },
    });
    if (d.reply) {
      const rp = d.reply;
      tools.push({
        name: "draft_email_reply", effect: "write_own",
        description: "Write the person's reply to one email from their inbox (its ref from find_email). Body only (greeting to closing line, no signature): from their words in this conversation, their confirmed facts and the email itself; no invented meeting, offer, figure or commitment. Code shows the exact message as a card; it is sent from their Gmail only if they then say yes to that exact message. Nothing is sent by this tool.",
        input_schema: obj({ ref: str("The email's ref from find_email"), body: str("The reply's text, greeting to closing line, without the signature") }, ["ref", "body"]),
        effectOf: (out) => ((out as any)?.status === "ok" ? "write_own" : "read"),
        run: async (i, c) => {
          const prefs = await rp.outreach.prefs(c.userId).catch(() => ({ signature: null }) as any);
          const out = await draftReply({ userId: c.userId, threadId: c.threadId, now: c.now, inbox, outreach: rp.outreach, ref: String(i.ref ?? ""), body: String(i.body ?? ""),
            said: c.turn?.typed ?? c.turn?.message ?? "", facts: confirmed(profileOf(c).facts || []).map(factText), signature: prefs?.signature || rp.name(),
            canSend: async () => rp.sendOn && await rp.canSend(c.userId) });
          if (out.status === "ok" && c.turn) c.turn.show = out.show;
          return out.status === "ok" ? { status: "ok", to: out.to, subject: out.subject, note: out.note } : out;
        },
      });
    }
  }
  return tools;
}
