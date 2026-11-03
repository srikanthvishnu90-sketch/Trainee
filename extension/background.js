// WO-031: the extension's service worker. It holds the person's session (chrome.storage.session only: no password, ever),
// reads their facts and saved answers through their own RPCs, keeps one review card per tab, and sends the content script
// the submit only after the person's one tap approved that card's exact payload hash. It records every application
// through the person's own RPCs (career_apply_extension_begin_own before the click, career_apply_finish_own after) and
// keeps the evidence locally. It never solves a verification and never sends anything the person did not approve.
importScripts("config.js", "lib/trainee-core.js");
const C = globalThis.TraineeCore;

const S = chrome.storage.session, L = chrome.storage.local;
const get = async (area, key, dflt) => (await area.get(key))[key] ?? dflt;
const put = (area, key, value) => area.set({ [key]: value });
const sha256Hex = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((n) => n.toString(16).padStart(2, "0")).join("");
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const say = {
  signedOut: "Sign in to Upmore in the Trainee panel first. Nothing was filled.",
  handoff: "A verification check is showing on the page. Finish it yourself there, then press Approve again. Trainee never answers one.",
  pressYourself: "Filled and checked. Read every answer on the page, then press the site's own Submit yourself. Trainee will not press it.",
  leftWithoutPress: "You left the page without pressing Submit. Nothing was sent.",
  agentOff: "Trainee sending is off in this build. Nothing is sent without your tap on each card.",
  agentSending: "Every answer is exactly what you approved in your batch. Sending with the site's own Submit...",
  agentDiffers: "Not sent: this page differs from what you approved in your batch, so it waits for you.",
};
const PERSON_REPORT_GRACE_MS = 1500;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

// Where the session goes is fixed by config.js, never by storage: a content script can write chrome.storage.local, and a
// value written there must never send the person's token to another server (WO-031 review).
async function config() {
  return { ...globalThis.TRAINEE_DEFAULTS };
}

// ------------------------------------------------------------------------------------------------ the person's session
// Only the session the person already has in the Upmore app (their own sign-in: password, Google or a magic link, done
// in the app) or a fresh one from a magic link they open themselves. Kept in chrome.storage.session, which Chrome keeps
// in memory and clears when the browser closes. A service key is refused: this computer runs only its person's own work.
function claims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return {};
  }
}
async function keepSession(s) {
  if (!s || typeof s.access_token !== "string" || typeof s.refresh_token !== "string" || !s.refresh_token) throw Error("NOT_A_SESSION");
  if (C.jwtRole(s.access_token) !== "authenticated") throw Error("SERVICE_KEY_REFUSED");
  const c = claims(s.access_token);
  if (!c.sub) throw Error("NOT_A_SESSION");
  await put(S, "auth", { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Number(s.expires_at) || c.exp || 0, user_id: c.sub, email: c.email || s.user?.email || "" });
}
async function session() {
  const a = await get(S, "auth", null);
  if (!a) return null;
  if (a.expires_at && a.expires_at * 1000 - Date.now() < 60_000) {
    const cfg = await config();
    const r = await fetch(cfg.supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: { apikey: cfg.anonKey, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: a.refresh_token }),
    }).catch(() => null);
    if (!r || !r.ok) {
      await S.remove("auth");
      return null;
    }
    await keepSession(await r.json());
    return await get(S, "auth", null);
  }
  return a;
}
async function signInFromApp() {
  const cfg = await config();
  const origin = new URL(cfg.appUrl).origin;
  const tabs = (await chrome.tabs.query({})).filter((t) => t.url && t.url.startsWith(origin + "/"));
  if (!tabs.length) return { ok: false, message: `Open ${origin} in a tab, sign in there as you always do, then press this again.` };
  for (const t of tabs) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: () => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (/^sb-[a-z0-9]+-auth-token$/.test(k)) return localStorage.getItem(k);
        }
        return null;
      },
    }).catch(() => [null]);
    if (!res?.result) continue;
    try {
      const j = JSON.parse(res.result);
      await keepSession(j.currentSession ?? j);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message === "SERVICE_KEY_REFUSED" ? "That is not a person's sign-in; Trainee only runs as you." : "The Upmore tab is not signed in yet." };
    }
  }
  return { ok: false, message: "The Upmore tab is not signed in yet. Sign in there, then press this again." };
}
async function magicLink(email) {
  const cfg = await config();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""))) return { ok: false, message: "That does not look like an email address." };
  const r = await fetch(cfg.supabaseUrl + "/auth/v1/otp?redirect_to=" + encodeURIComponent(cfg.appUrl), {
    method: "POST", headers: { apikey: cfg.anonKey, "content-type": "application/json" }, body: JSON.stringify({ email, create_user: false }),
  }).catch(() => null);
  if (!r || !r.ok) return { ok: false, message: "The sign-in link could not be sent. Try again, or sign in on the Upmore app." };
  return { ok: true, message: "Open the link in that email on this computer. It signs you in to Upmore; then press Use my Upmore sign-in." };
}

// The person's own RPCs, as them (their session token; the anon key only names the project).
async function rpc(name, args) {
  const a = await session();
  if (!a) throw Error("SIGNED_OUT");
  const cfg = await config();
  const r = await fetch(cfg.supabaseUrl + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { apikey: cfg.anonKey, authorization: "Bearer " + a.access_token, "content-type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message || text;
    } catch { /* plain text */ }
    if (r.status === 401 || /jwt|not signed in/i.test(msg)) throw Error("SIGNED_OUT");
    throw Error(String(msg).slice(0, 200));
  }
  return text ? JSON.parse(text) : null;
}
async function selectOwn(path) {
  const a = await session();
  if (!a) throw Error("SIGNED_OUT");
  const cfg = await config();
  const r = await fetch(cfg.supabaseUrl + "/rest/v1/" + path, { headers: { apikey: cfg.anonKey, authorization: "Bearer " + a.access_token } });
  if (!r.ok) throw Error("READ_FAILED");
  return await r.json();
}

// ------------------------------------------------------------------------------------------------ facts and answers
// The person's confirmed facts: what they answered Trainee by text (career_apply_answers_own; a fact for every employer,
// or one wording, or one posting) plus, if they chose, the same confirmed-facts file the desktop runner reads (only
// entries marked confirmed, only theirs). Read fresh for each form, so an answer texted a minute ago fills now.
// WO-102: only what the trusted fact manifest keeps (TraineeCore.trustedManifest): a positive allowlist of the facts the
// person gave, the D-007 quarantine applied, conflicts excluded so they are asked again. Its hash and quarantine version
// are bound into every approval and checked again, fresh, at the start of every application ("begin").
async function facts(userId) {
  const file = await get(S, "imported_file", null);
  let rows = [];
  try {
    rows = (await rpc("career_apply_answers_own", {})) || [];
  } catch (e) {
    if (e.message === "SIGNED_OUT") throw e;
  }
  const resume = await get(L, "resume", null);
  const m = C.trustedManifest({ owner: userId, file, rows, resume: resume ? { sha256: resume.sha256 } : null });
  // WO-054: the stored rows of answers the person gave in the panel before the session, for the card's mark.
  const beforeKeys = new Set(await get(S, "answered_before", []));
  return { answers: m.answers, saved: m.saved, answered: rows.map((r) => r.key), userId, before: rows.filter((r) => beforeKeys.has(r.key)).map((r) => "text-answer:" + r.id),
    manifest: { hash: m.hash, version: m.version, byFactId: m.byFactId, answers: m.answers, saved: m.saved, excluded: m.excluded.length, conflicts: m.conflicts.map((c) => c.key) } };
}
// The facts behind an application's answers must all still be in the person's manifest now (WO-102: revalidated at the
// boundary): the trusted fact behind each answer Trainee filled, and the facts behind each drafted answer.
function factsStillGiven(payload, manifest) {
  const gone = [];
  for (const f of payload?.fields || []) {
    const ids = f.source === "trainee" ? [f.factId] : f.source === "drafted" ? C.draftFactIds(f.factId) : [];
    if (ids.some((id) => !id || !manifest.byFactId[id])) gone.push(f.label);
  }
  return gone;
}

