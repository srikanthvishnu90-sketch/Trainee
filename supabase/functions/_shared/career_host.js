// career_host.js — the hosted seam for the career agent (GO-LIVE FLIP,
// 2026-10-13, owner ruling: the career version is the live product).
//
// The career chain (120 access → 130 onboarding → 142 router → 141
// doorstep, wrapped in 143 containment with 140 composing fallbacks) was
// built and graded through the gauntlet harness (scripts/career/gauntlet/
// pilot-lib.cjs). This file is the harness's hosted equivalent: the chain
// modules are INJECTED, so the exact dispatch code below runs in three
// places with zero drift —
//   * Node tests (tests/career-http-host.test.cjs) inject packages/domain;
//   * the Deno handler injects the bundled exports of router_core.js;
//   * the dispatch order + §1b ensure-ending mirror pilot-lib.cjs exactly.
//
// Hosted differences from the harness, deliberately:
//   * ctx.postings is the LIVE pool (empty until a hosted board source is
//     wired) — the harness injects the pinned exam corpus; production must
//     never serve fixture jobs as if they were live.
//   * ctx.now is the real clock, not the frozen fixture clock.
//   * turn state rides a per-thread snapshot (extractSnapshot /
//     createTurnCtx) that the handler persists in agent_flow_state.state
//     under the "career" key — the chain's stores are plain JSON by design.
"use strict";

