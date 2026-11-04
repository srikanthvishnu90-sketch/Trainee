// The Telegram chat flow, round 3 (architect, 2026-10-31; round 1: scenarios-telegram.test.ts, round 2: scenarios-telegram-r2.test.ts):
// a FRESH seed (20261101) and new adversarial categories, about 10,000 generated scenarios through the real Telegram webhook
// composed exactly as trainee-telegram/handler.ts composes it with the service client (scenarios/telegram-r3-world.ts: webhookDeps,
// the job cards and taps over memory stores, the real inbound core, the real delivery run over channel_memory.ts, a fake Bot API
// with faults). No network, no model, no database, no wall clock. The strict invariants, checked on every scenario:
//   - never act for anyone but the card's owner (a tap is the tapper's, in the tapper's own private chat, or nothing);
//   - never approve without the exact payload the person confirmed (a Confirm whose payload changed approves nothing, says
//     why, and shows the current one with a fresh Confirm);
//   - each Telegram update has at most one effect (a webhook retry, an edit, a forwarded message: no second effect);
//   - never lose or duplicate a reply part (a 429 with retry_after, a 502, a timeout part way through: every part once, in order);
//   - never show one account's data to another chat, and nothing of anyone's to a group;
//   - every refusal has a readable reason (an edited decision is answered, never silently ignored).
// Categories (the count each runs):
//   tapper     a callback for another account's card: in the tapper's own chat (a forwarded card), an update whose message is
//              someone else's chat (from.id is not the chat), an inline message (no chat), an unknown chat, a group; and an
//              older list of the owner's own
//   dup        the same callback delivered twice to four times (a webhook retry), and a double tap (two updates)
//   stopped    a tap after /stop (the person's own act: answered, at most the shown payload), a tap after the account is deleted
//   changed    Confirm after the payload changed (an answer edited, the resume replaced, the posting closed or past its
//              deadline, the application withdrawn): nothing approved, a readable reason, the current payload re-shown
//   edit       edited_message turning "yes" into "no" (or the reverse, or "stop") after Trainee acted; typo edits; retries
//   order      updates out of order, with gaps and repeats, from several chats at once
//   forward    a forwarded job card, a forwarded "yes" / "confirm" / "STOP" / "/start <code>": someone else's words
//   blocked    403 (blocked, deactivated) part way through a reply in parts
//   ratelimit  429 with retry_after (1-120 s), 502, part way through a reply in parts, a long single reply, and the #301 rest
//              with its links
//   timeout    a send that timed out after Telegram took it, part way through a reply in parts
//   boundary   replies of exactly 4,096 / 4,095 / 4,097 / 1,500 / 1,501 characters with emoji, flags, ZWJ families, skin tones,
//              RTL and combining marks at the split boundary
//   entities   company names and titles carrying & < > * _ ` [x](y) and entity look-alikes, texting voice on and off
//   deeplink   /start <payload>: forged, malformed, expired, used, someone else's token (a chat linked elsewhere must not burn it);
//              a chat is linked only on the YES of the account's own chat (TELEGRAM LINK OWNERSHIP, 2026-10-31)
//   group      group, supergroup and channel posts, commands, taps and member updates: nothing to any group, no effect
// Run: deno test -A --no-check tests/architect/scenarios-telegram-r3.test.ts   (TG3_ONLY=tapper,dup runs those categories alone)
import assertNode from "node:assert/strict";
import { NOW, type Prep, rng, SECRET, TOKEN, world, type World } from "./scenarios/telegram-r3-world.ts";
import { plainOf } from "./scenarios/telegram-bot-api.ts";
import * as IN from "../../supabase/functions/_shared/channel_inbound.ts";
const { LINKED_HERE_REPLY, TELEGRAM_LINK_INVALID_REPLY, TELEGRAM_LINKED_ELSEWHERE_REPLY } = IN;
// round 3: the answer to an edited message (a namespace read, so this file runs against the code before the fix too)
const EDIT_NOT_READ_REPLY = (IN as Record<string, unknown>).EDIT_NOT_READ_REPLY as string ?? "(no answer to an edit)";
import { GROUP_TAP_ANSWER } from "../../supabase/functions/_shared/telegram.ts";
import { hashTag, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { CUT_NOTE, fitOutbox } from "../../supabase/functions/_shared/conversation.ts";

const SEED = 20261101;
const ONLY = new Set((Deno.env.get("TG3_ONLY") ?? "").split(",").filter(Boolean));
const runs = (c: string) => !ONLY.size || ONLY.has(c);
const MIN = 60000;
let UPD = 500000;
const leaks = (s: string) => s.includes(TOKEN) || s.includes(SECRET) || s.includes(TOKEN.split(":")[1]);

// ------------------------------------------------------------------------------------------------ the report
type Failure = { id: string; why: string };
const failures = new Map<string, Failure[]>();
const totals: Record<string, number> = {};
function grade(cat: string, id: string, whys: string[]) {
  totals[cat] = (totals[cat] ?? 0) + 1;
  for (const why of [...new Set(whys)].slice(0, 4)) {
    const key = `${cat}: ${why.replace(/[0-9a-f]{12,}|\d{3,}/g, "#").slice(0, 120)}`;
    if (!failures.has(key)) failures.set(key, []);
    failures.get(key)!.push({ id, why });
  }
}
function assertClean(cat: string) {
  const mine = [...failures.entries()].filter(([k]) => k.startsWith(`${cat}:`));
  const lines = mine.sort((a, b) => b[1].length - a[1].length).flatMap(([k, xs]) => [`  ${xs.length}x ${k}`, ...xs.slice(0, 2).map((x) => `      #${x.id}: ${x.why.slice(0, 400)}`)]);
  console.log(`[tg-r3] ${cat}: ${totals[cat] ?? 0} scenarios, ${new Set(mine.flatMap(([, xs]) => xs.map((x) => x.id))).size} failed (${mine.reduce((n, [, xs]) => n + xs.length, 0)} findings)`);
  assertNode.deepStrictEqual(lines, [], `${cat}:\n${lines.slice(0, 40).join("\n")}`);
}
// Every scenario: no Bot API refusal (the fake refuses what Telegram refuses), nothing to a group, no token or secret in a
// response, every tap answered exactly once.
function common(w: World, whys: string[], responses: string[], taps: string[] = []) {
  for (const p of w.B.problems()) whys.push(`Bot API: ${p.slice(0, 160)}`);
  if (w.B.msgs.some((m) => Number(m.chat) <= 0)) whys.push("a message to a group or channel");
  if (responses.some(leaks)) whys.push("a response carries the token or the secret");
  for (const id of taps) { const n = w.B.answers.filter((a) => a.id === id).length; if (n !== 1) whys.push(`tap ${id} answered ${n} times`); }
}

// ------------------------------------------------------------------------------------------------ postings and payloads
const COMPANIES = ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark Industries", "Wayne Enterprises", "Cyberdyne"];
const hitFor = (id: string, k: number, company = "Acme", o: { title?: string; domain?: string | null } = {}) => ({
  job_id: `lever:${company.toLowerCase().replace(/[^a-z0-9]/g, "")}:${id}-${k}`, company, title: o.title ?? `Data Analyst ${k}`, location: "Austin, TX",
  url: `https://jobs.lever.co/${company.toLowerCase().replace(/[^a-z0-9]/g, "")}/${id}-${k}`, pay: null, level: null,
  first_seen_at: new Date(NOW - 3600000).toISOString(), deadline: null, ...(o.domain ? { company_domain: o.domain } : {}), fit: { reasons: [], gaps: [] } });
type Hit = ReturnType<typeof hitFor>;
let PREP = 0;
const hex64 = (seed: string) => { let out = ""; for (let k = 0; out.length < 64; k++) { let h = 0x811c9dc5 ^ k; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } out += h.toString(16).padStart(8, "0"); } return out.slice(0, 64); };
function prepFor(w: World, userId: string, hit: Hit, o: { first?: string; cover?: string; resume?: string } = {}): Prep {
  const payload = { version: 1, user_id: userId, job_id: hit.job_id, company: hit.company, url: hit.url, resume_sha256: o.resume ?? "a".repeat(64), expires_at: new Date(w.clock.t + 86400000).toISOString(),
    fields: [{ name: "first_name", label: "First name", value: o.first ?? "Alex" }, { name: "cover_letter", label: "Cover letter", value: o.cover ?? "I build dashboards." }] };
  const p: Prep = { id: `prep-${++PREP}`, userId, job_id: hit.job_id, company: hit.company, url: hit.url, payload, payload_hash: hex64(JSON.stringify(payload) + PREP), card_lines: [hit.company], state: "ready" };
  w.J.preps.push(p);
  return p;
}
function postingRow(w: World, hit: Hit, o: { closed?: boolean; deadline?: string | null } = {}) {
  w.J.rows.set(hit.job_id, { job_id: hit.job_id, provider: "lever", company: hit.company, title: hit.title, location: hit.location, url: hit.url, description: "Requirements\nSQL and Excel.",
    ...(o.closed ? { closed_at: new Date(w.clock.t - 60000).toISOString() } : {}), ...(o.deadline !== undefined ? { deadline: o.deadline } : {}) } as any);
}
const tapUpdate = (w: World, chat: number, data: string, o: { from?: number; msgChat?: number | null; msgId?: number; chatType?: string; id?: string } = {}) => {
  const id = o.id ?? `cb${++UPD}`;
  const msgChat = o.msgChat === undefined ? chat : o.msgChat;
  return { id, update: { update_id: ++UPD, callback_query: { id, from: { id: o.from ?? chat, is_bot: false, first_name: "TEST" }, chat_instance: `ci${chat}`,
    ...(msgChat === null ? { inline_message_id: `im${UPD}` } : { message: { message_id: o.msgId ?? 1, chat: { id: msgChat, type: o.chatType ?? (msgChat > 0 ? "private" : "supergroup") }, date: 1 } }), data } } };
};
const text = (w: World, chat: number, t: string, mid?: number) => ({ update_id: ++UPD, message: { message_id: mid ?? UPD, ...w.from(chat), text: t } });
// The owner's cards and the exact payload page: postings found by a turn, then Apply on the first.
async function ownerWithConfirm(w: World, chat: number, hits: Hit[], o: { first?: string; cover?: string } = {}) {
  const u = w.known(chat);
  for (const h of hits) postingRow(w, h);
  const p = prepFor(w, u, hits[0], o);
  w.setReplies(({ message }) => (/find/.test(message) ? { postings: hits } : {}));
  await w.post(text(w, chat, "find me data jobs"));
  const ref = await refOf(u, hits[0].job_id);
  const t = tapUpdate(w, chat, `jca:${ref}`);
  await w.post(t.update);
  const confirm = w.B.to(chat).flatMap((m) => m.buttons).find((b: any) => /^jcy:/.test(b.callback_data ?? ""))?.callback_data as string | undefined;
  return { u, p, ref, confirm, taps: [t.id] };
}