// Session-only fact import is a review, then one exact-row confirmation. File flags never supply that confirmation.
// Serialize imports so two panel windows cannot read the same old map and overwrite each other's accepted answers.
let factImportQueue = Promise.resolve();
async function importFactFile(m, sender) {
  const a = await session(), receipt = { version: 1, scope: "browser_session", actor_id: a?.user_id || null, accepted: [], rejected: [], needs_review: [] };
  const fail = (message) => ({ ok: false, kept: 0, excluded: receipt.rejected.length, receipt, message });
  if (!a || sender.id !== chrome.runtime.id || typeof sender.url !== "string" || sender.url.split(/[?#]/)[0] !== chrome.runtime.getURL("panel.html")) return fail("Only your signed-in Trainee panel can review imported answers.");
  const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  let doc;
  try { doc = JSON.parse(m.json); } catch { return fail("That file is not valid JSON. Your existing imported answers were kept."); }
  if (!record(doc) || doc.user_id !== a.user_id || (doc.format !== undefined && doc.format !== "trainee-facts") || (doc.version !== undefined && doc.version !== 1) || Object.hasOwn(doc, "facts") || (!Object.hasOwn(doc, "answers") && !Object.hasOwn(doc, "saved"))) return fail("Unsupported facts format, version or account owner. Your existing imported answers were kept.");
  receipt.payload_hash = await sha256Hex(new TextEncoder().encode(m.json));
  const valid = [];
  for (const table of ["answers", "saved"]) {
    const rows = doc[table] === undefined ? {} : doc[table];
    if (!record(rows)) return fail("Each answers/saved section must be a named-answer map. Your existing answers were kept.");
    for (const [key, row] of Object.entries(rows)) {
      const item = { table, key, factId: typeof row?.factId === "string" ? row.factId : "" };
      const deniedSource = (v) => typeof v === "string" && /^(?:agent|assistant|model|llm|generated|agent-generated|assistant-generated|model-generated|ai-generated|quarantined|rejected)$/.test(v.trim().toLowerCase().replace(/[ _]+/g, "-"));
      const denied = record(row) && ([row, row.provenance].some((v) => record(v) && (v.quarantined === true || v.unproven === true || v.rejected === true || deniedSource(v.source) || deniedSource(v.origin))) || typeof row.provenance === "string" && /\b(?:agent|assistant|llm|generated|inferred|quarantined|unproven|rejected|unknown source)\b/i.test(row.provenance));
      let reason = !record(row) || typeof row.value !== "string" || !row.value.trim() ? "Answer text is missing or has an unsupported type"
        : ["__proto__", "constructor", "prototype"].includes(key) || !item.factId.trim() || item.factId.length > 200 ? "Invalid answer key or fact reference"
        : row.user_id && row.user_id !== a.user_id ? "This answer belongs to another account"
        : C.quarantinedFact(row) || denied ? "This answer is quarantined or explicitly untrusted"
        : /^(text-answer:|approved-local-resume:|essay-draft:)/.test(item.factId) ? "This fact reference is reserved for another source" : "";
      if (reason) { receipt.rejected.push({ ...item, reason }); continue; }
      item.value_hash = await sha256Hex(new TextEncoder().encode(row.value));
      valid.push({ item, row });
      receipt.needs_review.push({ ...item, reason: "Review and confirm this exact answer" });
    }
  }
  if (!valid.length) return fail("No valid answer is ready for review. Your existing imported answers were kept.");
  const pending = await get(S, "fact_import_reviews", {}), now = Date.now();
  for (const [token, review] of Object.entries(pending)) if (review.expires_at < now) delete pending[token];
  if (m.phase === undefined || m.phase === "preview") {
    const token = crypto.randomUUID();
    pending[token] = { actor_id: a.user_id, payload_hash: receipt.payload_hash, rows: receipt.needs_review.map(({ reason, ...row }) => row), expires_at: now + 300000 };
    while (Object.keys(pending).length > 20) delete pending[Object.keys(pending)[0]];
    await put(S, "fact_import_reviews", pending);
    return { ok: true, kept: 0, excluded: receipt.rejected.length, receipt: { ...receipt, review_token: token } };
  }
  if (m.phase !== "confirm" || m.actor_id !== a.user_id || m.payload_hash !== receipt.payload_hash || !record(m.row)) return fail("The reviewed actor or payload changed. Review the answer again.");
  const sameRow = (r) => r.table === m.row.table && r.key === m.row.key && r.factId === m.row.factId && r.value_hash === m.row.value_hash;
  const priorReceipts = await get(S, "fact_import_receipts", []);
  const replay = priorReceipts.find((r) => r.actor_id === a.user_id && r.review_token === m.review_token && r.payload_hash === receipt.payload_hash && r.accepted?.some(sameRow));
  const previous = await get(S, "imported_file", null);
  if (replay) {
    const r = replay.accepted.find(sameRow), live = previous?.user_id === a.user_id ? previous[r.table]?.[r.key] : null;
    if (live?.confirmation_event_id === r.confirmation_event_id && await sha256Hex(new TextEncoder().encode(live.value)) === r.value_hash) return { ok: true, kept: 1, excluded: replay.rejected.length, receipt: replay, replayed: true };
    return fail("That imported answer has since changed. Review its current value again.");
  }
  const review = pending[m.review_token];
  if (!review || review.actor_id !== a.user_id || review.payload_hash !== receipt.payload_hash || review.expires_at < now || !review.rows.some(sameRow)) return fail("The exact-row review expired or changed. Review the answer again.");
  const chosen = valid.find((v) => sameRow(v.item));
  if (!chosen) return fail("That answer is not eligible for confirmation.");
  const id = "panel-import:" + crypto.randomUUID(), at = new Date(now).toISOString();
  const provenance = "owner confirmed this answer in the extension panel";
  if (previous?.user_id === a.user_id && (!record(previous.answers || {}) || !record(previous.saved || {}))) return fail("Your existing session facts have an unsupported shape. They were kept unchanged.");
  const file = previous?.user_id === a.user_id ? JSON.parse(JSON.stringify(previous)) : { user_id: a.user_id, answers: {}, saved: {} };
  file[chosen.item.table] ||= {};
  file[chosen.item.table][chosen.item.key] = { ...chosen.row, confirmed: true, user_id: a.user_id, provenance, confirmation_event_id: id, authorizes: false };
  const mf = C.trustedManifest({ owner: a.user_id, file, rows: [], resume: null });
  if (!mf[chosen.item.table][chosen.item.key] || mf[chosen.item.table][chosen.item.key].factId !== chosen.item.factId) {
    receipt.rejected.push({ ...chosen.item, reason: mf.excluded.find((r) => r.key === chosen.item.key)?.why || "The trusted fact manifest excluded this answer" });
    receipt.needs_review = receipt.needs_review.filter((r) => !sameRow(r));
    return fail("That answer could not enter your trusted session facts. Existing answers were kept.");
  }
  const active = await session();
  if (!active || active.user_id !== a.user_id) return fail("Your signed-in account changed. Nothing was imported.");
  receipt.id = id;
  receipt.review_token = m.review_token;
  receipt.at = at;
  receipt.accepted = [{ ...chosen.item, actor_id: a.user_id, confirmation_event_id: id, provenance, original_provenance: chosen.row.provenance ?? null, at }];
  receipt.needs_review = receipt.needs_review.filter((r) => !sameRow(r));
  delete pending[m.review_token];
  await S.set({ imported_file: file, fact_import_receipts: [...priorReceipts, receipt].slice(-100), fact_import_reviews: pending });
  return { ok: true, kept: 1, excluded: receipt.rejected.length, receipt };
}

// ------------------------------------------------------------------------------------------------ cards, queue, evidence
const cards = async () => await get(S, "cards", {});
// Every change to the cards goes through one queue: two handlers reading and writing the whole map at once would lose
// one change (a "stopped" overwritten by an older "ready"). The last 60 changes are kept as a trail for diagnosis.
let cardQueue = Promise.resolve();
function withCards(tabId, by, change) {
  const run = cardQueue.then(async () => {
    const all = await cards();
    const next = change(all[tabId] || null);
    if (!next) return all[tabId] || null; // nothing to change
    all[tabId] = next;
    const trail = await get(S, "card_trail", []);
    await S.set({ cards: all, card_trail: [...trail, { at: Date.now(), tabId, by, status: all[tabId].status }].slice(-60) });
    return all[tabId];
  });
  cardQueue = run.catch(() => {});
  return run;
}
// A "stopped" never lands on a card whose application already went (status done) or is past its record (begun), unless
// it is the content script's own stop before the click: "nothing was sent" is said only when that is true (WO-031 review).
const setCard = (tabId, patch, by = patch.status || "patch") =>
  withCards(tabId, by, (prev) => {
    if (patch.status === "stopped" && prev && !patch.beforeClick && (prev.status === "done" || prev.begun)) return null;
    // A late "submitting" never undoes a finished card: the page after the click may be read before the click's message.
    if (patch.status === "submitting" && prev?.status === "done") return null;
    return { ...(prev || {}), ...patch, tabId, updated_at: Date.now() };
  });
const pendings = async () => await get(S, "pending", {});
let pendingQueue = Promise.resolve();
function setPending(tabId, v) {
  const run = pendingQueue.then(async () => {
    const all = await pendings();
    if (v === null) delete all[tabId];
    else all[tabId] = v;
    await put(S, "pending", all);
  });
  pendingQueue = run.catch(() => {});
  return run;
}

// WO-048: one flag per tab, "the next Workday step may fill itself": set by an approved Save and Continue or by the
// sign-in card, taken once by the next page.
let nextQueue = Promise.resolve();
function setWorkdayNext(tabId, on) {
  const run = nextQueue.then(async () => {
    const all = await get(S, "workday_next", {});
    if (on) all[tabId] = { at: Date.now() };
    else delete all[tabId];
    await put(S, "workday_next", all);
  });
  nextQueue = run.catch(() => {});
  return run;
}
// WO-049: the written answers drafted on each tab's card, by posting and field: { [tabId]: { jobId, items: { [name]: item } } }.
// An item is drafting, drafted (shown whole, not on the form), used (on the form by the person's own "Use this"),
// refused (the employer's AI policy) or failed (thin facts, not verified, too long, the service, the daily limit).
// Only the panel asks for a draft (essay-draft), only on the person's tap; nothing drafts on its own.
const draftsAll = async () => await get(S, "essay_drafts", {});
let draftQueue = Promise.resolve();
function setDraft(tabId, jobId, name, item) {
  const run = draftQueue.then(async () => {
    const all = await draftsAll();
    const mine = all[tabId] && all[tabId].jobId === jobId ? all[tabId] : { jobId, items: {} };
    mine.items[name] = { ...item, updated_at: Date.now() };
    all[tabId] = mine;
    await put(S, "essay_drafts", all);
    return mine.items[name];
  });
  draftQueue = run.catch(() => {});
  return run;
}
async function draftsFor(tabId, jobId) {
  const d = (await draftsAll())[tabId];
  return d && jobId && d.jobId === jobId ? d.items : {};
}
const oneLine = (s, dflt) => String(s || dflt).replace(/\s+/g, " ").trim().slice(0, 600);
// The question as the employer's form asks it, the posting, and the form's other labels (for its AI policy). Never a fact:
// the function reads the person's confirmed facts from their account itself.
async function requestDraft(card, q, previous) {
  const a = await session();
  if (!a) return { ok: false, why: "signed_out", message: say.signedOut };
  const cfg = await config();
  const body = {
    posting: card.jobId, company: card.company, label: q.label, type: q.type,
    siblings: (card.formLabels || []).filter((l) => l !== q.label).slice(0, 200), limit: { chars: q.chars ?? null }, previous: previous || null,
  };
  try {
    const r = await fetch(cfg.supabaseUrl + "/functions/v1/career-essay-draft", {
      method: "POST", headers: { apikey: cfg.anonKey, authorization: "Bearer " + a.access_token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (r.status === 401) return { ok: false, why: "signed_out", message: say.signedOut };
    return j && typeof j === "object" ? j : { ok: false, why: "model", message: "" };
  } catch {
    return { ok: false, why: "model", message: "" };
  }
}
const NO_DRAFT = "Trainee couldn't draft this right now, so nothing changed and the question is still open. Try again in a few minutes.";

// 50-in-30: the proof list is read and written whole after every application. With both pictures inline it grows by
// about 0.1-1 MB per application (measured on the TEST world: +8.5 ms per earlier proof), so only the newest INLINE_SHOTS
// proofs keep their pictures inline; older ones keep them under "shot:<id>" (read back by "proof"). One write at a time.
const INLINE_SHOTS = 10;
function keepEvidence(rec) {
  return withLists(async () => {
    const list = await get(L, "evidence", []);
    list.unshift(rec);
    const kept = list.slice(0, 300), moved = {};
    for (const e of kept.slice(INLINE_SHOTS)) {
      if (!e.screenshot && !e.screenshot_after) continue;
      moved["shot:" + e.id] = { screenshot: e.screenshot || null, screenshot_after: e.screenshot_after || null };
      delete e.screenshot;
      delete e.screenshot_after;
      e.shots = true;
    }
    if (Object.keys(moved).length) await L.set(moved);
    await put(L, "evidence", kept);
    const gone = list.slice(300).filter((e) => e.shots).map((e) => "shot:" + e.id);
    if (gone.length) await L.remove(gone);
  });
}

async function queueState() {
  return await get(S, "queue", { items: [], index: -1, tabId: null, running: false });
}
// 50-in-30: the agent may send on more than one tab ("lanes"), each the only tab of its own window, so each is "in front"
// (active) for its own picture. One lane unless config.js agentTabs says more (at most SEND_LANES_MAX): windows hidden or
// minimized on a real desktop are untested (docs/apply/FIFTY-IN-THIRTY.md). Every change to the queue goes through one
// lock. Two lanes never hold postings of one company at once (one application per company in 30 days). What stays one
// at a time: the pictures, the start of each application (the database takes the person's lock), the batch tap.
const SEND_LANES_MAX = 3, QUEUE_GAP_MS = 150;
const sendLanes = async () => {
  const c = await config();
  return c.agentSubmits ? Math.max(1, Math.min(SEND_LANES_MAX, Math.floor(Number(c.agentTabs)) || 1)) : 1;
};
function serial() {
  let last = Promise.resolve();
  return (f) => {
    const run = last.then(f);
    last = run.catch(() => {});
    return run;
  };
}
const withQueue = serial(), withLists = serial();
const lanesOf = (q) => (Array.isArray(q.lanes) && q.lanes.length ? q.lanes : q.tabId !== null && q.tabId !== undefined ? [q.tabId] : []);
const inLane = (q, tabId) => lanesOf(q).includes(tabId);
// The employer's name as the account's company rule compares it (career_apply_company_key).
const companyKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, " ").replace(/\s+/g, " ").trim();
const companyOf = (url) => companyKey(C.tenantOf(C.postingKey(url) || url) || url);
async function openNext(q, tabId = q.tabId) {
  const busy = new Set(q.items.filter((x) => x.state === "open").map((x) => companyOf(x.url)));
  const i = q.items.findIndex((x) => x.state === "waiting" && !busy.has(companyOf(x.url)));
  if (i < 0) {
    if (!q.items.some((x) => x.state === "waiting" || x.state === "open")) q.running = false;
    else if (q.items.some((x) => x.state === "waiting")) {
      setTimeout(() => withQueue(async () => {
        const q2 = await queueState();
        if (q2.running && inLane(q2, tabId) && !q2.items.some((x) => x.state === "open" && x.lane === tabId)) await openNext(q2, tabId);
      }), 500);
    }
    await put(S, "queue", q);
    return;
  }
  q.index = i;
  q.items[i].state = "open";
  q.items[i].opened_at = Date.now();
  q.items[i].lane = tabId;
  await put(S, "queue", q);
  if (tabId !== null && tabId !== undefined) {
    try {
      await chrome.tabs.update(tabId, { url: q.items[i].url, active: true });
      return;
    } catch { /* the tab was closed */ }
  }
  // The lane's tab was closed (or there was none): one lane opens a tab, as before; a lane among several, its own window.
  const t = lanesOf(q).length > 1 ? (await chrome.windows.create({ url: q.items[i].url, focused: false, width: 1280, height: 900 })).tabs[0]
    : await chrome.tabs.create({ url: q.items[i].url, active: true });
  q.lanes = lanesOf(q).filter((x) => x !== tabId).concat(t.id);
  if (q.tabId === tabId || q.tabId === null) q.tabId = t.id;
  q.items[i].lane = t.id;
  await put(S, "queue", q);
}
async function queueAfter(tabId, state, ms, proofId) {
  const moved = await withQueue(async () => {
    const q = await queueState();
    if (!q.running || !inLane(q, tabId)) return false;
    const it = q.items.find((x) => x.state === "open" && (x.lane ?? q.tabId) === tabId);
    if (!it) return false;
    it.state = state;
    if (ms !== null) it.ms = ms;
    if (proofId) it.proof_id = proofId;
    await put(S, "queue", q);
    return true;
  });
  if (moved) {
    setTimeout(() => withQueue(async () => {
      const q2 = await queueState();
      if (q2.running && inLane(q2, tabId)) await openNext(q2, tabId);
    }), QUEUE_GAP_MS);
  }
}

// ------------------------------------------------------------------------------------------------ the submit
// One finish per application, whoever reports first (the content script in place, or the page load after a navigating
// submit): the row id is taken before any await, so a second report returns at once (WO-031 review).
const finishing = new Set();
async function finish(tabId, observation, extra = {}) {
  const p = (await pendings())[tabId];
  if (!p || p.finished || finishing.has(p.id)) return null;
  finishing.add(p.id);
  p.finished = true;
  await setPending(tabId, p);
  const done = Date.now();
  const outcome = observation
    ? C.outcomeAfterClick(observation, extra.errorsBefore || p.errors_before || [], !!extra.timedOut)
    : { state: "not_submitted", reason: extra.reason || C.BEFORE_CLICK, confirmation_id: null };
  const shotAfter = observation && extra.shotAfter?.sha256 ? extra.shotAfter : null;
  const evidence = await C.evidenceRecord({
    payload: p.payload, hash: p.hash, outcome, pageText: observation?.page_text || "", urlAfter: observation?.url_after || p.url_before,
    screenshotSha256: p.screenshot_sha256, screenshotAfterSha256: shotAfter?.sha256 ?? null,
    times: { card: p.card_shown_at, approved: p.approved_at, clicked: p.clicked_at || done, done }, drafts: p.drafts || {},
  });
  // WO-049 (D-024): a drafted answer is shown in the proof as drafted by Trainee from the person's facts (their ids), and
  // used as drafted or edited by them.
  const provenance = C.draftProvenance(p.payload.fields, p.drafts || {});
  let recorded = false;
  for (let i = 0; i < 3 && !recorded; i++) {
    try {
      await rpc("career_apply_finish_own", { p_id: p.id, p_lease: p.lease, p_state: outcome.state, p_evidence: evidence });
      recorded = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  // The proof stays on this computer: the answers as approved, both pictures, the employer's words, the times.
  const proved = outcome.state === "confirmed" && !!shotAfter;
  await keepEvidence({
    ...evidence, id: p.id, state: outcome.state, proved, job_id: p.payload.job_id, company: p.payload.company, url: p.payload.url,
    approved_answers: p.payload.fields.map((f) => (provenance[f.name] ? { ...f, provenance: provenance[f.name].said, fact_ids: provenance[f.name].fact_ids, edited: provenance[f.name].edited } : f)),
    screenshot: p.screenshot || null, screenshot_after: shotAfter?.dataUrl || null, recorded,
  });
  // Ask once, from the form: the person's own answers on the card they approved are kept for later forms, only once the
  // application went (never for a stop before the click). A failure here never touches the application's outcome.
  if (observation && p.form_answers) {
    try {
      await rpc("career_apply_questions_answer_from_form_own", { p_job_id: p.form_answers.posting, p_answers: p.form_answers.answers });
    } catch { /* kept for the next text instead: the question stays open */ }
  }
  const stats = await get(L, "timing", []);
  if (proved) await put(L, "timing", [...stats, evidence.ms_card_to_done].slice(-500));
  await setPending(tabId, null);
  // A stop before the click leaves the posting open for another try; anything after the click moves the queue on. The queue
  // is final before the card says done, so the panel never shows a done card beside an open queue item.
  if (observation) await queueAfter(tabId, proved ? "confirmed" : outcome.state, evidence.ms_card_to_done, p.id);
  else if (p.agent) await queueAfter(tabId, "needs_you", null);
  if (p.agent) {
    const reason = observation ? outcome.reason : oneLine(extra.message, C.BEFORE_CLICK).replace(/\s*Nothing was sent\.?$/, "");
    await agentReceipt({ company: p.payload.company, url: p.payload.url, state: outcome.state, confirmation_id: outcome.confirmation_id, reason, proved, proofId: p.id });
  }
  const view = observation ? C.cardOutcome(outcome, !!shotAfter, extra.codeStop || null) : { status: "stopped", message: extra.message || "Stopped before the click. Nothing was sent." };
  return await withCards(tabId, "finish:" + outcome.state, (prev) => ({
    ...(prev || {}), tabId, updated_at: Date.now(), status: view.status, message: view.message, result: outcome.state, proved,
    ms: evidence.ms_card_to_done, recorded, proof_id: p.id, approved: false,
    // WO-042: the step marks of the click, for the 60-in-30 benchmark's timing.
    times: { ...evidence.times, ...(p.steps ? { steps: p.steps } : {}) },
  }));
}

// The page after a navigating submit (Lever's thank-you): read and photographed from the tab while it is in front, identity
// fields covered while the picture is taken.
async function readAfterNavigation(tabId, p) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/trainee-core.js"] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, args: [p.url_before, p.planned_names],
    func: (before, names) => {
      const T = globalThis.TraineeCore, D = T.dom, f = D.readForm();
      const sel = f.schema.filter((s) => T.isIdentityField(s) || T.looksLikeIdNumber(D.readValue(f.bindings[s.name]))).map((s) => f.bindings[s.name].selector);
      globalThis.__traineeUnmask = D.maskFields(sel);
      return D.observe(before, names);
    },
  });
  let shotAfter = null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.active) shotAfter = await capture(tab.windowId);
  await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__traineeUnmask?.() }).catch(() => {});
  return { observation: res?.result || null, shotAfter };
}
// 50-in-30: one picture at a time, at least SHOT_SPACING_MS apart. Chrome refuses more than two captures a second
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND), and with several lanes a refused picture would stop a ready application.
const SHOT_SPACING_MS = 520;
let shotChain = Promise.resolve(), lastShot = 0;
function capture(windowId) {
  const run = shotChain.then(async () => {
    const wait = lastShot + SHOT_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastShot = Date.now();
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      return { sha256: await sha256Hex(b64ToBytes(url.split(",")[1])), dataUrl: url };
    } catch {
      return null;
    }
  });
  shotChain = run.catch(() => {});
  return run;
}