const CareerHost = (() => {
  // Reachable pure domain code is not a connected execution worker. This
  // hosted seam attaches neither the Node-only 150 driver nor an alerts
  // scheduler/channel. Runtime capabilities never ride user snapshots.
  const WORKER_CAPABILITIES = Object.freeze({
    portal_browser: Object.freeze({ status: "NOT_WIRED", reason: "The Node browser worker is not connected to this Edge handler." }),
    job_alert_delivery: Object.freeze({ status: "NOT_WIRED", reason: "No alert scheduler or delivery worker is connected to this Edge handler. Saving a watch does not start polling or deliver reminders." }),
  });
  // Whitelist of ctx keys that carry durable per-thread career state.
  // Anything not listed here is a per-turn input or a host service and is
  // never persisted.
  const STATE_KEYS = [
    "profile", "osStore", "doorstepState", "queueState", "globalPause",
    "trackStore", "suppression", "applyLog", "applicationLog", "outreach",
    "outreachContacts", "contacts", "sendingAccounts", "artifacts",
    "discovery", "plan", "offer", "portalRecords", "statusRecords",
    "tasks", "resumeTexts", "pastedText",
    // COMPLEXITY WAVE: a user-pasted posting staged on ctx, the user's
    // own stated facts, the deferred parts of a multi-intent turn, and
    // relayed opt-out records — all four are conversation state the
    // router reads back on later turns, so all four must survive the
    // snapshot round trip like every other store here.
    "posting", "statedFacts", "intentQueue", "_relayedSuppressions",
    // MI-032 STEP 2 (alerts host wiring, docs/career/alerts-host-wiring.md
    // §4/§5): the watch-state box. 142's watch intents read/write module
    // 152's records through a sync {get,set} view of this plain JSON
    // object (watchStoreOf in 142); the records inside are keyed per
    // user in 152's own scheme (career:watch-profile:<user_id>,
    // career:reminder-queue:<user_id>, career:reminder-history:<user_id>)
    // plus the host delivery ledger — so the box is per-user state, and
    // whitelisting it here is what makes chat-created watches, queued
    // reminders and delivery history survive the snapshot round trip
    // instead of dying with the turn. Created lazily by 142 on first
    // write only; a read never materializes it.
    "alertWatchState",
    // LOOP ACCEPTANCE (155, Crew B 2026-10-15; registry allocation
    // requested — joins list in the loop-acceptance build record):
    // the batch-apply run object. 155's run is pure JSON by
    // construction (queue, per-application states, minted approvals,
    // events); 142's batch seam writes it here when a run is prepared
    // at the approval card and reads it back on the approval turn,
    // where sessions are rebuilt and 149's MI-116 hash verification
    // guards the submit. Without this key a prepared batch would die
    // with the turn and the "yes" could never resume it.
    "batchApplyState",
    // WO-036: an offer the person texted with a piece missing (company, base, city or title), kept so the agent
    // brain's offer_benchmark asks for it once and reads the answer with the rest. Cleared once benchmarked; an
    // erase resets the stores.
    "offerBenchmark",
  ];

  function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // DEPTH LANE A (MI-013): cross-thread stated facts. The account
  // record carries a `stated_facts` key ({facts, offer, updated_at})
  // written only from the user's own assertions (the router's
  // capture discipline is the only producer) and read back here at
  // turn start, so a fact stated in one thread is on the record in
  // every later thread. ROUND 2 (judge blocker, PR #151): the
  // ACCOUNT record is authoritative per identity — keyed facts
  // (kind+key) and single-value kinds alike. A thread's copy is a
  // cache frozen at that thread's last turn: it contributes only
  // identities the account does not hold at all, and never
  // replaces a value the account holds (an interleaved thread may
  // have committed a newer value since the cache was written).
  // Multi-value kinds union without duplicates. A brand-new
  // thread starts from everything the user has ever stated.
  // WO-095: the polarity kinds (sponsorship, citizenship) are single-
  // value too — a corrected answer replaces the old one across threads,
  // never sits beside it as a contradiction.
  const ACCOUNT_SINGLE_FACT_KINDS = ["year", "geography", "target_firm", "level", "tone", "school", "majors", "sponsorship", "citizenship"];
  function mergeStatedFacts(accountFacts, threadFacts) {
    const out = [];
    const seen = new Set();
    const keyOf = (f) => `${f && f.kind}:${String((f && f.value) || "").toLowerCase()}`;
    // V241 LIVE-FIX LANE 2: keyed facts (module 142's recordKeyedFact —
    // recruiter contacts, hiring managers, interview days) are
    // identified by kind + key (the company they belong to), never by
    // kind + value: two contacts can share a name at different
    // companies, and a corrected name at one company is the same fact
    // restated. Identity is kind+key in BOTH passes; which pass wins
    // is decided by the callers below (account first, thread
    // append-only — see the ROUND 2 note on the thread pass).
    const keyedIdOf = (f) => (f && typeof f.key === "string" && f.key) ? `key:${f.kind}:${f.key.toLowerCase()}` : null;
    const pushKeyed = (f, threadWins) => {
      const id = keyedIdOf(f);
      const i = out.findIndex((x) => keyedIdOf(x) === id);
      if (i >= 0) { if (threadWins) out[i] = cloneJson(f); return; }
      out.push(cloneJson(f));
    };
    for (const f of Array.isArray(accountFacts) ? accountFacts : []) {
      if (!f || !f.kind || !f.value) continue;
      if (keyedIdOf(f)) pushKeyed(f, false);
      else if (ACCOUNT_SINGLE_FACT_KINDS.includes(f.kind)) { if (!seen.has(`kind:${f.kind}`)) { out.push(cloneJson(f)); seen.add(`kind:${f.kind}`); seen.add(keyOf(f)); } }
      else if (!seen.has(keyOf(f))) { out.push(cloneJson(f)); seen.add(keyOf(f)); }
    }
    for (const f of Array.isArray(threadFacts) ? threadFacts : []) {
      if (!f || !f.kind || !f.value) continue;
      // ROUND 2 (judge blocker, PR #151): the thread pass is
      // append-only per identity. The thread record is a CACHE of
      // the account as of that thread's last turn — when another
      // thread has since committed a newer value for the same
      // identity, the cached copy is stale and must not win (the
      // judge's sequence: a goal stated in an old thread, replaced
      // in a new one, the old thread's recall answered the stale
      // goal AND the turn's write-back committed it over the
      // account). The account is authoritative per identity; the
      // thread contributes only identities the account lacks
      // entirely (a fact whose commit was rolled back or shed over
      // the record cap must not be lost). A thread's own NEW
      // statement still wins — through in-turn capture + commit,
      // never through seed precedence.
      if (keyedIdOf(f)) pushKeyed(f, false);
      else if (ACCOUNT_SINGLE_FACT_KINDS.includes(f.kind)) {
        if (!out.some((x) => x.kind === f.kind)) { out.push(cloneJson(f)); seen.add(`kind:${f.kind}`); seen.add(keyOf(f)); }
      } else if (!seen.has(keyOf(f))) { out.push(cloneJson(f)); seen.add(keyOf(f)); }
    }
    return out;
  }

  // V241 LIVE-FIX LANE 2 (probe i): the deployed account validator
  // (migration 20261016120000, career_host_commit) accepts into
  // stated_facts.facts ONLY facts whose kind is one of
  // STATED_FACT_SQL_KINDS, with a 1..200-char string value and a
  // null-or-≤200-char evidence, at most 40 of them, the whole record
  // ≤32 KB — anything else raises 'invalid stated facts' and the
  // atomic commit rolls the WHOLE turn back (on v241 the succeeding
  // recruiter-contact capture rode facts[] and every such statement
  // turn died as a bare 503). The router's keyed kinds are real
  // record facts, so the write-back SPLITS the record at this seam:
  // SQL-shaped facts ride `facts`; every other fact rides the sibling
  // `keyed` list, which the validator does not inspect and the commit
  // merge (account := account || patch) stores verbatim. The seed in
  // createTurnCtx folds `keyed` back into the one working set, so no
  // fact is dropped or altered — only its carriage changes. This list
  // must mirror the migration exactly; the lane-2 guard parses the
  // migration text and fails on drift.
  const STATED_FACT_SQL_KINDS = ["year", "majors", "geography", "target_firm", "level", "excluded_level", "school", "experience", "tone"];
  function sqlStatedFactOk(f) {
    return !!f && typeof f === "object" && !Array.isArray(f)
      && STATED_FACT_SQL_KINDS.includes(f.kind)
      && typeof f.value === "string" && f.value.length >= 1 && f.value.length <= 200
      && (f.evidence == null || (typeof f.evidence === "string" && f.evidence.length <= 200));
  }
  function statedFactsRecordForCommit(facts, offer, now) {
    const accepted = [];
    const keyed = [];
    for (const f of Array.isArray(facts) ? facts : []) (sqlStatedFactOk(f) && accepted.length < 40 ? accepted : keyed).push(f);
    const record = { facts: cloneJson(accepted), keyed: cloneJson(keyed.slice(0, 40)), offer: offer || null, updated_at: new Date(now || Date.now()).toISOString() };
    // The validator also caps the whole record at 32 KB. Evidence is
    // provenance, never the fact itself: if a pathological record
    // ever neared the cap, shed keyed evidence (longest first) before
    // the cap can raise — kinds, keys and values are never touched.
    while (JSON.stringify(record).length > 30000) {
      let worst = -1, worstLen = 0;
      for (let i = 0; i < record.keyed.length; i++) { const e = record.keyed[i] && record.keyed[i].evidence; if (typeof e === "string" && e.length > worstLen) { worst = i; worstLen = e.length; } }
      if (worst < 0) break;
      record.keyed[worst].evidence = null;
    }
    return record;
  }

  // FEATURE 9 (account memory, DIAGNOSIS 2.6/2.7 fix F5): the person's
  // profile (resume facts with their confirmations) and their tracker
  // belong to the PERSON, not to one thread. They ride the account
  // record (career_watch_kv 'career:account', patch key `memory`,
  // migration 20261026090009) inside the same transactional commit as
  // everything else — advisory lock, account-version fence, privacy
  // epoch, erase — so a resume confirmed or an application logged in one
  // thread is on the record in every other thread and on every later day.
  // What stays per thread is the conversation: the router's frames
  // (profile keys starting with "_", e.g. _careerRouterPrep, _onboarding,
  // and the tracker's _careerThread mirror). The thread snapshot still
  // carries a copy of the profile and tracker as of its last turn,
  // because the executor, the extension sync and the cloud engine read
  // it there; on load the account copy wins.
  const MEMORY_MAX_BYTES = 500000;
  const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const sameJson = (a, b) => JSON.stringify(canon(a === undefined ? null : a)) === JSON.stringify(canon(b === undefined ? null : b));
  const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  // The person's profile without the thread's frames. A profile derived
  // for one turn from stated facts (_fromStatedFacts) is not a profile.
  function accountProfileOf(p) {
    if (!plainObject(p) || p._fromStatedFacts) return null;
    const out = {};
    for (const k of Object.keys(p)) if (!k.startsWith("_")) out[k] = cloneJson(p[k]);
    return out;
  }
  function profileFramesOf(p) {
    const out = {};
    if (!plainObject(p)) return out;
    for (const k of Object.keys(p)) if (k.startsWith("_") && k !== "_careerTrackStore" && k !== "_fromStatedFacts") out[k] = p[k];
    return out;
  }
  function accountTrackerOf(t) {
    if (!plainObject(t)) return null;
    const out = {};
    for (const k of Object.keys(t)) if (k !== "_careerThread") out[k] = cloneJson(t[k]);
    return out;
  }
  // The record this turn would leave on the account: the profile and the
  // tracker, each kept as the account held it when this turn has none of
  // its own (a thread never deletes the person's record by not loading it).
  function memoryOf(ctx) {
    const before = plainObject(ctx._accountMemory) ? ctx._accountMemory : {};
    const trackerSrc = ctx.trackStore || (plainObject(ctx.profile) ? ctx.profile._careerTrackStore : null);
    const profile = accountProfileOf(ctx.profile) || (plainObject(before.profile) ? before.profile : null);
    const tracker = accountTrackerOf(trackerSrc) || (plainObject(before.tracker) ? before.tracker : null);
    return { profile, tracker };
  }

  // §1b ensure-ending — copied verbatim from pilot-lib.cjs (the harness
  // seam that guarantees H-12's last-sentence requirement for 120/130/141
  // results; 142 guarantees its own endings and is NOT passed through here).
  function ensureEndingGuarantee(r, Reply140) {
    if (!r || typeof r.reply !== "string" || !r.reply) return r;
    if (r.intent === "career_fallback" || r.intent === "honest_unavailable") return r;
    // BUG-080 (W6 hand-off, coordinator assembly): the ending rule lives ONCE in
    // 140 (CareerReply.ensureNextStep) — a handler's specific next step wins,
    // the generic closer is appended only when the reply carries no next step
    // at all, and a generic stamped over a specific ending is stripped.
    // The composer arrives as a parameter: it is a createCareerHost dep, not an
    // IIFE-scope name (the first assembly draft referenced it bare and the
    // containment swallowed the ReferenceError — host suite caught it).
    if (!Reply140 || typeof Reply140.ensureNextStep !== "function") return r;
    const specific = typeof r.nextStep === "string" ? r.nextStep : (typeof r.next_step === "string" ? r.next_step : null);
    r.reply = Reply140.ensureNextStep(r.reply, specific ? { nextStep: specific } : undefined);
    return r;
  }

  // Exact first-person controls precede broad keyword routing. This patches
  // only Muse's existing profile/watch snapshot fields, never model authority.
  const PAUSE_RE = /^(?:STOP|UNSUBSCRIBE|stop everything|pause all career work)[.!]*$/i;
  const RESUME_RE = /^(?:resume career work|resume all career work)[.!]*$/i;
  const ERASE_RE = /^(?:forget|delete) my career profile[.!]*$/i;
  // True when this turn belongs to the host's account controls: a pause, resume or erase command, or any turn while
  // the account is paused. Any brain (the router or the agent) must hand such a turn to runTurn, before any model call.
  function isHostControlled(text, ctx) {
    const ask = typeof text === "string" ? text.trim() : "";
    if (PAUSE_RE.test(ask) || RESUME_RE.test(ask) || ERASE_RE.test(ask)) return true;
    return !!(ctx && ctx.globalPause && ctx.globalPause.set === true && ctx.globalPause.source === "account_control");
  }
  function applyHostControl(text, ctx) {
    if (!ctx.userId || typeof text !== "string") return null;
    const ask = text.trim();
    if (PAUSE_RE.test(ask)) {
      ctx.globalPause = { set: true, at: new Date(ctx.now).toISOString(), source: "account_control" };
      ctx._hostPatch = { paused: true };
      return { intent: "career_paused", reply: "Career work is paused — I won't start anything new, and nothing unfinished will be retried on its own. Text \"resume career work\" when you want me back on it." }; // PRODUCT AUDIT 2026-10-28 (#10): plain words
    }
    if (RESUME_RE.test(ask)) {
      ctx.globalPause = { set: false, source: "account_control" }; ctx._hostPatch = { paused: false };
      return { intent: "career_resumed", reply: "The account pause is lifted. Earlier cancelled or uncertain work was not restarted. Ask for the next action explicitly." };
    }
    if (ERASE_RE.test(ask)) {
      for (const key of STATE_KEYS) delete ctx[key];
      ctx.globalPause = { set: true, at: new Date(ctx.now).toISOString(), source: "account_control" };
      ctx._hostPatch = { erase: true, paused: true };
      return { intent: "career_profile_erased", reply: "I removed your saved career profile and active career context, cleared account watches, deleted our chat messages in every thread from Trainee's records and paused career work. Only this exchange is kept there; copies already delivered stay in your messaging app. No uncertain action was retried." };
    }
    const match = ask.match(/^(?:(?:actually|correction|to clarify)[,:]?\s+)?my preferred location is ([^\r\n]{1,100}?)[.!]*$/i);
    if (match && ctx.profile && typeof ctx.profile === "object") {
      const location = match[1].trim();
      if (!location || /[<>]|https?:|password|\b(?:unknown|not sure)\b/i.test(location)) return null;
      ctx.profile.preferences = Object.assign({}, ctx.profile.preferences || {}, { locations: [location] });
      ctx._hostPatch = { preferred_locations: [location] };
      return { intent: "career_preference_corrected", reply: `I saved your preferred location as ${location}. Existing application approvals and watch locations were not silently rewritten; review those separately.` };
    }
    return null;
  }

  function createCareerHost(deps) {
    const { CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment } = deps || {};
    for (const [name, mod] of Object.entries({ CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment })) {
      if (!mod || typeof mod.handleChat !== "function" && name !== "CareerReply" && name !== "CareerContainment") {
        throw new Error(`career host: missing chain module ${name}`);
      }
    }
    if (!CareerContainment || typeof CareerContainment.createContainment !== "function" || typeof CareerContainment.extractReplyText !== "function") {
      throw new Error("career host: CareerContainment must provide createContainment + extractReplyText");
    }

    // PLAIN-STOP TOMBSTONES (2026-10-24): a stop recorded by THIS
    // host instance outranks a stale snapshot presented to it later.
    // The durable carriers are the canonical KV (the load's seed —
    // suite cases (a)/(b)/(c)) and the erase epoch (case (c-erase));
    // this registry is the same record for compositions whose load
    // carries neither: a turn that receives ONLY a stale pre-stop
    // snapshot — no seed, or an explicitly empty one — must not
    // resurrect what an earlier turn on this host stopped. A
    // tombstone only ever SUPPRESSES: it replaces the very record
    // that was stopped (matched by its interests signature and its
    // pre-stop stamp) with the stopped record the stop turn itself
    // produced, or with absence after an erase; a different watch,
    // or the same watch re-created later, is never suppressed — a
    // newer active record clears the tombstone outright.
    const watchTombstones = new Map(); // userId -> { at, sig, profile|null }
    const watchProfileOf = (box, userId) => {
      if (!box || typeof box !== "object") return null;
      for (const key of Object.keys(box)) {
        if (key.endsWith(`:${userId}`)) return { key, profile: box[key] };
      }
      return null;
    };
    const watchProfileActive = (wp) => !!(wp && Array.isArray(wp.interests) && wp.interests.length && !(wp.opt_out && wp.opt_out.global));
    const watchProfileStamp = (wp) => { const ms = Date.parse((wp && wp.updated_at) || ""); return isNaN(ms) ? null : ms; };
    const watchProfileSig = (wp) => JSON.stringify(((wp && wp.interests) || []).map((i) => `${(i && i.interest_id) || ""}|${(i && i.role && i.role.title) || ""}`).sort());

    // J8 (LOOP ACCEPTANCE tier-1 join): the composition root may install
    // a boardFor resolved through career_task_bridge
    // (createCareerBoardFor). It is RUNTIME wiring only: createTurnCtx
    // attaches it to each turn ctx as ctx.batchDeps.boardFor, and it is
    // never persisted — batchDeps is not a STATE_KEYS entry, so a
    // snapshot can neither carry it nor resurrect it. Absent a boardFor,
    // this host's capability stays the module-level NOT_WIRED and
    // module 155's drives stop named BOARD_NOT_WIRED, exactly as before.
    const boardFor = deps && typeof deps.boardFor === "function" ? deps.boardFor : null;
    // J10 (LOOP ACCEPTANCE — deployed-runtime transport): the
    // composition root may install delegateBatch — batch execution
    // delegated to the owned browser worker through committed batch
    // intents (career_batch_intent/v1). Like boardFor it is RUNTIME
    // wiring only: createTurnCtx attaches it as
    // ctx.batchDeps.delegateBatch, batchDeps is not a STATE_KEYS
    // entry, and no snapshot can carry or resurrect it. The flag does
    // NOT change the portal_browser capability stamp: delegation is
    // asynchronous worker execution, not a wired in-turn drive, and
    // no WIRED claim is made for it.
    const delegateBatch = !!(deps && deps.delegateBatch === true);
    // ALERT DELIVERY FLAG (2026-10-25): the composition root may
    // install the alert-delivery capability the same way it installs
    // boardFor — deps.jobAlertDelivery, a capability object the
    // router reads on ctx.workerCapabilities.job_alert_delivery
    // (live === true or status === "LIVE" reads ON; anything else,
    // including the module-level NOT_WIRED default, reads OFF).
    // RUNTIME wiring only: workerCapabilities is not a STATE_KEYS
    // entry, so no snapshot can carry or resurrect it.
    const jobAlertDelivery = deps && deps.jobAlertDelivery && typeof deps.jobAlertDelivery === "object" ? Object.freeze(Object.assign({}, deps.jobAlertDelivery)) : null;
    const workerCapabilities = (boardFor || jobAlertDelivery)
      ? Object.freeze(Object.assign({}, WORKER_CAPABILITIES,
          boardFor ? {
            portal_browser: Object.freeze({ status: "WIRED", transport: "career_task_bridge", reason: "Board sessions resolve through career_task_bridge to the owned browser worker. A worker unreachable at drive time stops each drive named BOARD_NOT_WIRED; no board is ever faked." }),
          } : null,
          jobAlertDelivery ? { job_alert_delivery: jobAlertDelivery } : null))
      : WORKER_CAPABILITIES;

    // Build the hosted ctx for one turn. `snapshot` is the object previously
    // returned by extractSnapshot (or null for a brand-new thread).
    function createTurnCtx(opts) {
      const o = opts || {};
      const ctx = {
        now: typeof o.now === "number" ? o.now : Date.now(),
        userId: o.userId || null,
        threadId: o.threadId || null,
        postings: Array.isArray(o.postings) ? o.postings : [],
        containmentRecords: [],
        // A per-ctx copy of the capabilities container: the values
        // stay the host's frozen stamps, but runtime wiring for THIS
        // turn (a connected delivery worker, a test harness acting
        // as the composition root) can attach or replace a capability
        // on this ctx — the frozen module-level container made the
        // job_alert_delivery seam unwritable, so the flag the router
        // reads could never be turned on by anyone.
        workerCapabilities: Object.assign({}, workerCapabilities),
        accountPersistence: o.accountPersistence === true,
        // FEATURE 9: the composition root turns account memory on (the
        // handler does with CAREER_ACCOUNT_MEMORY=on, once migration
        // 20261026090009 is applied: a database without it refuses the
        // `memory` patch key); off, the profile and tracker stay per
        // thread exactly as before.
        accountMemory: o.accountPersistence === true && o.accountMemory === true,
      };
      if (o.snapshot && o.snapshot.scope && o.snapshot.scope.userId !== ctx.userId) throw new Error("career_snapshot_owner_mismatch");
      const stores = o.snapshot && typeof o.snapshot === "object" ? o.snapshot.stores : null;
      if (stores && typeof stores === "object") {
        for (const key of STATE_KEYS) {
          if (stores[key] !== undefined) {
            try { ctx[key] = cloneJson(stores[key]); } catch { /* unserializable state is dropped, never fatal */ }
          }
        }
      }
      if (o.profile !== undefined) ctx.profile = o.profile;
      // FEATURE 9: the account's profile and tracker are the person's;
      // the thread keeps only its frames. A thread written before the
      // account held a memory (no account_memory stamp on its snapshot)
      // still contributes the tracker rows the account lacks (by app_id)
      // and its profile when the account holds none, so nothing logged
      // before this change is lost.
      const acctMemory = o.account && plainObject(o.account.memory) ? o.account.memory : null;
      if (acctMemory && ctx.accountMemory && o.profile === undefined) {
        try {
          const legacy = !(o.snapshot && o.snapshot.account_memory === 1);
          ctx._accountMemory = { profile: plainObject(acctMemory.profile) ? cloneJson(acctMemory.profile) : null, tracker: plainObject(acctMemory.tracker) ? cloneJson(acctMemory.tracker) : null };
          if (ctx._accountMemory.profile) {
            const threadProfile = plainObject(ctx.profile) ? ctx.profile : null;
            if (!ctx.trackStore && threadProfile && plainObject(threadProfile._careerTrackStore)) ctx.trackStore = threadProfile._careerTrackStore;
            const acctFacts = Array.isArray(ctx._accountMemory.profile.facts) ? ctx._accountMemory.profile.facts : [];
            if (!(legacy && threadProfile && !threadProfile._fromStatedFacts && !acctFacts.length && Array.isArray(threadProfile.facts) && threadProfile.facts.length)) {
              ctx.profile = Object.assign(cloneJson(ctx._accountMemory.profile), profileFramesOf(threadProfile));
            }
          }
          if (ctx._accountMemory.tracker) {
            const threadStore = plainObject(ctx.trackStore) ? ctx.trackStore : null;
            const next = cloneJson(ctx._accountMemory.tracker);
            if (legacy && threadStore && Array.isArray(threadStore.rows)) {
              const have = new Set((Array.isArray(next.rows) ? next.rows : []).map((r) => r && r.app_id));
              const extra = threadStore.rows.filter((r) => r && r.app_id && !have.has(r.app_id));
              if (extra.length) next.rows = [...(Array.isArray(next.rows) ? next.rows : []), ...cloneJson(extra)];
            }
            if (threadStore && plainObject(threadStore._careerThread)) next._careerThread = threadStore._careerThread;
            ctx.trackStore = next;
          }
        } catch { /* a malformed account memory never breaks a turn; the thread's copy stands */ }
      }
      if (o.account) {
        if (o.account.preferred_locations && ctx.profile) {
          ctx.profile.preferences = Object.assign({}, ctx.profile.preferences || {}, { locations: o.account.preferred_locations.slice() });
        }
        if (o.account.paused === true) ctx.globalPause = { set: true, at: new Date(ctx.now).toISOString(), source: "account_control" };
        if (o.account.paused === false && ctx.globalPause && ctx.globalPause.source === "account_control") ctx.globalPause = { set: false };
      }
      if (o.watchState && Object.keys(o.watchState).length) {
        ctx.alertWatchState = cloneJson(o.watchState);
      }
      // WATCH RESURRECTION GUARD (2026-10-24): a snapshot taken
      // BEFORE an erase must not revive the watch the erase deleted.
      // The commit stamps every snapshot with the account's privacy
      // epoch (extractSnapshot below; the SQL commit stamps the same
      // field) and an erase bumps that epoch while deleting the
      // canonical watch row — so after an erase the load returns an
      // EMPTY watchState beside any stale snapshot a caller still
      // holds, and the empty-seed rule above let the stale box ride
      // in and be committed back as a live watch. When the account's
      // epoch is ahead of the snapshot's stamp, the snapshot's watch
      // box is pre-erase state: drop it, and let the canonical seed
      // (empty, post-erase) be the only watch state this turn holds.
      // A non-empty seed already outranks the box (handled above);
      // an account with no epoch disables the guard, so every
      // pre-epoch composition behaves exactly as before.
      const acctEpoch = o.account && Number.isSafeInteger(o.account.epoch) ? o.account.epoch : null;
      const snapEpoch = o.snapshot && Number.isSafeInteger(o.snapshot.privacy_epoch) ? o.snapshot.privacy_epoch : null;
      if (acctEpoch != null && acctEpoch > 0 && (snapEpoch == null || snapEpoch < acctEpoch)
        && !(o.watchState && Object.keys(o.watchState).length)) {
        delete ctx.alertWatchState;
      }
      ctx._accountEpoch = acctEpoch;
      // PLAIN-STOP TOMBSTONE (see the registry above): if this host
      // has recorded a stop for this user, a stale ACTIVE record of
      // the very watch that was stopped — restored from an old
      // snapshot because the load carried no (or an empty) canonical
      // seed — is replaced by the stopped record before any route
      // can read it as live. A newer active record outranks the
      // tombstone and clears it.
      const tomb = watchTombstones.get(ctx.userId);
      if (tomb && ctx.alertWatchState) {
        const cur = watchProfileOf(ctx.alertWatchState, ctx.userId);
        if (cur && watchProfileActive(cur.profile)) {
          const stamp = watchProfileStamp(cur.profile);
          if ((stamp == null || stamp <= tomb.at) && watchProfileSig(cur.profile) === tomb.sig) {
            if (tomb.profile) ctx.alertWatchState[cur.key] = cloneJson(tomb.profile);
            else delete ctx.alertWatchState[cur.key];
          } else if (stamp != null && stamp > tomb.at) {
            watchTombstones.delete(ctx.userId);
          }
        }
      }
      // The watch record this turn STARTS with (after every guard):
      // extractSnapshot compares it against the turn's end state to
      // record a stop that happened inside the turn.
      const startWatch = ctx.alertWatchState ? watchProfileOf(ctx.alertWatchState, ctx.userId) : null;
      ctx._watchStartProfile = startWatch ? cloneJson(startWatch.profile) : null;
      // An explicitly passed EMPTY watchState is "no seed", never a
      // wipe: it used to delete the box the snapshot restore above had
      // just carried in, so a watch created in one turn was gone by
      // the next in every composition that passes a standing empty
      // seed (the chat harnesses do exactly that) — create landed,
      // and cap / read-back / stop then truthfully reported "no job
      // watches on file" for a watch that existed. The snapshot is
      // the durable carriage (STATE_KEYS above); a non-empty seed
      // still overrides it, as before.
      // MUSE-F-002: the worker-written batch run record, read by the handler for this turn only (never a STATE_KEY), so a
      // plain-words status ask speaks the run's true state.
      if (o.batchRunRecord && typeof o.batchRunRecord === "object") ctx.batchRunRecord = o.batchRunRecord;
      if (o.batchDeps || boardFor || delegateBatch) {
        // J8: per-turn batch deps (module 155's seam inputs — the
        // submissions log and attestations today). The composition
        // root's boardFor outranks any per-turn boardFor value; other
        // batchDeps keys pass through untouched. Without either input
        // no batchDeps object is attached, as before.
        // J10: the root's delegateBatch likewise outranks any per-turn
        // value — the execution mode is the composition root's call,
        // never a per-turn caller's.
        ctx.batchDeps = Object.assign({}, o.batchDeps || {}, boardFor ? { boardFor } : {}, delegateBatch ? { delegateBatch: true } : {});
      }
      // DEPTH LANE A (MI-013): seed the account's stated facts into
      // the turn. ROUND 2 (PR #151): the account record is
      // authoritative per identity; the thread's own record
      // (restored above from its snapshot) is a cache that
      // contributes only identities the account does not hold.
      // The offer record
      // seeds the negotiation thread only when the thread does not
      // already carry one (its own mirror record included).
      const acctFacts = o.account && o.account.stated_facts && typeof o.account.stated_facts === "object" ? o.account.stated_facts : null;
      if (acctFacts) {
        try {
          ctx._accountStatedFacts = cloneJson(acctFacts);
          const threadFacts = ctx.statedFacts && Array.isArray(ctx.statedFacts.facts) ? ctx.statedFacts.facts : [];
          // V241 LIVE-FIX LANE 2: the stored record splits its facts
          // into `facts` (the SQL-shaped list) and `keyed` (the kinds
          // the deployed account validator cannot hold in facts[] —
          // see statedFactsRecordForCommit). Both lists are the one
          // record: fold them back into the single working set the
          // router reads. A legacy record still holding keyed kinds
          // inside `facts` folds in identically and heals into the
          // two-list shape on its first changing turn.
          const acctAll = [...(Array.isArray(acctFacts.facts) ? acctFacts.facts : []), ...(Array.isArray(acctFacts.keyed) ? acctFacts.keyed : [])];
          const merged = mergeStatedFacts(acctAll, threadFacts);
          // WO-095: the thread's lastTurn marker (what the previous turn
          // recorded — the target of a "sorry, I meant X" correction)
          // is thread state and survives the account seed.
          const lastTurn = ctx.statedFacts && ctx.statedFacts.lastTurn ? ctx.statedFacts.lastTurn : null;
          if (merged.length) ctx.statedFacts = Object.assign({ facts: merged, updatedAt: (ctx.statedFacts && ctx.statedFacts.updatedAt) || acctFacts.updated_at || null }, lastTurn ? { lastTurn } : {});
          const offer = acctFacts.offer && typeof acctFacts.offer === "object" ? acctFacts.offer : null;
          if (offer && (offer.firm || offer.amount || offer.deadline)) {
            const mirrorNeg = ctx.trackStore && ctx.trackStore._careerThread && typeof ctx.trackStore._careerThread === "object" ? ctx.trackStore._careerThread.negotiation : null;
            const own = (ctx.negotiationThread && typeof ctx.negotiationThread === "object") ? ctx.negotiationThread : (mirrorNeg && typeof mirrorNeg === "object" ? mirrorNeg : null);
            if (!own || !(own.firm || own.amount || own.deadline)) {
              ctx.negotiationThread = { firm: offer.firm || null, amount: offer.amount || null, deadline: offer.deadline || null, role: offer.role || null, fromAccount: true };
            }
            if (!ctx.offer || typeof ctx.offer !== "object") {
              ctx.offer = {};
              if (offer.firm) ctx.offer.company = offer.firm;
              if (offer.amount) ctx.offer.base_salary = offer.amount;
            }
          }
        } catch { /* account seeding must never break a turn */ }
      }
      return ctx;
    }

    // Run one chat turn through the career chain, in harness order, inside
    // module 143's containment. Never throws: a chain crash is contained to
    // module 140's honest fallback text, and the failure record is kept on
    // ctx.containmentRecords for the handler to log.
    // ONBOARDING SCENARIOS (2026-10-29): every turn's outcome goes to the router's resume ask (CareerRouter.noteServedTurn),
    // whoever answered it, so a yes is bound only to the question asked last. The edge handler calls noteTurn for the
    // turns it answers before the host (cards, applies, connectors...).
    function noteTurn(ctx, intent) {
      try { if (CareerRouter && typeof CareerRouter.noteServedTurn === "function") CareerRouter.noteServedTurn(ctx, intent == null ? null : String(intent)); } catch { /* never breaks a turn */ }
    }
    function runTurn(text, ctx) {
      const out = runTurnInner(text, ctx);
      noteTurn(ctx, out && out.intent);
      return out;
    }
    function runTurnInner(text, ctx) {
      let handler = null;
      const controls = applyHostControl(text, ctx);
      if (controls) return { ...controls, action: null, handler: "CareerHostControl", contained: false, capabilities: workerCapabilities };
      // Combine repair (2026-10-15, Codex defect): the blanket gate below
      // short-circuited EVERY turn under any pause, steamrolling 142's
      // contract (pause inspection, natural-word lifting, action-only hold)
      // for router-set pauses. The gate now scopes to account-control pauses
      // only (source:"account_control" — the transactional account record);
      // router pauses fall through to dispatch, where 142's ownership-layer
      // pause control + action-only gate enforce them.
      if (ctx.globalPause && ctx.globalPause.set === true && ctx.globalPause.source === "account_control") return { reply: "Career work is paused, so I didn't start anything. Text \"resume career work\" to pick back up.", intent: "career_paused", resultStatus: "blocked", action: null, handler: "CareerHostControl", contained: false, capabilities: workerCapabilities };
      const dispatch = () => {
        let r = CareerAccess.handleChat(text, ctx);
        if (r) { handler = "CareerAccess"; return ensureEndingGuarantee(r, CareerReply); }
        r = CareerOnboarding.handleChat(text, ctx);
        if (r) { handler = "CareerOnboarding"; return ensureEndingGuarantee(r, CareerReply); }
        r = CareerRouter.handleChat(text, ctx);
        if (r) { handler = "CareerRouter"; return r; }
        r = CareerDoorstep.handleChat(text, ctx);
        if (r) { handler = "CareerDoorstep"; return ensureEndingGuarantee(r, CareerReply); }
        return null;
      };
      const containment = CareerContainment.createContainment({
        composer: CareerReply,
        sink: (rec) => { try { ctx.containmentRecords.push(rec); } catch { /* logging must never break a turn */ } },
      });
      const outcome = containment.runTurn(dispatch, {
        caseId: "live-turn",
        sessionId: ctx.threadId || "live",
      });
      if (outcome.contained) {
        return { reply: outcome.replyText, intent: null, resultStatus: null, handler, contained: true, result: null, capabilities: workerCapabilities };
      }
      let result = outcome.result;
      if (ctx.accountPersistence && result && ["career_watch_create","career_watch_manage"].includes(result.intent) && typeof result.reply === "string") {
        result = {...result,reply:result.reply.replaceAll("saved in this conversation only","saved to your owned account").replaceAll("saved watches stay paused in this conversation","saved watches stay paused on your account").replaceAll("saved watches are no longer paused in this conversation","saved watches are no longer paused on your account")};
      }
      if (result && ["application_packet", "doorstep_fill", "doorstep_status"].includes(result.intent)) {
        // Packet preparation remains available; a local doorstep is never
        // presented as an opened employer form or a connected submit leg.
        // The stamp carries this host's own capability truth: unwired it
        // is NOT_WIRED and the disclaimer leads; with a boardFor wired
        // (J8) the stamp says so and no false disclaimer is prepended —
        // these 141 results remain local preparation either way, and the
        // batch seam (155) is the wired drive path.
        result = { ...result, worker: workerCapabilities.portal_browser,
          reply: boardFor ? result.reply : `Live browser execution is not wired in this handler; no employer form has been opened or submitted.\n${result.reply}` };
      }
      return {
        reply: CareerContainment.extractReplyText(result),
        intent: (result && result.intent) || null,
        resultStatus: (result && result.resultStatus) || null,
        handler,
        contained: false,
        result,
        capabilities: workerCapabilities,
      };
    }

    // Extract the durable per-thread state from a post-turn ctx. JSON-safe
    // by construction: unserializable values are skipped, never thrown.
    function extractSnapshot(ctx) {
      // PLAIN-STOP TOMBSTONE bookkeeping (see createCareerHost): if
      // this turn ends with the user's watch stopped (a record that
      // polls nothing) or deleted, after starting from a live one,
      // the stop is recorded against this host instance; if the
      // turn ends with a live watch, any recorded stop is stale
      // intent and is cleared.
      try {
        if (ctx && ctx.userId) {
          const endWatch = ctx.alertWatchState ? watchProfileOf(ctx.alertWatchState, ctx.userId) : null;
          const startProfile = ctx._watchStartProfile || null;
          if (endWatch && watchProfileActive(endWatch.profile)) {
            watchTombstones.delete(ctx.userId);
          } else if (startProfile && watchProfileActive(startProfile)) {
            watchTombstones.set(ctx.userId, {
              at: typeof ctx.now === "number" ? ctx.now : Date.now(),
              sig: watchProfileSig(startProfile),
              profile: endWatch ? cloneJson(endWatch.profile) : null,
            });
          }
        }
      } catch { /* tombstone bookkeeping never breaks a turn */ }
      const stores = {};
      for (const key of STATE_KEYS) {
        if (ctx && ctx[key] !== undefined) {
          try { stores[key] = cloneJson(ctx[key]); } catch { /* skip */ }
        }
      }
      // DEPTH LANE A (MI-013): write the turn's stated-facts record
      // back to the ACCOUNT patch, so it survives into new threads.
      // The record written is the turn's merged record (account base
      // + this thread's statements and corrections, thread winning
      // per kind). It is written only when it actually changed
      // against what the account held at turn start — an unchanged
      // record must not churn the account row every turn — and never
      // on an erase turn (the erase rebuild owns the account then).
      if (ctx && ctx.accountPersistence && !(ctx._hostPatch && ctx._hostPatch.erase === true)) {
        try {
          const facts = ctx.statedFacts && Array.isArray(ctx.statedFacts.facts) ? ctx.statedFacts.facts : [];
          const mirrorNeg = ctx.trackStore && ctx.trackStore._careerThread && typeof ctx.trackStore._careerThread === "object" ? ctx.trackStore._careerThread.negotiation : null;
          const th = (ctx.negotiationThread && typeof ctx.negotiationThread === "object") ? ctx.negotiationThread : (mirrorNeg && typeof mirrorNeg === "object" ? mirrorNeg : null);
          const offer = th && (th.firm || th.amount || th.deadline) ? { firm: th.firm || null, amount: th.amount || null, deadline: th.deadline || null, role: th.role || null } : null;
          if (facts.length || offer) {
            const before = ctx._accountStatedFacts || null;
            // The change test compares WORKING SETS: the account's
            // stored record is its facts list plus its keyed list
            // (the split is carriage, not content), so an unchanged
            // record never churns the account row.
            const beforeFacts = before ? [...(Array.isArray(before.facts) ? before.facts : []), ...(Array.isArray(before.keyed) ? before.keyed : [])] : [];
            const changed = !before || JSON.stringify({ facts: beforeFacts, offer: before.offer || null }) !== JSON.stringify({ facts, offer });
            if (changed) {
              const record = statedFactsRecordForCommit(facts, offer, ctx.now);
              ctx._hostPatch = Object.assign({}, ctx._hostPatch || {}, { stated_facts: record });
            }
          }
        } catch { /* a failed write-back loses one turn's carry, never the turn */ }
      }
      // FEATURE 9: the profile and the tracker go back to the ACCOUNT,
      // only when they changed against what the account held at turn
      // start (compared without key order: jsonb reorders keys), never on
      // an erase turn. A record over the size bound stays with the thread
      // as before, and the thread is not stamped as account-backed.
      let accountBacked = false;
      if (ctx && ctx.accountMemory && !(ctx._hostPatch && ctx._hostPatch.erase === true)) {
        try {
          const rec = memoryOf(ctx);
          if (rec.profile || rec.tracker) {
            const before = plainObject(ctx._accountMemory) ? ctx._accountMemory : null;
            if (before && sameJson(rec.profile, before.profile) && sameJson(rec.tracker, before.tracker)) accountBacked = true;
            else {
              const memory = { v: 1, profile: rec.profile, tracker: rec.tracker, updated_at: new Date(ctx.now || Date.now()).toISOString() };
              if (JSON.stringify(memory).length <= MEMORY_MAX_BYTES) {
                ctx._hostPatch = Object.assign({}, ctx._hostPatch || {}, { memory });
                accountBacked = true;
              }
            }
          }
        } catch { /* a failed write-back leaves the thread's copy as the record, never breaks the turn */ }
      }
      // The snapshot carries the account's privacy epoch, stamped
      // the way the SQL commit stamps it (an erase turn's snapshot
      // is stamped with the NEW epoch): the resurrection guard in
      // createTurnCtx reads this stamp to tell a pre-erase snapshot
      // from a current one.
      const epoch = (ctx && Number.isSafeInteger(ctx._accountEpoch) ? ctx._accountEpoch : 0)
        + (ctx && ctx._hostPatch && ctx._hostPatch.erase === true ? 1 : 0);
      return { v: 1, scope: { userId: ctx.userId }, stores, privacy_epoch: epoch, ...(accountBacked ? { account_memory: 1 } : {}) };
    }

    return { createTurnCtx, runTurn, noteTurn, extractSnapshot, isHostControlled, STATE_KEYS: STATE_KEYS.slice() };
  }

  return { createCareerHost, STATE_KEYS: STATE_KEYS.slice() };
})();

export { CareerHost };