// ================================================================================================ tapper
async function tapperScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 810000000 + id * 10, Bc = A + 1, group = -100700000000 - id;
  const company = r.pick(COMPANIES), secretName = `Zed${id}x`;
  const hits = Array.from({ length: r.int(1, 3) }, (_, k) => hitFor(`t${id}`, k, company));
  const own = await ownerWithConfirm(w, A, hits, { first: secretName });
  if (!own.confirm) { whys.push("setup: no Confirm shown to the owner"); return whys; }
  const variant = r.pick(["forwarded-card", "other-from", "inline", "unknown-chat", "group", "older-list"] as const);
  const datas = [own.confirm, `jca:${own.ref}`, `jcd:${own.ref}`, `jcs:${own.ref}`, `jcx:${own.ref}`];
  const data = r.pick(datas);
  const aBefore = w.B.to(A).length;
  const taps: string[] = [];
  if (variant !== "unknown-chat") w.known(Bc);
  if (variant === "older-list") {
    // the owner's own older list: a newer search sent other cards; a tap on the first list's card still acts for the owner only
    const newer = [hitFor(`t${id}n`, 9, company)];
    postingRow(w, newer[0]);
    w.setReplies(({ message }) => (/again/.test(message) ? { postings: newer } : {}));
    await w.post(text(w, A, "search again"));
    const t = tapUpdate(w, A, own.confirm); taps.push(t.id);
    res.push((await w.post(t.update)).text);
    const mine = w.J.approvals.filter((x) => x.userId === own.u);
    if (mine.length !== 1 || mine[0].hash !== own.p.payload_hash) whys.push(`older list: approvals ${JSON.stringify(mine)}, want exactly the shown payload once`);
    if (w.J.approvals.some((x) => x.userId !== own.u)) whys.push("older list: an approval for someone else");
  } else {
    const t = variant === "forwarded-card" ? tapUpdate(w, Bc, data)
      : variant === "other-from" ? tapUpdate(w, A, data, { from: Bc })
      : variant === "inline" ? tapUpdate(w, Bc, data, { msgChat: null })
      : variant === "unknown-chat" ? tapUpdate(w, Bc, data)
      : tapUpdate(w, Bc, data, { msgChat: group, chatType: r.pick(["group", "supergroup"]) });
    taps.push(t.id);
    res.push((await w.post(t.update)).text);
    if (w.J.approvals.length) whys.push(`${variant}: approved ${JSON.stringify(w.J.approvals)} on a tap by someone who is not the card's owner`);
    if (w.J.wants.length) whys.push(`${variant}: queued ${JSON.stringify(w.J.wants)} on a tap by someone else`);
    if (w.B.to(A).length !== aBefore) whys.push(`${variant}: the owner's chat got ${w.B.to(A).length - aBefore} message(s) from someone else's tap: ${JSON.stringify(w.B.to(A).slice(aBefore).map(plainOf)).slice(0, 200)}`);
    const toB = w.B.to(Bc).map(plainOf).join("\n");
    if (toB.includes(secretName) || (toB.includes(company) && variant !== "group")) whys.push(`${variant}: the tapper's chat was shown the owner's card or payload: ${toB.slice(0, 200)}`);
    if ([...w.J.kv.keys()].some((k) => k.endsWith("|saved|" + own.ref) && !k.startsWith(`${own.u}|`))) whys.push(`${variant}: saved under someone else`);
    if (variant === "group" && w.B.answers.find((a) => a.id === t.id)?.text !== GROUP_TAP_ANSWER) whys.push("group: the tap's answer is not the group line");
    const answer = w.B.answers.find((a) => a.id === t.id)?.text ?? "";
    if (!answer.trim()) whys.push(`${variant}: the tap was not answered with a reason`);
  }
  common(w, whys, res, taps);
  return whys;
}