// A submit that moved the page away: the new page is read once it loads (the content script there may not run, e.g. a
// thank-you page on the employer's own site). Also called from "clicked": a fast page can finish loading before that
// message lands, and then this load event has already passed the tab by.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") afterNavigation(tabId);
});
// One reader per click: two at once would take two pictures, and Chrome refuses a second capture within the second.
const reading = new Set();
async function afterNavigation(tabId) {
  let p = (await pendings())[tabId];
  // Person-submits mode: the page moved while Trainee waited for the person's press. Their own press reports itself
  // ("clicked") as it happens; give that report a moment, and if it never came, the person left without pressing:
  // nothing was sent, and the started application is closed as stopped before the click.
  if (p && !p.finished && !p.clicked_at && p.awaiting_person) {
    await new Promise((r) => setTimeout(r, PERSON_REPORT_GRACE_MS));
    p = (await pendings())[tabId];
    if (p && !p.finished && !p.clicked_at) return void await finish(tabId, null, { reason: C.BEFORE_CLICK, message: say.leftWithoutPress });
  }
  if (!p || p.finished || !p.clicked_at || reading.has(p.id)) return;
  reading.add(p.id);
  try {
    await readAndFinish(tabId, p);
  } finally {
    reading.delete(p.id);
  }
}
async function readAndFinish(tabId, p) {
  await new Promise((r) => setTimeout(r, 600));
  try {
    const { observation, shotAfter } = await readAfterNavigation(tabId, p);
    // WO-096: the submit moved to a page asking for the code the employer emailed. Once per application, the code is read
    // from the person's own Gmail and filled there (never pressed, D-029); the page is read again when the person's
    // Submit loads the next page, or in two minutes.
    if (observation?.email_code_prompt && !observation.captcha && !p.code_tried) {
      const r = await typeEmailCode(tabId, 0, p);
      if (r.typed) {
        setTimeout(() => afterNavigation(tabId), 120_000);
        return;
      }
      await finish(tabId, observation, { shotAfter, codeStop: r.stop });
      return;
    }
    if (observation) await finish(tabId, observation, { shotAfter, codeStop: p.code_stop || null });
  } catch {
    // The page after the click could not be read: unknown, counted as applied, never resent.
    await finish(tabId, { url_before: p.url_before, url_after: "", form_present_after: true, required_empty_after: 0, validation_errors: [], captcha: false, email_code_prompt: false, page_text: "" }, { timedOut: true });
  }
}

// ------------------------------------------------------------------------------------------------ the emailed code (WO-096)
// After the approved click, the employer's page asks for a code it emailed the person. Once per application: the
// career-email-code function reads it from the person's own Gmail (gmail.readonly, their Google consent) for this
// application's queue row, which must be theirs, being sent now, under this lease; the wait is the shared one (about
// three minutes, TraineeCore.pollForCode). The code goes from that answer straight into the page's code box in the frame
// that asked (TraineeCore.dom.typeCode) and is not kept: not in the pending record, the card, the proof or a log.
const TYPE_IT = "Type the code the employer emailed you on the page yourself.";
async function typeEmailCode(tabId, frameId, p) {
  if (!p || !p.clicked_at || p.finished || p.code_tried) return { typed: false, stop: TYPE_IT };
  p.code_tried = true;
  await setPending(tabId, p);
  const a = await session();
  if (!a) return { typed: false, stop: say.signedOut };
  const cfg = await config();
  const ats = C.detectPortal(p.payload?.url || "")?.family;
  let code = null, stop = TYPE_IT;
  const got = await C.pollForCode(async () => {
    try {
      const r = await fetch(cfg.supabaseUrl + "/functions/v1/career-email-code", {
        method: "POST",
        headers: { apikey: cfg.anonKey, authorization: "Bearer " + a.access_token, "content-type": "application/json" },
        body: JSON.stringify({ apply_id: p.id, lease: p.lease, since_ms: p.clicked_at, ...(["greenhouse", "lever", "ashby", "workday"].includes(ats) ? { ats } : {}) }),
      });
      if (r.status === 401 || r.status === 403) return { status: "refused" };
      const j = await r.json().catch(() => null);
      return j && typeof j.status === "string" ? j : { status: "not_yet" };
    } catch {
      return { status: "not_yet" };
    }
  }, { now: Date.now });
  if (got.status === "found" && typeof got.code === "string" && got.code) code = got.code;
  else if (got.stop) stop = got.stop;
  got.code = null;
  if (!code) {
    p.code_stop = stop;
    await setPending(tabId, p);
    return { typed: false, stop };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId || 0] }, files: ["lib/trainee-core.js"] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] }, args: [code],
      func: (c) => globalThis.TraineeCore.dom.typeCode(c),
    });
    code = null;
    if (res?.result === true) {
      // D-029 rule 5: filled, never pressed. The person presses Submit; the card says so until the employer answers.
      const name = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday" }[ats] || "the employer";
      p.code_stop = `Filled the code ${name} emailed you. Press Submit to finish.`;
      await setPending(tabId, p);
      await setCard(tabId, { status: "submitting", message: p.code_stop });
      return { typed: true, stop: p.code_stop };
    }
  } catch { /* the page went away: the person types it */ }
  code = null;
  p.code_stop = "The page's code box could not be found. " + TYPE_IT;
  await setPending(tabId, p);
  return { typed: false, stop: p.code_stop };
}

// ------------------------------------------------------------------------------------------------ answer once (WO-054)
// "Prepare": the next queued postings are read in hidden tabs (content.js survey(): read only, nothing filled, clicked or
// sent; each tab closed after) and the questions only the person can answer are gathered once for the panel
// (TraineeCore.answerOnceQuestions). At most PREPARE_MAX postings, PREPARE_AT_ONCE at a time: each is a whole employer page held in a
// hidden tab, and an answer given now should be about postings this session reaches. Workday postings are left out: the
// person signs in on the employer's site first (D-013), so their questions are asked on their own cards.
// 50-in-30: up to 100 postings (the queue's and the batch approval's own limit), eight hidden tabs at a time. A posting
// read in the last SURVEY_FRESH_MS is planned again here from the form as it was read (after the person answered the
// panel's questions) instead of loading the employer's page a second time; the send still checks the live page against
// the approval (TraineeCore.batchMatch), so a form changed since is caught there, as before.
const PREPARE_MAX = 100, PREPARE_AT_ONCE = 8, SURVEY_WAIT_MS = 45_000, SURVEY_FRESH_MS = 10 * 60_000;
const surveyCache = new Map(); // posting url -> { at, r } (memory only: a restarted worker reads the page again)
function planSurveyed(r, f, resume) {
  const rs = resume ? { filename: resume.name, sha256: resume.sha256 } : null;
  const plan = C.planForm({ userId: f.userId, jobId: r.jobId, company: r.company, family: r.family, schema: r.schema, answers: f.answers, saved: f.saved, now: Date.now(), location: r.location });
  const cf = C.contractFill({ schema: r.schema, plan, manifest: f.manifest, listed: r.listed, resume: rs });
  const asked = new Set(plan.needs.map((n) => n.label));
  const p = { ...plan, fill: cf.fill, needs: [...plan.needs, ...cf.asks.filter((q) => !asked.has(q.label)).map((q) => ({ label: q.label, type: q.type, options: q.options }))] };
  const batch = C.batchPlan({ jobId: r.jobId, company: r.company, url: r.pageUrl, family: r.family, schema: r.schema, plan: p, challenge: false, resume: rs, listed: r.listed, manifest: f.manifest });
  return { ...r, needs: p.needs.slice(0, 200), batch };
}
const surveys = new Map(); // tabId -> resolve, while a hidden tab is being read
let preparing = false;
// A hidden tab sent to its posting while its own blank page was still loading was left "unloaded" by Chrome for Testing
// 156 (the gate's browser), never navigated, so Prepare reported "did not load in time" for 1 or 2 of 3 postings in about
// 2 runs of 5 (2026-10-20). The blank page is let finish first.
function blankLoaded(id, ms) {
  return new Promise((resolve) => {
    const on = (tabId, change) => tabId === id && change.status === "complete" && done();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(on);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(id).then((t) => t.status === "complete" && done(), done);
  });
}
async function surveyOne(url) {
  // Opened blank, then sent to the posting, so its tab is known before its content script asks what it is for.
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  let timer = null;
  const got = new Promise((r) => surveys.set(tab.id, r));
  const late = new Promise((r) => (timer = setTimeout(() => r({ ok: false, why: "the page did not load in time" }), SURVEY_WAIT_MS)));
  try {
    await blankLoaded(tab.id, 10_000);
    await chrome.tabs.update(tab.id, { url });
    return { ...(await Promise.race([got, late])), url };
  } catch {
    return { ok: false, why: "the page could not be opened", url };
  } finally {
    clearTimeout(timer);
    surveys.delete(tab.id);
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}
async function prepareQueue() {
  const a = await session();
  if (!a) return { ok: false, message: say.signedOut };
  const waiting = (await queueState()).items.filter((x) => x.state === "waiting");
  const workday = waiting.filter((x) => C.detectPortal(x.url)?.family === "workday").length;
  const pick = waiting.filter((x) => C.detectPortal(x.url)?.family !== "workday").slice(0, PREPARE_MAX);
  const notes = [];
  if (workday) notes.push(`${workday} Workday posting${workday === 1 ? " is" : "s are"} left out: Workday needs you signed in on the employer's site, so ${workday === 1 ? "its questions are" : "their questions are"} asked on the card.`);
  const more = waiting.length - workday - pick.length;
  if (more > 0) notes.push(`Only the next ${PREPARE_MAX} postings are read ahead (${more} more wait): each is a whole page held open in a hidden tab. Press Prepare again after them.`);
  if (!pick.length) return { ok: false, message: notes[0] || "Add some posting links first." };
  const base = { status: "reading", total: pick.length, read: 0, notes, failed: [], questions: [], left: {}, open: 0, skipped: [], saved: [], refused: [] };
  await put(S, "answer_once", base);
  const results = new Array(pick.length);
  let next = 0, read = 0;
  const f0 = await facts(a.user_id), resume0 = await get(L, "resume", null);
  const worker = async () => {
    while (next < pick.length) {
      const i = next++;
      const c = surveyCache.get(pick[i].url);
      try {
        if (c && Date.now() - c.at < SURVEY_FRESH_MS && c.r.userId === a.user_id) results[i] = { ...planSurveyed(c.r, f0, resume0), url: pick[i].url, replanned: true };
      } catch { /* read the page again */ }
      if (!results[i]) {
        results[i] = await surveyOne(pick[i].url);
        if (results[i].ok && Array.isArray(results[i].schema) && results[i].pageUrl) surveyCache.set(pick[i].url, { at: Date.now(), r: { ...results[i], userId: a.user_id } });
      }
      read++;
      if (!results[i].replanned || read === pick.length || read % 10 === 0) await put(S, "answer_once", { ...base, read });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREPARE_AT_ONCE, pick.length) }, worker));
  const ok = results.filter((r) => r.ok && Array.isArray(r.needs));
  const f = await facts(a.user_id);
  const merged = C.answerOnceQuestions({ postings: ok.map((r) => ({ jobId: String(r.jobId), company: String(r.company), url: r.url, location: typeof r.location === "string" ? r.location.slice(0, 300) : undefined, needs: r.needs })),
    answers: f.answers, answered: new Set(f.answered) });
  const left = {};
  for (const x of merged.left) left[x.why] = (left[x.why] || 0) + 1;
  await put(S, "answer_once", { ...base, status: "ready", read, postings: ok.length, questions: merged.questions, left, open: ok.reduce((n, r) => n + r.needs.length, 0),
    failed: results.filter((r) => !r.ok).map((r) => ({ url: r.url, why: String(r.why || "not read") })) });
  if ((await config()).agentSubmits) await put(S, "agent_batch", await agentBatch(results));
  return { ok: true, questions: merged.questions.length };
}
// The person's own answers from the panel, stored the way an answer given on a form is (WO-042): the question is recorded
// for the posting that asked it, then answered under its key. The planner reads each back through `saved` (or as a fact)
// when the queue reaches each posting, and puts it only on an option that posting itself offers.
async function saveAnswerOnce(picks) {
  const st = await get(S, "answer_once", null);
  if (!st || st.status !== "ready") return { ok: false, message: "Press Prepare first." };
  const live = st.questions.filter((q) => !st.skipped.includes(q.key) && !st.saved.includes(q.key));
  const r = C.answerOnceRows({ questions: live, picks: Array.isArray(picks) ? picks : [] });
  const saved = [];
  let failed = false;
  for (const g of r.groups) {
    try {
      for (let i = 0; i < g.answers.length; i += 60) {
        await rpc("career_apply_questions_put_own", { p_job_id: g.posting, p_questions: g.questions.slice(i, i + 60) });
        await rpc("career_apply_questions_answer_from_form_own", { p_job_id: g.posting, p_answers: g.answers.slice(i, i + 60) });
      }
      saved.push(...g.answers.map((x) => x.key));
    } catch (e) {
      if (e.message === "SIGNED_OUT") return { ok: false, message: say.signedOut };
      failed = true;
    }
  }
  await put(S, "answered_before", [...new Set([...(await get(S, "answered_before", [])), ...saved])]);
  await put(S, "answer_once", { ...st, saved: [...st.saved, ...saved], refused: r.refused });
  return { ok: !failed, saved: saved.length, refused: r.refused, message: failed ? "Some answers could not be saved; those questions stay for their cards." : "" };
}