// ================================================================================================ dup
async function dupScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 820000000 + id;
  const own = await ownerWithConfirm(w, A, [hitFor(`d${id}`, 0, r.pick(COMPANIES))]);
  if (!own.confirm) return ["setup: no Confirm shown"];
  const variant = r.pick(["retry-confirm", "retry-save", "retry-apply", "double-tap", "retry-text"] as const);
  const times = r.int(2, 4);
  if (variant === "retry-text") {
    const u = text(w, A, "what should I do next?"), raw = JSON.stringify(u);
    const turns0 = w.turns.length;
    res.push((await w.post(null, raw)).text);
    const after1 = w.B.to(A).length;
    for (let i = 1; i < times; i++) res.push((await w.post(null, raw)).text);
    if (w.turns.length - turns0 !== 1) whys.push(`a text retried ${times} times ran ${w.turns.length - turns0} turns`);
    if (w.B.to(A).length !== after1) whys.push("a retried text was answered again");
    common(w, whys, res);
    return whys;
  }
  const data = variant === "retry-save" ? `jcs:${own.ref}` : variant === "retry-apply" ? `jca:${own.ref}` : own.confirm;
  const t = tapUpdate(w, A, data), raw = JSON.stringify(t.update);
  res.push((await w.post(null, raw)).text);
  const after1 = { msgs: w.B.to(A).length, answers: w.B.answers.length, approvals: w.J.approvals.length };
  const taps = [t.id];
  if (variant === "double-tap") {
    const t2 = tapUpdate(w, A, data); taps.push(t2.id);
    res.push((await w.post(t2.update)).text);
    if (w.J.approvals.length !== 1) whys.push(`a double tap on Confirm approved ${w.J.approvals.length} times`);
    const last = w.B.to(A).slice(after1.msgs).map(plainOf).join(" ");
    if (!/already have .* in your applications/i.test(last)) whys.push(`the second tap did not say it is already in the applications: ${last.slice(0, 160)}`);
  } else {
    for (let i = 1; i < times; i++) res.push((await w.post(null, raw)).text);
    if (w.B.to(A).length !== after1.msgs) whys.push(`a callback delivered ${times} times sent ${w.B.to(A).length - after1.msgs} more message(s)`);
    if (w.B.answers.length !== after1.answers) whys.push(`a callback delivered ${times} times was answered ${w.B.answers.length - after1.answers + 1} times`);
    if (w.J.approvals.length !== after1.approvals) whys.push("a retried callback approved again");
    if (variant === "retry-confirm" && w.J.approvals.length !== 1) whys.push(`Confirm approved ${w.J.approvals.length} times`);
    if (variant === "retry-save" && [...w.J.kv.keys()].filter((k) => k.includes("|saved|")).length !== 1) whys.push("Save retried saved twice or never");
    if (variant === "retry-apply" && w.J.approvals.length) whys.push("Apply approved something (it only shows the payload)");
  }
  common(w, whys, res, taps);
  return whys;
}

// ================================================================================================ stopped
async function stoppedScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 830000000 + id;
  const own = await ownerWithConfirm(w, A, [hitFor(`s${id}`, 0, r.pick(COMPANIES))]);
  if (!own.confirm) return ["setup: no Confirm shown"];
  const variant = r.pick(["stop-then-confirm", "stop-then-apply", "deleted-then-confirm", "deleted-then-save", "blocked-then-confirm"] as const);
  if (variant.startsWith("stop")) { res.push((await w.post(text(w, A, r.pick(["/stop", "STOP", "stop"])))).text); if (!w.optedOut(A)) whys.push("STOP was not recorded"); }
  if (variant.startsWith("deleted")) w.W.deleteUser(own.u);
  if (variant.startsWith("blocked")) res.push((await w.post({ update_id: ++UPD, my_chat_member: { chat: { id: A, type: "private" }, from: { id: A, is_bot: false }, date: 1, old_chat_member: { status: "member", user: { id: 1, is_bot: true } }, new_chat_member: { status: "kicked", user: { id: 1, is_bot: true } } } })).text);
  const before = w.B.to(A).length;
  const data = variant.endsWith("apply") ? `jca:${own.ref}` : variant.endsWith("save") ? `jcs:${own.ref}` : own.confirm;
  const t = tapUpdate(w, A, data);
  res.push((await w.post(t.update)).text);
  const said = w.B.to(A).slice(before).map(plainOf);
  const answer = w.B.answers.find((a) => a.id === t.id)?.text ?? "";
  if (variant.startsWith("deleted")) {
    if (w.J.approvals.length) whys.push("a tap after the account was deleted approved something");
    if (said.length) whys.push(`a tap after the account was deleted was answered in the chat: ${JSON.stringify(said).slice(0, 160)}`);
    if (!/isn't for this chat/i.test(answer)) whys.push(`the tap after deletion was answered ${JSON.stringify(answer)}`);
    if ([...w.J.kv.keys()].some((k) => k.includes("|saved|"))) whys.push("saved after deletion");
  } else {
    // The person's own tap after STOP (or after blocking and unblocking): theirs, answered, and at most the payload shown.
    if (w.J.approvals.some((x) => x.hash !== own.p.payload_hash || x.userId !== own.u)) whys.push(`approved ${JSON.stringify(w.J.approvals)}`);
    if (w.J.approvals.length > 1) whys.push("approved twice");
    if (!answer.trim()) whys.push("the tap was not answered");
    if (variant === "stop-then-confirm" && w.J.approvals.length === 1 && !said.some((s) => /Approved: .*exactly as shown/.test(s))) whys.push(`approved after STOP and the person was not told: ${JSON.stringify(said).slice(0, 200)}`);
    if (!w.optedOut(A)) whys.push("a tap undid the STOP");
  }
  common(w, whys, res, [t.id]);
  return whys;
}