// ------------------------------------------------------------------------------------------------ the agent sends (WO-101)
// With agentSubmits on (config.js; the owner's call) the person approves a batch up front, of the exact answers per
// posting, read ahead by Prepare (content.js survey() -> TraineeCore.batchPlan). When the queue reaches an approved
// posting, the card the page builds is checked against that approval (TraineeCore.batchMatch): only an exact match is
// approved, by code, and then the one-tap send path runs unchanged (the unchanged-form check next to the click, the
// picture, the recorded start, the site's own Submit). The start is the owner-switched agent start
// (career_apply_extension_begin_agent_own: CAREER_AGENT_SUBMIT must be 'on', the approval live and unused). A posting
// that differs waits for the person and the queue goes on; a receipt line after each; "Stop applying" ends it all.
const AGENT_SETTLE_MS = 2500; // a card that differs gets this long to settle (a late widget, a file still hashing)
const agentWait = new Map(); // tabId -> timer
const agentApproved = async () => await get(S, "agent_approved", {});
async function agentBatch(results) {
  const ready = [], out = [], companies = new Set();
  for (const r of results) {
    const b = r.batch;
    if (r.ok && b?.ok && b.posting && Array.isArray(b.posting.answers)) {
      // The account allows one application per company in 30 days and refuses a second at its start, after its fill: a
      // second posting at a company already in this batch is left out of it, with why.
      const co = companyKey(b.posting.company);
      if (co && companies.has(co)) {
        out.push({ url: r.url, company: String(b.posting.company), why: [`An earlier posting in this batch is at ${b.posting.company}, and your account allows one application per company in 30 days.`] });
        continue;
      }
      companies.add(co);
      ready.push({ url: r.url, company: String(b.posting.company), jobId: String(b.posting.jobId), posting: b.posting, hash: await C.batchHash(b.posting) });
    } else {
      out.push({ url: r.url, company: String(r.company || ""), why: r.ok ? (Array.isArray(b?.why) ? b.why.slice(0, 20).map(String) : ["not read"]) : [String(r.why || "not read")] });
    }
  }
  return { status: "ready", at: Date.now(), ready, out, approved: [] };
}
function agentReceipt(o) {
  return withLists(async () => {
    const list = await get(L, "agent_receipts", []);
    list.unshift({ at: Date.now(), company: o.company, url: o.url, state: o.state, proof_id: o.proofId || null, line: C.agentReceiptLine(o) });
    await put(L, "agent_receipts", list.slice(0, 300));
  });
}
async function agentConsider(tabId, card) {
  if (!(await config()).agentSubmits || !card.batch) return;
  const q = await queueState();
  if (!q.running || !inLane(q, tabId)) return;
  const a = (await agentApproved())[card.jobId];
  if (!a) return;
  const r = C.batchMatch({ approved: a.posting, now: card.batch, card: card.payload?.fields || [], openRequired: card.openRequired || [], blockers: card.blockers || [] });
  if (!r.ok) {
    await withCards(tabId, "agent-differs", (prev) => (prev && prev.hash === card.hash ? { ...prev, agent_diffs: r.diffs.slice(0, 20) } : null));
    if (!agentWait.has(tabId)) agentWait.set(tabId, setTimeout(() => agentGiveUp(tabId, card.jobId).catch(() => {}), AGENT_SETTLE_MS));
    return;
  }
  clearTimeout(agentWait.get(tabId));
  agentWait.delete(tabId);
  // WO-102 rehearsal: the same fill and the same exact-match check as a send, then a report and the next posting.
  // Nothing is started or clicked: no "submit" message exists on this path, and "begin" refuses while rehearsing.
  if ((await get(S, "agent_mode", "send")) === "rehearse") {
    await agentRehearsal(card, a, r, true);
    await setCard(tabId, { status: "rehearsed", message: "Rehearsed: every answer on the page is exactly what you approved, each from a fact you gave. Nothing was sent." });
    await queueAfter(tabId, "rehearsed", null);
    return;
  }
  let taken = false;
  await withCards(tabId, "agent-approve", (prev) => {
    if (!prev || prev.hash !== card.hash || prev.status !== "ready" || prev.approved) return null;
    taken = true;
    return { ...prev, approved: true, approved_hash: card.hash, approved_at: Date.now(), approved_by: "agent", batch_hash: a.hash, agent_diffs: [],
      status: "submitting", message: say.agentSending, updated_at: Date.now() };
  });
  if (!taken) return;
  chrome.tabs.sendMessage(tabId, { type: "submit", hash: card.hash }).catch(async () => {
    if ((await pendings())[tabId]) return;
    await agentStopped(tabId, card, "The page could not be reached, so nothing was sent.");
  });
}
// The posting's card still differs after the settle: it waits for the person, with what differs, and the queue goes on.
async function agentGiveUp(tabId, jobId) {
  agentWait.delete(tabId);
  const card = (await cards())[tabId];
  if (!card || card.jobId !== jobId || card.approved || card.begun || !card.agent_diffs?.length) return;
  if ((await get(S, "agent_mode", "send")) === "rehearse") {
    const a = (await agentApproved())[jobId];
    if (a) await agentRehearsal(card, a, { ok: false, diffs: card.agent_diffs }, false);
    await setCard(tabId, { status: "needs_you", message: `Rehearsal: this page differs from what you approved. ${card.agent_diffs.slice(0, 5).join(" ")} Nothing was sent.` });
    await queueAfter(tabId, "needs_you", null);
    return;
  }
  await agentStopped(tabId, card, `${say.agentDiffers} ${card.agent_diffs.slice(0, 5).join(" ")}`);
}
// WO-102: what a rehearsal found for one posting: the approved ledger, the final form as read back (values and what the
// browser sends, file bytes included), and the contract's three numbers: supported answers, quarantined dependencies,
// unanswered required questions.
async function agentRehearsal(card, a, r, matched) {
  const ledger = a.posting.ledger || [];
  const names = new Set(ledger.map((l) => l.field_id));
  const readback = (card.payload?.fields || []).filter((f) => names.has(f.name)).map((f) => ({ name: f.name, label: f.label, value: f.value, source: f.source, factId: f.factId, detail: f.detail }));
  const supported = ledger.filter((l) => l.fact_refs.length && l.confirmation_event_id && l.derivation_rule).length;
  const rec = {
    at: Date.now(), company: card.company, url: card.url, jobId: card.jobId, batch_hash: a.hash, matched, diffs: (r.diffs || []).slice(0, 20),
    answers: a.posting.answers.length, supported_pct: a.posting.answers.length ? Math.round((100 * supported) / a.posting.answers.length) : 0,
    quarantined_dependencies: ledger.reduce((n, l) => n + l.fact_refs.filter((id) => C.quarantinedFact({ factId: id })).length, 0),
    unanswered_required: (card.openRequired || []).length, ledger, readback,
    manifest_hash: a.posting.manifest_hash, quarantine_version: a.posting.quarantine_version, question_set_hash: a.posting.question_set_hash,
  };
  const list = await get(L, "agent_rehearsals", []);
  list.unshift(rec);
  await put(L, "agent_rehearsals", list.slice(0, 200));
}
// An agent send that stopped before its start was recorded: the card says why, a receipt line, the queue goes on.
async function agentStopped(tabId, card, message) {
  await setCard(tabId, { status: "needs_you", message, approved: false, beforeClick: true });
  await agentReceipt({ company: card.company, url: card.url, state: "not_submitted", confirmation_id: null, proved: false, proof: false, reason: oneLine(message, "").replace(/^Not sent: /, "").replace(/\s*Nothing was sent\.?$/, "") });
  const q = await queueState();
  if (q.running && inLane(q, tabId)) await queueAfter(tabId, "needs_you", null);
}