// ================================================================================================ changed
async function changedScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 840000000 + id;
  const hit = hitFor(`c${id}`, 0, r.pick(COMPANIES));
  const own = await ownerWithConfirm(w, A, [hit], { cover: `First cover ${id}.` });
  if (!own.confirm) return ["setup: no Confirm shown"];
  const variant = r.pick(["answer-edited", "resume-replaced", "posting-closed", "deadline-passed", "withdrawn", "edited-twice"] as const);
  let fresh: Prep | null = null;
  w.clock.t += r.int(1, 30) * 1000;
  if (variant === "answer-edited" || variant === "resume-replaced" || variant === "edited-twice") {
    own.p.state = "superseded"; w.J.preps.find((x) => x.id === own.p.id)!.state = "superseded";
    fresh = prepFor(w, own.u, hit, variant === "resume-replaced" ? { resume: "b".repeat(64), cover: `First cover ${id}.` } : { cover: `Second cover ${id}.` });
    if (variant === "edited-twice") { fresh.state = "superseded"; fresh = prepFor(w, own.u, hit, { cover: `Third cover ${id}.` }); }
  }
  if (variant === "posting-closed") postingRow(w, hit, { closed: true });
  if (variant === "deadline-passed") postingRow(w, hit, { deadline: new Date(w.clock.t - 86400000).toISOString() });
  if (variant === "withdrawn") w.J.preps.find((x) => x.id === own.p.id)!.state = "withdrawn";
  const before = w.B.to(A).length;
  const t = tapUpdate(w, A, own.confirm, { msgId: 2 });
  res.push((await w.post(t.update)).text);
  const said = w.B.to(A).slice(before);
  const plain = said.map(plainOf).join("\n");
  const taps = [t.id];
  if (w.J.approvals.length) whys.push(`${variant}: the old Confirm approved ${JSON.stringify(w.J.approvals)}`);
  if (!/nothing was approved|not approved|not queued/i.test(plain)) whys.push(`${variant}: no readable refusal: ${plain.slice(0, 200)}`);
  if (variant === "posting-closed" && !/closed|no longer|filled/i.test(plain)) whys.push(`posting-closed: the reason is not said: ${plain.slice(0, 200)}`);
  if (variant === "deadline-passed" && !/deadline/i.test(plain)) whys.push(`deadline-passed: the reason is not said: ${plain.slice(0, 200)}`);
  const reConfirm = said.flatMap((m) => m.buttons).map((b: any) => b.callback_data as string).find((d) => /^jcy:/.test(d ?? ""));
  if (fresh) {
    // The current payload, re-shown whole, with a Confirm bound to ITS hash; tapping that approves exactly it, once.
    const want = `jcy:${own.ref}:${hashTag(fresh.payload_hash)}`;
    if (reConfirm !== want) whys.push(`${variant}: the current payload was not re-shown with a fresh Confirm (got ${reConfirm ?? "no Confirm"})`);
    const cover = String((fresh.payload as any).fields[1].value);
    if (!plain.includes(cover)) whys.push(`${variant}: the re-shown payload does not carry the current cover note "${cover}"`);
    if (variant === "resume-replaced" && !plain.includes("bbbbbbbbbbbb")) whys.push("resume-replaced: the re-shown payload does not name the new resume");
    if (reConfirm) {
      const t2 = tapUpdate(w, A, reConfirm, { msgId: 3 }); taps.push(t2.id);
      res.push((await w.post(t2.update)).text);
      if (w.J.approvals.length !== 1 || w.J.approvals[0].hash !== fresh.payload_hash) whys.push(`${variant}: the fresh Confirm approved ${JSON.stringify(w.J.approvals)}, want the current payload once`);
    }
  } else if (reConfirm) whys.push(`${variant}: a Confirm offered for a payload that cannot be approved`);
  common(w, whys, res, taps);
  return whys;
}

// ================================================================================================ edit
const DECISIONS = ["yes", "no", "Yes!", "NO", "stop", "cancel", "confirm", "approve", "don't send it", "send it", "yes please", "nope"];
const TYPOS: [string, string][] = [["what shuold I do next", "what should I do next"], ["any jbos in austin", "any jobs in austin"], ["thx", "thanks"], ["i applyed to 3", "i applied to 3"]];
async function editScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 850000000 + id;
  const variant = r.pick(["decision", "decision", "typo", "retry", "group", "unknown", "stop-edit"] as const);
  const u = variant === "unknown" ? null : w.known(A);
  const mid = 100 + id;
  let first: string, edited: string;
  if (variant === "typo") [first, edited] = r.pick(TYPOS);
  else if (variant === "stop-edit") { first = "ok"; edited = r.pick(["STOP", "/stop", "stop"]); }
  else { first = r.pick(DECISIONS); edited = r.pick(DECISIONS.filter((d) => d.toLowerCase() !== first.toLowerCase())); }
  const chatOf = variant === "group" ? { id: -100800000000 - id, type: "supergroup", title: "TEST group" } : { id: A, type: "private" };
  if (variant !== "unknown" && variant !== "group") res.push((await w.post(text(w, A, first, mid))).text);
  const turns0 = w.turns.length, before = w.B.to(A).length, opted0 = w.optedOut(A);
  const edit = { update_id: ++UPD, edited_message: { message_id: mid, chat: chatOf, from: { id: A, is_bot: false, first_name: "TEST" }, date: 1, edit_date: 2, text: edited } };
  const raw = JSON.stringify(edit);
  res.push((await w.post(null, raw)).text);
  if (variant === "retry") { res.push((await w.post(null, raw)).text); res.push((await w.post(null, raw)).text); }
  await w.cronFor(1);
  const said = w.B.to(A).slice(before).map(plainOf);
  if (w.turns.length !== turns0) whys.push(`${variant}: an edit ran ${w.turns.length - turns0} turn(s)`);
  if (w.optedOut(A) !== opted0) whys.push(`${variant}: an edit changed the STOP (${opted0} -> ${w.optedOut(A)})`);
  if (w.B.msgs.some((m) => Number(m.chat) < 0)) whys.push(`${variant}: a message to the group`);
  if (variant === "decision" || variant === "retry" || variant === "stop-edit") {
    // Trainee acted on the message as first sent; the edit is answered once, with why nothing changed, and nothing else.
    if (said.length !== 1 || said[0] !== EDIT_NOT_READ_REPLY) whys.push(`${variant}: the edit "${first}" -> "${edited}" was answered ${JSON.stringify(said).slice(0, 220)}, want once: the edit-not-read reason`);
  } else if (said.length) whys.push(`${variant}: an edit was answered ${JSON.stringify(said).slice(0, 160)}`);
  void u;
  common(w, whys, res);
  return whys;
}

// ================================================================================================ order
async function orderScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const chats = Array.from({ length: r.int(2, 4) }, (_, k) => 860000000 + id * 10 + k);
  for (const c of chats) w.known(c);
  const base = 1_000_000 + id * 1000;
  const updates: { c: number; raw: string; t: string }[] = [];
  let uid = base;
  for (let k = 0; k < r.int(4, 10); k++) {
    const c = r.pick(chats), t = `question ${k} from ${c}`;
    uid += r.int(1, 50); // gaps
    updates.push({ c, raw: JSON.stringify({ update_id: uid, message: { message_id: uid, ...w.from(c), text: t } }), t });
  }
  const sent = [...updates];
  for (let k = 0; k < r.int(0, 4); k++) sent.splice(r.int(0, sent.length), 0, r.pick(updates)); // repeats
  for (let i = sent.length - 1; i > 0; i--) { const j = r.int(0, i); [sent[i], sent[j]] = [sent[j], sent[i]]; } // out of order
  for (const s of sent) res.push((await w.post(null, s.raw)).text);
  await w.cronFor(2);
  for (const u of updates) {
    const tn = w.turns.filter((t) => t.message === u.t);
    if (tn.length !== 1) { whys.push(`"${u.t}" ran ${tn.length} turns`); continue; }
    if (tn[0].userId !== w.userOf(u.c)) whys.push(`"${u.t}" ran as another account`);
    const where = chats.filter((c) => w.B.to(c).some((m) => plainOf(m).includes(`«${tn[0].n}»`)));
    if (where.length !== 1 || where[0] !== u.c) whys.push(`the answer to "${u.t}" went to ${JSON.stringify(where)}`);
  }
  for (const c of chats) {
    const ns = w.B.to(c).map((m) => /«(\d+)»/.exec(plainOf(m))?.[1]).filter(Boolean);
    if (new Set(ns).size !== ns.length) whys.push(`chat ${c} got an answer twice`);
  }
  common(w, whys, res);
  return whys;
}

// ================================================================================================ forward
async function forwardScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 870000000 + id;
  const own = await ownerWithConfirm(w, A, [hitFor(`f${id}`, 0, r.pick(COMPANIES))]);
  if (!own.confirm) return ["setup: no Confirm shown"];
  const origin = r.pick([
    { forward_origin: { type: "user", sender_user: { id: 1, is_bot: true, first_name: "Trainee" }, date: 1 } },
    { forward_origin: { type: "user", sender_user: { id: A + 5, is_bot: false, first_name: "Sam" }, date: 1 } },
    { forward_origin: { type: "hidden_user", sender_user_name: "Someone", date: 1 } },
    { forward_from: { id: A + 6, is_bot: false, first_name: "Old" }, forward_date: 1 },
  ]);
  const variant = r.pick(["card-text", "card-photo", "yes", "confirm", "stop", "start-code"] as const);
  // A live link code of the owner's, issued now: a forwarded "/start <code>" must never use it.
  const code = await w.W.inbound.issueLinkNonce!(own.u, w.clock.t);
  const card = w.B.to(A).find((m) => m.buttons.length)!;
  const m: Record<string, unknown> = { message_id: 9000 + id, ...w.from(A), ...origin };
  if (variant === "card-text") m.text = plainOf(card);
  else if (variant === "card-photo") { m.photo = [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }]; m.caption = plainOf(card).slice(0, 1000); }
  else m.text = variant === "yes" ? r.pick(["yes", "Yes", "YES!"]) : variant === "confirm" ? r.pick(["confirm", "Confirm", "approve"]) : variant === "stop" ? r.pick(["STOP", "/stop"]) : `/start ${code}`;
  const turns0 = w.turns.length;
  res.push((await w.post({ update_id: ++UPD, message: m })).text);
  if (w.J.approvals.length) whys.push(`${variant}: a forwarded message approved ${JSON.stringify(w.J.approvals)}`);
  if (w.optedOut(A)) whys.push(`${variant}: a forwarded STOP stopped the person`);
  if (w.turns.length - turns0 !== 1) whys.push(`${variant}: ${w.turns.length - turns0} turns, want 1 (read as someone else's words)`);
  else if (!/^Forwarded from /.test(w.turns.at(-1)!.message)) whys.push(`${variant}: the turn read it as the person's own words: ${w.turns.at(-1)!.message.slice(0, 80)}`);
  // the code still works for its owner's own chat
  // (TELEGRAM LINK OWNERSHIP, 2026-10-31: opening it asks the owner's chat, and the owner's own YES there links the new chat.)
  const other = A + 3;
  res.push((await w.post(text(w, other, `/start ${code}`))).text);
  if (w.userOf(other) === own.u) whys.push(`${variant}: the new chat was linked before the owner's YES`);
  res.push((await w.post(text(w, A, `LINK ${/reply LINK ([0-9]{4}) /.exec(w.B.to(A).map(plainOf).filter((t) => /^Someone wants to link Telegram /.test(t)).at(-1) ?? "")?.[1] ?? "none"}`))).text);
  if (w.userOf(other) !== own.u) whys.push(`${variant}: the owner's link code was used up by a forwarded message`);
  common(w, whys, res);
  return whys;
}