// ------------------------------------------------------------------------------------------------ messages
async function handle(m, sender) {
  const tabId = sender.tab?.id ?? m.tabId;
  switch (m.type) {
    // ---- from the content script
    case "context": {
      const a = await session();
      const q = await queueState();
      const p = (await pendings())[tabId] || null;
      if (!a) return { signedIn: false, message: say.signedOut, queued: q.running && inLane(q, tabId) };
      let account = null;
      try {
        account = await rpc("career_apply_account_own", {});
      } catch (e) {
        if (e.message === "SIGNED_OUT") return { signedIn: false, message: say.signedOut };
      }
      const f = await facts(a.user_id);
      const resume = await get(L, "resume", null);
      return { signedIn: true, userId: a.user_id, ...f, resume, account, queued: q.running && inLane(q, tabId), pending: p && !p.finished ? p : null, personSubmits: !!(await config()).personSubmits,
        agentSubmits: !!(await config()).agentSubmits };
    }
    case "queued": {
      const q = await queueState();
      const p = (await pendings())[tabId];
      // WO-048: a Workday step saved with the person's approval (or a sign-in they did themselves) lets the next step
      // fill itself, once, within ten minutes.
      const next = (await get(S, "workday_next", {}))[tabId];
      if (next) await setWorkdayNext(tabId, false);
      return { queued: q.running && inLane(q, tabId), pending: !!(p && !p.finished), workdayNext: !!next && Date.now() - next.at < 600_000, survey: surveys.has(tabId) };
    }
    case "card": {
      // A new card replaces the old one whole: nothing approved or measured before carries over to it. A card being
      // submitted is never replaced by the page's own refresh.
      const card = await withCards(tabId, "card", (prev) =>
        prev && prev.status === "submitting" ? prev
          : { ...m.card, tabId, approved: false, status: m.card.status || (m.card.blockers?.length ? "blocked" : "ready"), updated_at: Date.now() });
      if (m.card?.signIn) await setWorkdayNext(tabId, true);
      if (card && !card.approved && ["ready", "blocked"].includes(card.status)) agentConsider(tabId, card).catch(() => {});
      return { ok: true, card };
    }
    case "draft": {
      // WO-048: Workday's Save and Continue sends one step to the employer as a draft. The content script may click it only
      // for the step the person approved, by its hash; the approved answers are kept on this computer as the proof.
      const card = (await cards())[tabId];
      if (!card || !card.approved || card.approved_hash !== m.hash || card.hash !== m.hash || card.action !== "draft") {
        await setCard(tabId, { status: "stopped", message: "This page was not approved as it is now. Nothing was saved or sent.", approved: false }, "refused");
        return { ok: false };
      }
      const drafts = await get(L, "workday_drafts", []);
      drafts.unshift({ at: Date.now(), company: card.company, url: card.url, job_id: card.jobId, step: m.step, approval_hash: m.hash, approved_answers: m.payload?.fields || [],
        card_shown_at: card.shown_at || null, approved_at: card.approved_at || null });
      await put(L, "workday_drafts", drafts.slice(0, 300));
      await setWorkdayNext(tabId, true);
      await setCard(tabId, { status: "saving", message: `Saving this page to ${card.company} as a draft with Workday's Save and Continue. Nothing is submitted.` });
      return { ok: true };
    }
    case "draft-clicked":
      return { ok: true };
    case "survey": {
      // WO-054: a hidden tab's reading of its posting, taken once, only from a tab Prepare opened.
      const done = surveys.get(tabId);
      if (!done) return { ok: false };
      surveys.delete(tabId);
      // 50-in-30: the form as read (its schema, the fields whose options live on the page), kept to plan it again after
      // the person answers the panel's questions, without loading the page a second time.
      const schema = Array.isArray(m.schema) && JSON.stringify(m.schema).length < 1_000_000 ? m.schema : null;
      done({ ok: !!m.ok, why: m.why, jobId: m.jobId, company: m.company, location: m.location, needs: Array.isArray(m.needs) ? m.needs.slice(0, 200) : [],
        batch: m.batch && typeof m.batch === "object" ? m.batch : null, schema, listed: Array.isArray(m.listed) ? m.listed.map(String) : [], family: m.family,
        pageUrl: typeof m.url === "string" ? m.url : null });
      return { ok: true };
    }
    case "questions": {
      // Ask once: each question that stopped this form goes to Trainee once, to be asked by text.
      // Once per form; a Workday application asks once per step (each step has its own questions).
      const done = await get(S, "asked", {});
      const once = m.step ? `${m.jobId}\n${String(m.step).slice(0, 200)}` : m.jobId;
      if (done[once]) return { ok: true, stored: 0 };
      const f = await facts((await session())?.user_id);
      const q = C.questionsForTrainee({ jobId: m.jobId, company: m.company, location: typeof m.location === "string" ? m.location.slice(0, 300) : undefined, needs: m.needs, answers: f.answers, answered: new Set(f.answered) });
      if (!q.questions.length) return { ok: true, stored: 0 };
      try {
        const n = await rpc("career_apply_questions_put_own", { p_job_id: q.posting, p_questions: q.questions });
        done[once] = true;
        await put(S, "asked", done);
        return { ok: true, stored: n };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    }
    case "screenshot": {
      // The page as the person sees it, identity fields covered by the content script while it is taken. Only from the tab
      // in front: a picture of another tab is no proof of this one.
      const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
      if (!tab?.active) return { ok: false, message: "the application's tab is not in front" };
      const shot = await capture(sender.tab.windowId);
      return shot ? { ok: true, ...shot } : { ok: false, message: "the picture could not be taken" };
    }
    case "begin": {
      const card = (await cards())[tabId];
      // The content script may only start the one application the person approved, by its hash.
      // A Workday step's draft approval (WO-048) never submits: only a card that submits starts an application.
      if (!card || !card.approved || card.approved_hash !== m.hash || card.hash !== m.hash || card.action === "draft") return { ok: false, message: "This application was not approved as it is now. Nothing was sent." };
      // WO-101: a card code approved from the person's batch starts only while that approval is still here (Stop applying
      // removes it) and through the owner-switched agent start, which uses the approval once.
      const agent = card.approved_by === "agent";
      // WO-102: a rehearsal never starts an application, whatever asks.
      if ((await get(S, "agent_mode", "send")) === "rehearse") return { ok: false, message: "Rehearsal: nothing is sent." };
      if (agent) {
        const a = (await agentApproved())[card.jobId];
        if (!(await config()).agentSubmits || !a || a.hash !== card.batch_hash) {
          await agentStopped(tabId, card, "Stopped: your batch approval for this posting was withdrawn. Nothing was sent.");
          return { ok: false, message: "withdrawn" };
        }
      }
      // WO-102: revalidated here, at the boundary every path passes before its click, from the facts as they are now: each
      // fact behind an answer is still one the person gave, the approval was made under this fact manifest and this
      // quarantine version. Anything changed, withdrawn or unverifiable stops it; nothing was sent.
      const sess = await session();
      const now = sess ? (await facts(sess.user_id)).manifest : null;
      const gone = now ? factsStillGiven(m.payload, now) : ["(signed out)"];
      const approvedUnder = agent ? (await agentApproved())[card.jobId]?.posting : null;
      const stale = !now || gone.length || (m.payload?.manifest_hash !== undefined && m.payload.manifest_hash !== now.hash)
        || (m.payload?.quarantine_version !== undefined && m.payload.quarantine_version !== now.version)
        || (agent && (!approvedUnder || approvedUnder.manifest_hash !== now.hash || approvedUnder.quarantine_version !== now.version));
      if (stale) {
        const why = `The facts behind this application changed since it was approved${gone.length ? ` (${gone.slice(0, 5).map((l) => `"${l}"`).join(", ")})` : ""}. Nothing was sent.`;
        if (agent) await agentStopped(tabId, card, why);
        else await setCard(tabId, { status: "stopped", message: why, approved: false }, "refused");
        return { ok: false, message: why };
      }
      try {
        const row = agent
          ? await rpc("career_apply_extension_begin_agent_own", { p_payload: m.payload, p_approval: m.hash, p_batch_hash: card.batch_hash })
          : await rpc("career_apply_extension_begin_own", { p_payload: m.payload, p_approval: m.hash });
        if (agent) {
          const ap = await agentApproved();
          delete ap[card.jobId];
          await put(S, "agent_approved", ap);
        }
        // The drafts behind each drafted answer, as Trainee wrote them, for the proof (edited or used as drafted).
        const items = await draftsFor(tabId, card.jobId), drafts = {};
        for (const f of m.payload.fields || []) {
          const d = items[f.name];
          if (f.source === "drafted" && d?.original) drafts[f.name] = { original: d.original, factIds: d.factIds || [] };
        }
        await setPending(tabId, {
          id: row.id, lease: row.lease, hash: m.hash, payload: m.payload, url_before: m.urlBefore, planned_names: m.plannedNames, drafts,
          form_answers: m.formAnswers?.answers?.length ? m.formAnswers : null,
          card_shown_at: card.shown_at, approved_at: card.approved_at, screenshot_sha256: m.screenshot?.sha256 || null, screenshot: m.screenshot?.dataUrl || null,
          agent, batch_hash: agent ? card.batch_hash : null,
        });
        await setCard(tabId, { begun: true });
        return { ok: true };
      } catch (e) {
        const why = /daily_cap/.test(e.message) ? "You reached today's application limit." : /company_cooldown/.test(e.message)
          ? "You applied to this company in the last 30 days." : /duplicate_job/.test(e.message)
          // The same posting is already in the person's applications: sent, being sent, or approved and waiting (a site that
          // asked us to slow down, or a claim not started yet: it goes again by itself). Never "you already applied" for one
          // that may never have been sent (the chat's and the card's words, career_apply_cards.ts).
          ? "This posting is already in your applications (sent, or approved and waiting to go); each posting goes at most once."
          : e.message === "SIGNED_OUT" ? say.signedOut : /stale|current/.test(e.message) ? "Your account changed since this card was made; review it again."
          : /agent submit is off/.test(e.message) ? "Trainee sending is switched off for your account."
          : /no live batch approval/.test(e.message) ? "Your batch approval for this posting is no longer live (withdrawn, used, or over a day old)."
          : "Trainee could not record this application, so it was not sent.";
        if (agent) {
          await agentStopped(tabId, card, why + " Nothing was sent.");
          return { ok: false, message: why };
        }
        await setCard(tabId, { status: "stopped", message: why + " Nothing was sent.", approved: false }, "refused");
        return { ok: false, message: why };
      }
    }
    case "awaiting-person": {
      // Person-submits mode: everything up to the click passed; Trainee presses nothing and waits for the person's own press.
      const p = (await pendings())[tabId];
      if (p) await setPending(tabId, { ...p, awaiting_person: true });
      await setCard(tabId, { status: "awaiting_person", message: say.pressYourself });
      return { ok: true };
    }
    case "clicked": {
      const p = (await pendings())[tabId];
      if (p) {
        p.clicked_at = m.at;
        p.errors_before = m.errorsBefore || [];
        p.steps = m.steps || null;
        await setPending(tabId, p);
      }
      await setCard(tabId, { status: "submitting", message: m.byPerson ? "You pressed the site's own Submit; waiting for the employer's answer." : "Sent with the site's own Submit; waiting for the employer's answer." });
      // The click may have moved the page before this message landed (CI, a fast thank-you page): its load is over and
      // onUpdated passed the tab by. A loaded page without the clicking page's mark is the page after the click.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (p && tab?.status === "complete") {
        const [mark] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__traineeClicked === true }).catch(() => []);
        if (mark && mark.result === false) afterNavigation(tabId);
      }
      return { ok: true };
    }
    case "email-code": {
      // WO-096: the page that clicked now asks for the emailed code (Greenhouse's code box on the same form).
      const p = (await pendings())[tabId];
      const r = await typeEmailCode(tabId, sender.frameId || 0, p);
      return { ok: true, typed: r.typed, stop: r.stop };
    }
    case "outcome":
      return { ok: true, card: await finish(tabId, m.observation, { ...m, codeStop: m.codeStop || null }) };
    case "stopped": {
      const card = (await cards())[tabId];
      if (m.finishPending) await finish(tabId, null, { reason: C.BEFORE_CLICK, message: m.message });
      else if (card?.approved_by === "agent" && card.approved && !card.begun) await agentStopped(tabId, card, oneLine(m.message, "Stopped before the click. Nothing was sent."));
      else await setCard(tabId, { status: "stopped", message: m.message, approved: false, beforeClick: !!m.beforeClick });
      return { ok: true };
    }
    case "proof": {
      const list = await get(L, "evidence", []);
      const e = list.find((x) => x.id === m.id) || null;
      if (e?.shots) Object.assign(e, (await L.get("shot:" + e.id))["shot:" + e.id] || {});
      return { ok: true, proof: e };
    }
    case "clear-proof":
      if (m.confirm !== "clear") return { ok: false, message: "Not cleared." };
      await L.remove(["evidence", "timing", ...Object.keys(await L.get(null)).filter((k) => k.startsWith("shot:"))]);
      return { ok: true };
    // ---- from the panel (the person)
    case "status": {
      const a = await session();
      const resume = await get(L, "resume", null);
      const timing = await get(L, "timing", []);
      const card = m.tabId !== undefined ? (await cards())[m.tabId] || null : null;
      return {
        signedIn: !!a, user_id: a?.user_id || null, email: a?.email || "", resume: resume ? { name: resume.name, sha256: resume.sha256 } : null,
        card, drafts: card ? await draftsFor(m.tabId, card.jobId) : {}, queue: await queueState(),
        timing: { n: timing.length, avg_ms: timing.length ? Math.round(timing.reduce((x, y) => x + y, 0) / timing.length) : null },
        importedFacts: Object.keys((await get(S, "imported_file", { answers: {} })).answers || {}).length,
        answerOnce: await get(S, "answer_once", null),
        agent: (await config()).agentSubmits
          ? { batch: await get(S, "agent_batch", null), approved: Object.keys(await agentApproved()).length, receipts: (await get(L, "agent_receipts", [])).slice(0, 20),
            mode: await get(S, "agent_mode", "send"), rehearsals: (await get(L, "agent_rehearsals", [])).slice(0, 20).map((x) => ({ company: x.company, url: x.url, matched: x.matched,
              answers: x.answers, supported_pct: x.supported_pct, quarantined_dependencies: x.quarantined_dependencies, unanswered_required: x.unanswered_required, diffs: x.diffs })) }
          : null,
      };
    }
    case "signin-app":
      return await signInFromApp();
    case "signin-magic":
      return await magicLink(m.email);
    case "signout":
      await S.remove(["auth", "imported_file", "fact_import_reviews", "fact_import_receipts"]);
      return { ok: true };
    case "set-resume": {
      const bytes = b64ToBytes(m.base64);
      if (!bytes.length || bytes.length > 10_000_000) return { ok: false, message: "Pick a resume file under 10 MB." };
      await put(L, "resume", { name: m.name, type: m.mime || "application/pdf", base64: m.base64, sha256: await sha256Hex(bytes) });
      return { ok: true };
    }
    case "import-facts": {
      const run = factImportQueue.then(() => importFactFile(m, sender));
      factImportQueue = run.catch(() => {});
      return await run;
    }
    case "prepare":
      return await chrome.tabs.sendMessage(m.tabId, { type: "prepare" }).catch(() => ({ ok: false, message: "Open an application page first." }));
    case "approve": {
      // The one tap. Bound to the card the person read: its hash must be the one shown.
      let taken = false;
      await withCards(m.tabId, "approve", (card) => {
        if (!card || card.hash !== m.hash || card.status !== "ready") return null;
        taken = true;
        return { ...card, approved: true, approved_hash: m.hash, approved_at: Date.now(), status: "submitting", message: "Checking the form is still exactly what you approved...", updated_at: Date.now() };
      });
      if (!taken) return { ok: false, message: "This card changed; read the new one before approving." };
      // The content script answers at once and then works. If the page cannot be reached at all, nothing was recorded or
      // clicked; once a record exists, the outcome is finish()'s alone, never "nothing was sent" (WO-031 review).
      chrome.tabs.sendMessage(m.tabId, { type: "submit", hash: m.hash }).catch(async () => {
        if ((await pendings())[m.tabId]) return;
        await setCard(m.tabId, { status: "stopped", message: "The page could not be reached, so nothing was sent.", approved: false }, "unreachable");
      });
      return { ok: true };
    }
    case "essay-draft": {
      // WO-049: the person's tap on "Draft from my facts" (or "Redo") for one written question on the card in front of them.
      const card = (await cards())[m.tabId];
      const q = (card?.essays || []).find((e) => e.name === m.name);
      if (!card || !q || !["ready", "blocked"].includes(card.status)) return { ok: false, message: "That question is not on this card now. Press Fill this application to read the form again." };
      const prior = (await draftsFor(m.tabId, card.jobId))[m.name] || null;
      if (prior?.state === "drafting") return { ok: false, message: "Already drafting this one." };
      // Redo of a draft already on the form takes it off first: the new draft goes on only by Use this.
      if (m.redo && prior?.state === "used") {
        const r = await chrome.tabs.sendMessage(m.tabId, { type: "essay-fill", name: m.name, text: "" }).catch(() => null);
        if (!r?.ok) return { ok: false, message: r?.message || "The page could not be reached, so nothing changed." };
      }
      await setDraft(m.tabId, card.jobId, m.name, { label: q.label, state: "drafting", message: "Drafting from your confirmed facts..." });
      const r = await requestDraft(card, q, m.redo ? prior?.original || null : null);
      const item = C.showableDraft(r)
        ? { label: q.label, state: "drafted", text: r.text, original: r.text, factIds: r.fact_ids, facts: (r.facts || []).map((f) => ({ id: String(f.id), label: String(f.label) })), message: oneLine(r.message, "") }
        : { label: q.label, state: r?.why === "policy" ? "refused" : "failed", why: r?.why || "model", message: oneLine(r?.ok ? "" : r?.message, NO_DRAFT) };
      return { ok: true, item: await setDraft(m.tabId, card.jobId, m.name, item) };
    }
    case "essay-use": {
      // WO-049: the person's "Use this" (or their edit of the used text): it goes on the form as theirs, and the card is
      // read again, so their approval binds exactly this text.
      const card = (await cards())[m.tabId];
      const item = card ? (await draftsFor(m.tabId, card.jobId))[m.name] : null;
      if (!card || !item || !["drafted", "used"].includes(item.state)) return { ok: false, message: "There is no draft for that question to use." };
      if (!["ready", "blocked"].includes(card.status)) return { ok: false, message: "This application is being sent or was sent, so nothing changed." };
      const text = String(m.text ?? "");
      if (!text.trim()) return { ok: false, message: "The answer is empty. Type it, or tap Redo for another draft." };
      if (text.length > 2000) return { ok: false, message: "That answer is over 2000 characters, more than one answer can hold. Shorten it first." };
      const r = await chrome.tabs.sendMessage(m.tabId, { type: "essay-fill", name: m.name, text, factIds: item.factIds || [] }).catch(() => null);
      if (!r?.ok) return { ok: false, message: r?.message || "The page could not be reached, so nothing changed." };
      await setDraft(m.tabId, card.jobId, m.name, { ...item, state: "used", text: r.value });
      return { ok: true, hash: r.hash };
    }
    case "queue-set": {
      const urls = C.postingLinks(m.text || "", 100);
      const q = await queueState();
      const have = new Set(q.items.map((x) => C.postingKey(x.url)));
      for (const u of urls) if (!have.has(C.postingKey(u))) q.items.push({ url: u, state: "waiting" });
      await put(S, "queue", q);
      return { ok: true, added: urls.length };
    }
    case "queue-from-tabs": {
      const tabs = await chrome.tabs.query({});
      return await handle({ type: "queue-set", text: tabs.map((t) => t.url || "").join("\n") }, {});
    }
    case "queue-from-matches": {
      // Trainee's matches are the alert texts in the person's own outbox (row-level security: only theirs).
      try {
        const rows = await selectOwn("career_outbox?select=text,created_at&kind=eq.alert&order=created_at.desc&limit=50");
        return await handle({ type: "queue-set", text: rows.map((r) => r.text).join("\n") }, {});
      } catch (e) {
        return { ok: false, message: e.message === "SIGNED_OUT" ? say.signedOut : "Trainee's matches could not be read; paste the links instead." };
      }
    }
    case "queue-from-trainee": {
      // WO-066: the postings the person asked Trainee to apply to in chat, from their own queue (row-level security: only
      // theirs), into the same queue their pasted links go; each is then prepared here and goes only on its card's tap.
      try {
        const rows = await selectOwn("career_apply_wanted?select=posting_key,url&state=eq.waiting&order=queued_at.asc&limit=100");
        if (!rows.length) return { ok: false, message: "Trainee has no postings waiting for you. Ask Trainee in chat to apply to some." };
        const r = await handle({ type: "queue-set", text: rows.map((x) => x.url).join("\n") }, {});
        await rpc("career_apply_want_take_own", { p_keys: rows.map((x) => x.posting_key) });
        return r;
      } catch (e) {
        return { ok: false, message: e.message === "SIGNED_OUT" ? say.signedOut : "Trainee's picks could not be read; paste the links instead." };
      }
    }
    case "queue-start": {
      return await withQueue(async () => {
        const q = await queueState();
        const waiting = q.items.filter((x) => x.state === "waiting").length;
        if (!waiting) return { ok: false, message: "Add some posting links first." };
        q.running = true;
        q.tabId = m.tabId ?? q.tabId ?? null;
        // A posting left open by an earlier run that was stopped is not opened or sent again by this one.
        for (const it of q.items) if (it.state === "open") it.state = "stopped";
        await put(S, "queue", q);
        // The person's own tab is the first lane; any others are windows of their own (kept from the last start if open).
        // Only the agent sends on several lanes, and only as many as config.js agentTabs says (1 unless the owner sets more).
        const want = Math.max(1, Math.min(await sendLanes(), waiting));
        const lanes = q.tabId !== null ? [q.tabId] : [];
        for (const t of lanesOf(q)) if (lanes.length < want && !lanes.includes(t) && (await chrome.tabs.get(t).catch(() => null))) lanes.push(t);
        while (lanes.length < want && (lanes.length || want > 1)) lanes.push((await chrome.windows.create({ url: "about:blank", focused: false, width: 1280, height: 900 })).tabs[0].id);
        q.lanes = lanes;
        if (q.tabId === null && lanes.length) q.tabId = lanes[0];
        await put(S, "queue", q);
        if (!lanes.length) await openNext(q, null);
        for (const t of lanes) await openNext(await queueState(), t);
        return { ok: true };
      });
    }
    case "queue-skip": {
      return await withQueue(async () => {
        const q = await queueState();
        // The posting open in the panel's tab's lane, else the last one opened.
        const it = q.items.find((x) => x.state === "open" && m.tabId !== undefined && x.lane === m.tabId) || q.items[q.index];
        if (it && it.state === "open") it.state = "skipped";
        await put(S, "queue", q);
        if (q.running) await openNext(q, it?.lane ?? q.tabId);
        return { ok: true };
      });
    }
    case "queue-stop": {
      return await withQueue(async () => {
        const q = await queueState();
        q.running = false;
        await put(S, "queue", q);
        return { ok: true };
      });
    }
    case "queue-clear":
      await put(S, "queue", { items: [], index: -1, tabId: null, running: false });
      await S.remove("answer_once");
      return { ok: true };
    case "answer-once-prepare": {
      if (preparing) return { ok: false, message: "Already reading the queue's postings." };
      preparing = true;
      try {
        return await prepareQueue();
      } finally {
        preparing = false;
      }
    }
    case "answer-once-save":
      return await saveAnswerOnce(m.answers);
    case "batch-approve": {
      // WO-101: the person's one tap on the batch, bound to the entries the panel showed them (their hashes).
      if (!(await config()).agentSubmits) return { ok: false, message: say.agentOff };
      const st = await get(S, "agent_batch", null);
      const want = new Set(Array.isArray(m.hashes) ? m.hashes.map(String) : []);
      const pick = (st?.ready || []).filter((e) => want.has(e.hash));
      if (!pick.length || pick.length !== want.size) return { ok: false, message: "This batch changed; read it again before approving." };
      try {
        await rpc("career_apply_batch_approve_own", { p_items: pick.map((e) => ({ entry: { version: 1, kind: "agent-batch", ...e.posting }, hash: e.hash })) });
      } catch (e) {
        return { ok: false, message: e.message === "SIGNED_OUT" ? say.signedOut : "Your approval could not be recorded, so Trainee will not send these." };
      }
      const ap = await agentApproved();
      for (const e of pick) ap[e.jobId] = { hash: e.hash, posting: e.posting, url: e.url, approved_at: Date.now() };
      await put(S, "agent_approved", ap);
      await put(S, "agent_mode", "send");
      await put(S, "agent_batch", { ...st, approved: [...new Set([...(st.approved || []), ...pick.map((e) => e.hash)])] });
      return { ok: true, approved: pick.length };
    }
    case "batch-rehearse": {
      // WO-102: the protected no-submit rehearsal of a batch: approved on this computer only (nothing recorded on the
      // account), filled and checked exactly as a send would be, never started or clicked; a report per posting.
      if (!(await config()).agentSubmits) return { ok: false, message: say.agentOff };
      const st = await get(S, "agent_batch", null);
      const want = new Set(Array.isArray(m.hashes) ? m.hashes.map(String) : []);
      const pick = (st?.ready || []).filter((e) => want.has(e.hash));
      if (!pick.length || pick.length !== want.size) return { ok: false, message: "This batch changed; read it again before rehearsing." };
      const ap = {};
      for (const e of pick) ap[e.jobId] = { hash: e.hash, posting: e.posting, url: e.url, approved_at: Date.now(), rehearsal: true };
      await put(S, "agent_approved", ap);
      await put(S, "agent_mode", "rehearse");
      const q = await queueState();
      for (const it of q.items) if (it.state === "rehearsed" || it.state === "needs_you") it.state = "waiting";
      await put(S, "queue", q);
      return await handle({ type: "queue-start", tabId: m.tabId }, {});
    }
    case "batch-stop": {
      // WO-101: "Stop applying": the queue stops, every batch approval here is removed and withdrawn on the account, and a
      // send in progress stops at its next check before the click.
      const q = await withQueue(async () => {
        const x = await queueState();
        x.running = false;
        await put(S, "queue", x);
        return x;
      });
      await S.remove(["agent_approved", "agent_mode"]);
      for (const t of agentWait.values()) clearTimeout(t);
      agentWait.clear();
      for (const t of lanesOf(q)) chrome.tabs.sendMessage(t, { type: "agent-stop" }).catch(() => {});
      let withdrawn = true;
      try {
        await rpc("career_apply_batch_revoke_own", {});
      } catch {
        withdrawn = false;
      }
      return { ok: true, message: withdrawn ? "Stopped. Nothing more is sent, and your batch approval is withdrawn."
        : "Stopped on this computer: nothing more is sent from here. Your approval could not be withdrawn on your account just now; press Stop applying again once you are online." };
    }
    case "answer-once-skip": {
      const st = await get(S, "answer_once", null);
      if (!st) return { ok: false };
      await put(S, "answer_once", { ...st, skipped: [...new Set([...st.skipped, String(m.key)])] });
      return { ok: true };
    }
    case "import-text":
    case "confirm-stated":
      return await statedStep(m);
    default:
      return { ok: false, message: "unknown request" };
  }
}
// Who may ask what (WO-031 review): what the person does (approve, sign in, set the resume, the queue, the proof) comes
// only from the extension's own panel page, never from a content script running inside an employer's page; what a page
// reports comes only from a content script in a tab.
const PANEL_ONLY = new Set(["status", "signin-app", "signin-magic", "signout", "set-resume", "import-facts", "prepare", "approve", "essay-draft", "essay-use",
  "queue-set", "queue-from-tabs", "queue-from-matches", "queue-from-trainee", "queue-start", "queue-skip", "queue-stop", "queue-clear", "proof", "clear-proof",
  "answer-once-prepare", "answer-once-save", "answer-once-skip", "batch-approve", "batch-rehearse", "batch-stop"]);
const TAB_ONLY = new Set(["context", "queued", "card", "questions", "screenshot", "begin", "awaiting-person", "clicked", "email-code", "outcome", "stopped", "draft", "draft-clicked", "survey"]);
// The sender's URL is set by Chrome: a content script's is the employer page's, the panel's is panel.html (in the side
// panel it has no tab; opened as its own window it has one, so the URL decides, not the tab).
const fromPanel = (sender) => typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL("panel.html"));
const fromPage = (sender) => !!sender.tab && typeof sender.url === "string" && !sender.url.startsWith(chrome.runtime.getURL(""));
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // Only this extension's own pages and content scripts talk here; nothing a web page sends is read.
  if (sender.id !== chrome.runtime.id) return false;
  const type = m?.type;
  if (PANEL_ONLY.has(type) && !fromPanel(sender)) {
    reply({ ok: false, message: "Only the Trainee panel can ask for that." });
    return false;
  }
  if (TAB_ONLY.has(type) && !fromPage(sender)) {
    reply({ ok: false, message: "Only an application page can report that." });
    return false;
  }
  if (!PANEL_ONLY.has(type) && !TAB_ONLY.has(type)) {
    reply({ ok: false, message: "unknown request" });
    return false;
  }
  handle(m || {}, sender).then(reply, (e) => reply({ ok: false, message: String(e?.message || e) }));
  return true;
});