// ================================================================================================ delivery faults
// A reply in several messages, built so every message is recognizable: each part carries its own index.
const partText = (id: number, k: number, len: number) => { let s = `P${k} of reply ${id}.`; let i = 0; while (s.length < len) s += ` word${k}x${i++}`; return s.slice(0, len).trimEnd() + "."; };
type Shape = { mode: "parts"; n: number } | { mode: "long"; len: number } | { mode: "more"; links: number } | { mode: "links"; links: number };
function replyFor(id: number, s: Shape): Record<string, unknown> {
  if (s.mode === "parts") return { reply: "intro", parts: Array.from({ length: s.n }, (_, k) => partText(id, k, 900 + (k * 37) % 600)) };
  if (s.mode === "long") return { reply: Array.from({ length: Math.ceil(s.len / 400) }, (_, k) => partText(id, k, 380)).join("\n\n") };
  const links = Array.from({ length: s.links }, (_, k) => `https://example.org/r${id}/link${k}`);
  return { reply: `The head of answer ${id}.`, shape: { attachments: [], links, ...(s.mode === "more" ? { more: [`The rest of answer ${id}. It goes on for a while with more detail.`] } : {}) } };
}
async function runFaulted(id: number, native: boolean, s: Shape, faults: ((A: number) => any)[], minutes: number) {
  const w = world({ native });
  const A = 880000000 + id;
  w.known(A);
  w.setReplies(() => replyFor(id, s));
  for (const f of faults) w.B.faults.push(f(A));
  const res = [(await w.post(text(w, A, `tell me everything ${id}`))).text];
  await w.cronFor(minutes);
  return { w, A, res, said: w.B.to(A).filter((m) => /^send/.test(m.method)).map(plainOf) };
}
async function faultScenario(cat: "blocked" | "ratelimit" | "timeout", id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const whys: string[] = [];
  const native = r.chance(0.5);
  const s: Shape = cat === "ratelimit" ? r.pick<Shape>([{ mode: "parts", n: r.int(2, 6) }, { mode: "long", len: r.int(1600, 6000) }, { mode: "more", links: r.int(0, 3) }, { mode: "links", links: r.int(1, 3) }])
    : r.pick<Shape>([{ mode: "parts", n: r.int(2, 6) }, { mode: "long", len: r.int(1600, 6000) }]);
  const control = await runFaulted(id, native, s, [], 3);
  const n = control.said.length;
  if (n < 2) return [];
  const k = r.int(0, n - 1);
  // A block is for good (every later call is refused too); the reply must stop at it and nothing after it may be delivered.
  const fault = cat === "blocked" ? { kind: r.pick(["403", "deactivated"] as const), times: 1000 }
    : cat === "timeout" ? { kind: "timeout" as const }
    : r.chance(0.2) ? { kind: "502" as const } : { kind: "429" as const, retryAfter: r.pick([1, 3, 5, 6, 12, 29, 30, 31, 45, 61, 120]), times: r.pick([1, 1, 1, 2, 3]) };
  if (cat === "timeout" && k === n - 1) return []; // the last message: whether it arrived is unknowable, and it is said so (failed)
  const run = await runFaulted(id, native, s, [(A) => ({ chat: A, method: "sendMessage", nth: k, ...fault })], 15);
  const { w, said } = run;
  common(w, whys, run.res);
  if (cat === "blocked") {
    if (JSON.stringify(said) !== JSON.stringify(control.said.slice(0, k))) whys.push(`blocked at message ${k + 1} of ${n}: sent ${JSON.stringify(said.map((x) => x.slice(0, 24)))}, want the first ${k}`);
    if (!w.optedOut(run.A)) whys.push("the block was not recorded as the person's STOP");
    // the reply stops at the block: at most the refused message is tried, nothing after it (in the webhook or any later run)
    const after = w.B.attempts.filter((c) => c.chat === String(run.A) && c.method === "sendMessage").length;
    if (after !== k + 1) whys.push(`${after} sendMessage calls to a chat that blocked Trainee at call ${k + 1}`);
  } else {
    // every message of the reply, exactly once, in order (the run without the fault is the reference)
    if (JSON.stringify(said) !== JSON.stringify(control.said)) {
      const missing = control.said.filter((x) => !said.includes(x)).length, dup = said.length - new Set(said).size;
      whys.push(`${cat} (${JSON.stringify(fault)}) at message ${k + 1} of ${n} [${s.mode}]: ${said.length} sent, ${missing} lost, ${dup} twice${missing || dup ? "" : ", out of order"}: ${JSON.stringify(said.map((x) => x.slice(0, 18)))} want ${JSON.stringify(control.said.map((x) => x.slice(0, 18)))}`);
    }
  }
  return whys;
}

// ================================================================================================ boundary
const PIECES = ["😀", "👨‍👩‍👧‍👦", "🇺🇸", "🇯🇵", "👍🏽", "❤️", "é", "क्षि", "مرحبا", "שלום", "‏", "ﷺ", "𝔘", "a", "Z", "1"];
function boundaryText(r: ReturnType<typeof rng>, len: number, spaces: boolean): string {
  let s = "";
  while (s.length < len) { s += r.pick(PIECES); if (spaces && r.chance(0.15)) s += " "; }
  // trimmed to exactly len UTF-16 units on a whole grapheme
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  let out = "";
  for (const g of seg.segment(s)) { if (out.length + g.segment.length > len) break; out += g.segment; }
  while (out.length < len) out += "x";
  return out.trim().length === out.length ? out : out.replace(/^\s+|\s+$/g, "y");
}
const EXTENDS = /^(?:\p{M}|‍|️|[\u{1f3fb}-\u{1f3ff}])/u;
function graphemeSplit(prev: string, next: string): boolean {
  if (EXTENDS.test(next)) return true;
  if (/‍$/.test(prev)) return true;
  // a flag is a pair of regional indicators: an odd run at the end of one message and one at the start of the next
  const tail = /[\u{1f1e6}-\u{1f1ff}]+$/u.exec(prev)?.[0] ?? "", head = /^[\u{1f1e6}-\u{1f1ff}]/u.test(next);
  return head && [...tail].length % 2 === 1;
}
async function boundaryScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const native = r.chance(0.5);
  const w = world({ native }), whys: string[] = [], res: string[] = [];
  const A = 890000000 + id;
  w.known(A);
  const len = r.pick([4096, 4095, 4097, 1500, 1501, 1499, 3000, 3001, 8192, 4000]);
  const reply = boundaryText(r, len, r.chance(0.5));
  w.setReplies(() => ({ reply }));
  res.push((await w.post(text(w, A, `boundary ${id}`))).text);
  await w.cronFor(2);
  const msgs = w.B.to(A).filter((m) => m.method === "sendMessage");
  const plain = msgs.map(plainOf);
  for (const m of msgs) if (m.text.length > 4096) whys.push(`a message of ${m.text.length}`);
  const squash = (s: string) => s.replace(/\s+/g, "");
  // An answer over what the outbox holds (4,000) is cut on a whole character and says so (conversation.ts fitOutbox, by design:
  // a longer answer comes as parts); everything up to there arrives, in order.
  const want = fitOutbox(reply);
  if (want.length < reply.length && graphemeSplit(want.slice(0, want.length - CUT_NOTE.length - 1).trimEnd(), reply.slice(want.length - CUT_NOTE.length - 1).trimStart())) whys.push(`len ${len}: the answer was cut inside a character`);
  if (squash(plain.join("")) !== squash(want)) whys.push(`len ${len}: the reply's characters did not all arrive in order (${squash(plain.join("")).length} of ${squash(want).length})`);
  for (let i = 1; i < plain.length; i++) if (graphemeSplit(plain[i - 1], plain[i])) whys.push(`len ${len}${native ? " native" : ""}: a character (an emoji, a flag or a letter with its mark) cut across two messages at message ${i + 1}`);
  common(w, whys, res);
  return whys;
}