// ------------------------------------------------------------------------------------------------ stated facts (FRS)
// A block of facts the person typed or pasted (TraineeCore.parseStatedFacts, pure): "import-text" keeps the drafts and
// shows them back with what was not read; "confirm-stated", on the person's own tap in the panel, mints the confirmation
// event, stamps the checked drafts "owner stated (...)" and puts them into the confirmed-facts file facts() builds the
// manifest from (the "imported_file" import-facts writes). Drafts alone never fill anything.
async function statedStep(m) {
  if (m.type === "import-text") {
    const r = C.parseStatedFacts(String(m.text || "").slice(0, 20000), { source: "typed in the Trainee panel", now: Date.now() });
    const id = crypto.randomUUID();
    await put(S, "stated_drafts", { id, facts: r.facts, leftover: r.leftover, source: "typed in the Trainee panel" });
    return { ok: true, id, facts: r.facts, leftover: r.leftover };
  }
  const a = await session();
  if (!a) return { ok: false, message: say.signedOut };
  const d = await get(S, "stated_drafts", null);
  if (!d || d.id !== m.id) return { ok: false, message: "Those facts changed; press Read again." };
  const keep = (Array.isArray(m.keep) ? m.keep : []).map(Number).filter(Number.isInteger);
  if (!keep.length) return { ok: false, message: "Check the facts that are right first." };
  const confirmed = C.confirmStatedFacts({ owner: a.user_id, drafts: d.facts, keep, source: d.source, now: Date.now(), eventId: "stated-confirm:" + crypto.randomUUID() });
  await put(S, "imported_file", C.withStatedFacts(await get(S, "imported_file", null), a.user_id, confirmed));
  await S.remove("stated_drafts");
  return { ok: true, kept: Object.keys(confirmed).length };
}
PANEL_ONLY.add("import-text");
PANEL_ONLY.add("confirm-stated");