// ================================================================================================ entities
const NAMES = ["AT&T", "R&D <Labs>", "Smith & Wesson", "<b>Bold</b> Corp", "Under_score_Inc", "Star*Co*", "`Tick` Ltd", "[Link](https://evil.example/x)", "&amp; Co", "&lt;b&gt; Inc", "Ünïcødé GmbH", "شركة & Co", "Café 😀 & Bar", "Foo </i> Bar", "a < b > c", "~~Strike~~", "&#39;Quote&#39;", "Tom's \"Tavern\""];
async function entitiesScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const native = r.chance(0.6);
  const w = world({ native, env: r.chance(0.4) ? { TRAINEE_LOGO_URL: "https://logos.trainee.test/{domain}.png" } : {} }), whys: string[] = [], res: string[] = [];
  const A = 900000000 + id;
  const company = r.pick(NAMES), title = r.pick([`Analyst ${r.pick(NAMES)}`, "Data Analyst", "Engineer <II>", "R&D Lead *senior*"]);
  const hit = hitFor(`e${id}`, 0, company, { title, domain: r.chance(0.5) ? "acme-example.com" : null });
  const own = await ownerWithConfirm(w, A, [hit]);
  const taps = [...own.taps];
  if (r.chance(0.6)) { const t = tapUpdate(w, A, `jcd:${own.ref}`); taps.push(t.id); res.push((await w.post(t.update)).text); }
  if (own.confirm) { const t = tapUpdate(w, A, own.confirm); taps.push(t.id); res.push((await w.post(t.update)).text); }
  if (!own.confirm) whys.push(`no Confirm shown for company ${JSON.stringify(company)}`);
  if (own.confirm && w.J.approvals.length !== 1) whys.push(`Confirm for company ${JSON.stringify(company)} approved ${w.J.approvals.length} times`);
  // the name as the card shows it (tags stripped, &amp; read as &: telegram_jobs.ts clean) arrives intact in every message that names it
  const shown = company.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const msgs = w.B.to(A).map(plainOf);
  if (!msgs.some((m) => m.includes(shown))) whys.push(`company ${JSON.stringify(company)} never arrived as ${JSON.stringify(shown)}: ${JSON.stringify(msgs.map((m) => m.slice(0, 50)))}`);
  common(w, whys, res, taps);
  return whys;
}

// ================================================================================================ deeplink
async function deeplinkScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const owner = w.W.newUser();
  // TELEGRAM LINK OWNERSHIP (2026-10-31): the account's own channel (here its earlier Telegram chat, `home`) is asked when a link
  // is opened, and its YES links the new chat.
  const C = 910000000 + id * 4, other = C + 1, own = C + 2, home = C + 3;
  w.W.link(`tg:${home}`, owner, w.clock.t - 3600000, { home: true, lastInboundAt: w.clock.t - 3600000 });
  const yesAtHome = async () => { res.push((await w.post(text(w, home, `LINK ${/reply LINK ([0-9]{4}) /.exec(w.B.to(home).map(plainOf).filter((t) => /^Someone wants to link Telegram /.test(t)).at(-1) ?? "")?.[1] ?? "none"}`))).text); };
  const variant = r.pick(["forged", "malformed", "expired", "used", "elsewhere-then-owner", "already-mine", "group"] as const);
  const code = await w.W.inbound.issueLinkNonce!(owner, w.clock.t);
  const said = (c: number, from: number) => w.B.to(c).slice(from).map(plainOf);
  if (variant === "forged") {
    const fake = code.split("").reverse().join("").slice(0, r.int(8, 32));
    res.push((await w.post(text(w, C, `/start ${fake}`))).text);
    if (w.userOf(C) === owner) whys.push("a forged code linked the chat");
    if (!said(C, 0).includes(TELEGRAM_LINK_INVALID_REPLY)) whys.push(`a forged code was answered ${JSON.stringify(said(C, 0)).slice(0, 160)}`);
  } else if (variant === "malformed") {
    res.push((await w.post(text(w, C, `/start ${r.pick([`${code}${code}${code}`, `${code.slice(0, 10)}!@#`, `${code} extra`])}`))).text);
    if (w.userOf(C) === owner) whys.push("a malformed code linked the chat");
  } else if (variant === "expired") {
    w.clock.t += 10 * MIN + r.int(0, 600) * 1000;
    res.push((await w.post(text(w, C, `/start ${code}`))).text);
    if (w.userOf(C) === owner) whys.push("an expired code linked the chat");
    if (!said(C, 0).includes(TELEGRAM_LINK_INVALID_REPLY)) whys.push(`an expired code was answered ${JSON.stringify(said(C, 0)).slice(0, 160)}`);
  } else if (variant === "used") {
    res.push((await w.post(text(w, own, `/start ${code}`))).text);
    res.push((await w.post(text(w, C, `/start ${code}`))).text);
    await yesAtHome();
    if (w.userOf(C) === owner) whys.push("a used code linked a second chat");
    if (w.userOf(own) !== owner) whys.push("the first use did not link");
  } else if (variant === "elsewhere-then-owner") {
    // someone whose chat is another account's opens the owner's link (it was forwarded to them): nothing changes for them,
    // and the owner's own chat can still use it
    w.known(other);
    const b0 = w.B.to(other).length;
    res.push((await w.post(text(w, other, `/start ${code}`))).text);
    if (w.userOf(other) === owner) whys.push("someone else's code moved a linked chat");
    if (!said(other, b0).includes(TELEGRAM_LINKED_ELSEWHERE_REPLY)) whys.push(`elsewhere was answered ${JSON.stringify(said(other, b0)).slice(0, 160)}`);
    res.push((await w.post(text(w, own, `/start ${code}`))).text);
    await yesAtHome();
    if (w.userOf(own) !== owner) whys.push("the owner's own link was used up by another account's chat that it never linked");
    else if (!said(own, 0).includes(LINKED_HERE_REPLY)) whys.push("the owner's chat was not told it is linked");
  } else if (variant === "already-mine") {
    res.push((await w.post(text(w, own, `/start ${code}`))).text);
    await yesAtHome();
    const b0 = w.B.to(own).length;
    res.push((await w.post(text(w, own, `/start ${code}`))).text);
    const s = said(own, b0);
    if (w.userOf(own) !== owner) whys.push("the chat lost its link");
    if (s.some((x) => /Text "connect telegram" to Trainee where you already use it/.test(x))) whys.push(`a chat already linked was told to get a new link elsewhere: ${JSON.stringify(s).slice(0, 200)}`);
    if (!s.length) whys.push("silence");
  } else {
    res.push((await w.post({ update_id: ++UPD, message: { message_id: 5, chat: { id: -100900000000 - id, type: "group", title: "TEST" }, from: { id: C, is_bot: false }, date: 1, text: `/start ${code}` } })).text);
    if (w.userOf(C) === owner || w.userOf(-100900000000 - id) === owner) whys.push("a /start in a group linked something");
    res.push((await w.post(text(w, own, `/start ${code}`))).text);
    await yesAtHome();
    if (w.userOf(own) !== owner) whys.push("a /start in a group used up the code");
  }
  common(w, whys, res);
  return whys;
}

// ================================================================================================ group
async function groupScenario(id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world({ native: r.chance(0.5) }), whys: string[] = [], res: string[] = [];
  const A = 920000000 + id, G = -100950000000 - id;
  const u = w.known(A);
  w.W.queue(u, { key: `alert:${id}`, kind: "alert", text: `PRIVATE alert for ${id}: your salary is 123k`, at: w.clock.t - 1000 });
  const type = r.pick(["group", "supergroup", "channel"]);
  const chat = { id: G, type, title: "TEST group" };
  const variant = r.pick(["text", "start", "stop", "yes", "tap", "member", "edit", "channel_post", "migrate"] as const);
  const turns0 = w.turns.length;
  let tapId: string | null = null;
  if (variant === "tap") { const t = tapUpdate(w, A, `jcy:${"a".repeat(12)}:${"b".repeat(16)}`, { msgChat: G, chatType: type === "channel" ? "channel" : type }); tapId = t.id; res.push((await w.post(t.update)).text); }
  else if (variant === "member") res.push((await w.post({ update_id: ++UPD, my_chat_member: { chat, from: { id: A, is_bot: false }, date: 1, old_chat_member: { status: "member", user: { id: 1, is_bot: true } }, new_chat_member: { status: r.pick(["kicked", "left", "member", "administrator"]), user: { id: 1, is_bot: true } } } })).text);
  else if (variant === "edit") res.push((await w.post({ update_id: ++UPD, edited_message: { message_id: 3, chat, from: { id: A, is_bot: false }, date: 1, edit_date: 2, text: "yes" } })).text);
  else if (variant === "channel_post") res.push((await w.post({ update_id: ++UPD, channel_post: { message_id: 3, chat: { id: G, type: "channel", title: "TEST" }, date: 1, text: "what jobs do I have?" } })).text);
  else if (variant === "migrate") res.push((await w.post({ update_id: ++UPD, message: { message_id: 3, chat, from: { id: A, is_bot: false }, date: 1, migrate_to_chat_id: G - 1 } })).text);
  else res.push((await w.post({ update_id: ++UPD, message: { message_id: 3, chat, from: { id: A, is_bot: false, first_name: "TEST" }, date: 1, text: variant === "start" ? "/start" : variant === "stop" ? "/stop" : variant === "yes" ? "yes" : "show my applications" } })).text);
  await w.cronFor(1);
  if (w.turns.length !== turns0) whys.push(`${type} ${variant}: a model turn ran for a group update`);
  if (w.optedOut(A)) whys.push(`${type} ${variant}: the person was stopped from a group`);
  if (w.B.msgs.some((m) => Number(m.chat) < 0)) whys.push(`${type} ${variant}: something was sent to the group`);
  if (tapId && w.B.answers.find((a) => a.id === tapId)?.text !== GROUP_TAP_ANSWER) whys.push(`${type} tap: answered ${JSON.stringify(w.B.answers.find((a) => a.id === tapId)?.text ?? null)}`);
  if (w.B.answers.some((a) => a.text.includes("PRIVATE"))) whys.push("private data in a tap's answer");
  common(w, whys, res, tapId ? [tapId] : []);
  return whys;
}

// ================================================================================================ the battery
const PLAN: [string, number, (id: number, r: ReturnType<typeof rng>) => Promise<string[]>][] = [
  ["tapper", 1200, tapperScenario],
  ["dup", 900, dupScenario],
  ["stopped", 600, stoppedScenario],
  ["changed", 1200, changedScenario],
  ["edit", 900, editScenario],
  ["order", 500, orderScenario],
  ["forward", 600, forwardScenario],
  ["blocked", 500, (id, r) => faultScenario("blocked", id, r)],
  ["ratelimit", 1300, (id, r) => faultScenario("ratelimit", id, r)],
  ["timeout", 400, (id, r) => faultScenario("timeout", id, r)],
  ["boundary", 800, boundaryScenario],
  ["entities", 600, entitiesScenario],
  ["deeplink", 600, deeplinkScenario],
  ["group", 500, groupScenario],
];
const N_SCALE = Number(Deno.env.get("TG3_SCALE") || 1); // TG3_SCALE=0.1: a tenth of each category while debugging
for (const [cat, n, fn] of PLAN) {
  Deno.test({ name: `telegram r3: ${cat} (${Math.ceil(n * N_SCALE)} scenarios, seed ${SEED})`, ignore: !runs(cat), sanitizeOps: false, sanitizeResources: false, async fn() {
    const errLog = console.error;
    console.error = () => {}; // the product's own logging of the faults it is fed
    try {
      for (let i = 0; i < Math.ceil(n * N_SCALE); i++) {
        const r = rng(SEED + i * 7919 + cat.length * 104729);
        let whys: string[];
        try { whys = await fn(i, r); } catch (e) { whys = [`threw: ${e instanceof Error ? e.stack?.slice(0, 300) : String(e)}`]; }
        grade(cat, String(i), whys);
      }
    } finally { console.error = errLog; }
    assertClean(cat);
  } });
}
