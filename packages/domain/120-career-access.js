  /* Career access layer (Career Appendix A in all 3 docs; capability inventory ACCS-001..007): the pure half of
     how the career agent logs in to everything. No I/O, no provider calls, no secrets: OAuth tokens, browser
     session profiles and generated portal passwords live in the vault, held by the host (supabase/functions/
     gmail-oauth for Google; the manual-connect rail for browser sources). This module works only over RECORDS
     about access — connection rows, health-check results, vault REFERENCES (names, never values) — and turns
     them into the connected-accounts list (ACCS-002), the session health plan (ACCS-003, Appendix A.3 step 3 /
     Appendix B test T8), portal-account records (ACCS-005), handoff tickets (ACCS-006) and the login audit
     view (ACCS-007), plus the chat intent handlers the router calls (see CHAT HANDLERS at the bottom).
     Rules zero, from Appendix A: the agent never asks for a password, card or code in chat and never stores
     secrets in prompts, logs or memory; CAPTCHA/MFA/SSO blocks are a user handoff, never a solving service;
     LinkedIn is user-assisted, low-volume only, no scraping. Statuses here are records, not proof: a source is
     "connected" when a connection record says so, and the host verifies it with a real health check.
     Channel note (owner, 2026-10-12): surfaces are consumed iMessage FIRST, so every text this module builds is
     a short plain-text message that also reads fine in the app chat; nothing here is channel-specific.
     Sending identity (owner, 2026-10-12): the user's own Gmail via the career OAuth grant is THE send rail —
     CAREER_SCOPES below must stay in lockstep with supabase/functions/gmail-oauth/career.ts (a test pins both). */
  const CareerAccess = (() => {
    const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
    const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
    const CALENDAR_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
    const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
    const CAREER_SCOPES = Object.freeze([GMAIL_SCOPE, GMAIL_SEND_SCOPE, CALENDAR_FREEBUSY_SCOPE, CALENDAR_EVENTS_SCOPE]);
    const HANDOFF_TTL_MS = 30 * 60 * 1000; // a handoff link is a step the user does now, not a standing door

    const LABELS = { gmail: "Gmail", google_career: "Google (career)", google: "Google", calendar: "Google Calendar", linkedin: "LinkedIn", handshake: "Handshake", outlook: "Outlook", portal: "company portal" };
    const label = s => LABELS[String(s || "").toLowerCase()] || (String(s || "that source").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
    const iso = t => (t == null ? null : new Date(t).toISOString());
    const parseScopes = input => Array.isArray(input) ? input.map(String).filter(Boolean) : typeof input === "string" ? input.split(/[\s,]+/).filter(Boolean) : [];
    // openid / email only name the account (every Google consent asks for them since the 2026-10-26 verification
    // submission); they never change what a grant may do, so they are left out (same rule as gmail-oauth/career.ts).
    const IDENTITY_SCOPES = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);
    function scopeSet(all) {
      const scopes = all.filter(s => !IDENTITY_SCOPES.has(s));
      if (!scopes.length) return "none";
      const has = s => scopes.includes(s);
      if (has(GMAIL_SEND_SCOPE) && has(CALENDAR_FREEBUSY_SCOPE) && has(CALENDAR_EVENTS_SCOPE)) return "career";
      if (scopes.length === 1 && has(GMAIL_SCOPE)) return "readonly";
      return "partial";
    }
    // A task's named need maps to the record that satisfies it: "calendar" is satisfied by the career Google
    // grant, and "gmail" by either grant (career preferred — it is the one that can send).
    const PROVIDES = { gmail: ["gmail", "google_career"], calendar: ["google_career", "calendar"], google_career: ["google_career"], google: ["google_career"], linkedin: ["linkedin"], handshake: ["handshake"], outlook: ["outlook"] };
    const providersFor = need => PROVIDES[String(need || "").toLowerCase()] || [String(need || "").toLowerCase()];

    // ---------- ACCS-002: connected-accounts list, from status records ----------
    // Accepts connection rows ([{provider, email, scopes, connected_at}]), the gmail-oauth status object
    // (buildStatus output), or a mix flattened by the caller. Output is records only: no vault values exist here.
    function normalizeRows(input) {
      if (!input) return [];
      if (Array.isArray(input)) return input.slice();
      const rows = [];
      if (input.legacy || input.career) { // gmail-oauth status object
        if (input.legacy && input.legacy.connected) rows.push({ provider: "gmail", email: input.legacy.email, scopes: input.legacy.scopes, connected_at: input.legacy.connected_at });
        if (input.career && input.career.connected) rows.push({ provider: "google_career", email: input.career.email, scopes: input.career.scopes, connected_at: input.career.connected_at });
        return rows;
      }
      if (input.provider) return [input];
      return [];
    }
    function connectedAccounts(input) {
      const rows = normalizeRows(input);
      const accounts = [], seen = new Set();
      for (const r of rows) {
        const provider = String(r.provider || "").toLowerCase(); if (!provider || seen.has(provider)) continue; seen.add(provider);
        const scopes = parseScopes(r.scopes);
        accounts.push({ source: provider, provider, label: label(provider), email: r.email || null, scopes, scope_set: scopeSet(scopes), connected_at: r.connected_at || null });
      }
      // Gmail is ONE source to the user, held by up to two grants: the career grant upgrades the legacy
      // read-only one (read + send), it is not a second account. Merge them into a single Gmail entry —
      // regression: the first build listed "Gmail (read-only)" and a separate "Google (career)" line while
      // the career grant was connected, telling the user send was unavailable when it was the send rail.
      const legacy = accounts.find(a => a.provider === "gmail"), careerRow = accounts.find(a => a.provider === "google_career");
      if (legacy && careerRow) {
        const mergedScopes = [...new Set([...legacy.scopes, ...careerRow.scopes])];
        Object.assign(legacy, { scopes: mergedScopes, scope_set: scopeSet(careerRow.scopes), email: careerRow.email || legacy.email, via: "google_career" });
        accounts.splice(accounts.indexOf(careerRow), 1);
      } else if (careerRow) {
        Object.assign(careerRow, { source: "gmail", label: label("gmail") });
      }
      // Calendar is a source the user asks about, even though its grant is the career Google row.
      const career = accounts.find(a => a.provider === "google_career" || a.via === "google_career");
      if (career && career.scopes.some(s => s.includes("/calendar"))) {
        accounts.push({ source: "calendar", provider: "google_career", label: label("calendar"), email: career.email, scopes: career.scopes.filter(s => s.includes("/calendar")), scope_set: "career", connected_at: career.connected_at, via: "google_career" });
      }
      const gmail = accounts.find(a => a.source === "gmail");
      return {
        accounts, count: accounts.length,
        gmail: gmail ? { connected: true, scope_set: gmail.scope_set, can_send: gmail.scopes.includes(GMAIL_SEND_SCOPE), email: gmail.email } : { connected: false, scope_set: "none", can_send: false, email: null },
        calendar_connected: !!accounts.find(a => a.source === "calendar"),
        connected_email: (gmail && gmail.email) || (accounts[0] && accounts[0].email) || null,
        granted_scopes: [...new Set(accounts.flatMap(a => a.scopes))],
        text: accounts.length
          ? accounts.map(a => `${a.label}: connected${a.email ? ` as ${a.email}` : ""}${a.source === "gmail" || a.provider === "gmail" ? (a.scope_set === "readonly" ? " (read-only)" : a.scope_set === "career" ? " (read + send)" : "") : a.source === "calendar" ? " (free/busy + events, via your Google grant)" : ""}`).join("\n")
          : "Nothing is connected yet. Say \"connect my Google\" to start.",
      };
    }

    // ---------- ACCS-003: session health planner (Appendix A.3 step 3; replay of Appendix B test T8) ----------
    // health: [{source|provider, status: "ok"|"expired"|"missing"|"unknown", checked_at}] — one record per source
    // the host health-checked. tasks: [{id, title?, needs: [source, ...]}]. A task pauses only when a source it
    // needs is expired/missing (or has no ok record at all); every other task keeps running. Exactly ONE re-auth
    // message per affected source, however many tasks need it, in Appendix A.3 step 2's words.
    function reauthMessage(source, secureLink) {
      const base = `I need access to ${label(source)} to do this. Open this, sign in, done in 30 seconds. I never see your password.`;
      return secureLink ? `${base} ${secureLink}` : base;
    }
    function healthPlan(input) {
      const o = input || {}, health = o.health || o.records || [], tasks = o.tasks || [];
      const byProvider = {};
      for (const h of health) {
        const p = String(h.provider || h.source || "").toLowerCase(); if (!p) continue;
        byProvider[p] = { status: String(h.status || "unknown").toLowerCase(), checked_at: h.checked_at || h.at || null };
      }
      const perSource = {}, needOf = {}; // source-as-asked -> {status, providers}
      const needs = [...new Set(tasks.flatMap(t => (t.needs || []).map(n => String(n).toLowerCase())))];
      for (const need of needs) {
        const providers = providersFor(need);
        // ok if ANY providing grant is ok; expired/missing only when every providing grant is bad (or none checked ok).
        let status = "missing";
        if (providers.some(p => byProvider[p] && byProvider[p].status === "ok")) status = "ok";
        else if (providers.some(p => byProvider[p] && byProvider[p].status === "expired")) status = "expired";
        else if (providers.some(p => byProvider[p])) status = String(byProvider[providers.find(p => byProvider[p])].status);
        perSource[need] = { status, providers, checked_at: (providers.map(p => byProvider[p]).find(Boolean) || {}).checked_at || null };
        needOf[need] = perSource[need].status;
      }
      const paused = [], running = [];
      for (const t of tasks) {
        const blockedBy = (t.needs || []).map(n => String(n).toLowerCase()).filter(n => needOf[n] !== "ok");
        if (blockedBy.length) paused.push({ id: t.id, title: t.title || null, blocked_by: blockedBy }); else running.push({ id: t.id, title: t.title || null });
      }
      const badSources = [...new Set(paused.flatMap(p => p.blocked_by))];
      const linkFor = typeof o.secureLinkFor === "function" ? o.secureLinkFor : () => o.secureLink || null;
      // One message per dead GRANT, not per need-name: Gmail and Calendar are two needs satisfied by
      // the SAME career Google grant, so a dead grant produced two near-identical nags ("access to
      // Gmail…", "access to Google Calendar…") in the first build — BUG-005, found by SC-004/SC-020.
      // Group blocked needs by their dead provider set; the message names that provider.
      const groups = new Map();
      for (const need of badSources) {
        const dead = providersFor(need).filter(p => byProvider[p] && byProvider[p].status !== "ok");
        const key = dead.length ? dead.slice().sort().join("+") : need;
        if (!groups.has(key)) groups.set(key, { source: dead.length === 1 ? dead[0] : need, needs: [] });
        groups.get(key).needs.push(need);
      }
      const messages = [...groups.values()].map(g => ({ source: g.source, needs: g.needs, text: reauthMessage(g.source, linkFor(g.source)) }));
      return { per_source: perSource, paused, running, reauth: messages, messages: messages.map(m => m.text), one_message_per_source: true };
    }

    // ---------- ACCS-005: portal-account records (Appendix A.1 method 4) ----------
    // Records only. The generated password itself NEVER enters this module: the caller stores it in the vault
    // and passes only the vault reference (a name). A record handed a secret-shaped field is refused outright,
    // so no code path can serialize a portal password into a list, a log or a chat answer.
    const SECRET_FIELDS = ["password", "generated_password", "secret", "token", "credential", "credentials", "value"];
    function portalRecord(input) {
      const o = input || {};
      for (const f of SECRET_FIELDS) if (o[f] != null && o[f] !== "") return { ok: false, code: "secret_in_record", text: "Portal records hold the vault reference only, never the password itself. Store the generated password in the vault and pass its reference." };
      const company = String(o.company || "").trim();
      const alias = String(o.alias_email || o.aliasEmail || "").trim();
      const ref = String(o.password_vault_ref || o.vault_ref || o.passwordVaultRef || "").trim();
      if (!company) return { ok: false, code: "company_required", text: "A portal record names its company." };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alias)) return { ok: false, code: "alias_required", text: `A portal record for ${company} needs its unique alias email.` };
      if (!ref || /\s/.test(ref) || ref === alias) return { ok: false, code: "vault_ref_required", text: `A portal record for ${company} needs the vault reference its generated password is stored under (a name, not the password).` };
      return { ok: true, record: { company, company_key: company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), alias_email: alias, password_vault_ref: ref, username: o.username ? String(o.username) : alias, created_at: iso(o.created_at || o.now) || null, source: "portal" } };
    }
    function portalList(records) {
      const rows = (records || []).map(r => r && r.record ? r.record : r).filter(r => r && r.company);
      return {
        companies: rows.map(r => ({ company: r.company, alias_email: r.alias_email, password_vault_ref: r.password_vault_ref, created_at: r.created_at || null })),
        count: rows.length,
        text: rows.length ? rows.map(r => `${r.company}: portal account as ${r.alias_email} (password in your vault)`).join("\n") : "No company portal accounts yet. One is created, with your OK, the first time an application needs it. Tell me if you'd like one set up for a specific company now.",
      };
    }

    // ---------- ACCS-006: user-assisted handoff tickets (Appendix A.1 method 5, A.3 step 4) ----------
    // A challenge (CAPTCHA / MFA / SSO / device check) stops the run. The ticket carries the screenshot
    // REFERENCE and a single-use resume token; resume validates the ticket, never the user's credentials.
    // There is deliberately no "solve" path and no field for a code or a password.
    const CHALLENGES = Object.freeze(["captcha", "mfa", "sso", "device_verification", "sign_in"]);
    let ticketSeq = 0;
    function createHandoff(input) {
      const o = input || {};
      const source = String(o.source || "").toLowerCase();
      const challenge = String(o.challenge || "").toLowerCase();
      if (!source) return { ok: false, code: "source_required", text: "A handoff names the source that blocked the run." };
      if (!CHALLENGES.includes(challenge)) return { ok: false, code: "bad_challenge", text: `A handoff is only for a step the user must do themselves (${CHALLENGES.join(", ")}).` };
      if (!o.screenshot_ref && !o.screenshotRef) return { ok: false, code: "screenshot_required", text: "A handoff carries a screenshot reference so the user can see exactly which step is theirs." };
      const now = o.now != null ? Number(o.now) : Date.now();
      const token = o.resumeToken || o.resume_token || `hrt_${(++ticketSeq).toString(36)}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
      const ticket = { id: o.id || `handoff_${now.toString(36)}_${++ticketSeq}`, source, challenge, screenshot_ref: o.screenshot_ref || o.screenshotRef, run_id: o.run_id || o.runId || null, resume_token: token, status: "awaiting_user", created_at: iso(now), expires_at: iso(now + (o.ttl_ms || HANDOFF_TTL_MS)) };
      return { ok: true, ticket, text: `${label(source)} needs a step only you can do (${challenge.replace(/_/g, " ")}). Open this link, finish that one step, and the run picks up where it left off. I never see your password or code.` };
    }
    function resumeHandoff(ticket, input) {
      const o = input || {}, now = o.now != null ? Number(o.now) : Date.now();
      if (!ticket || !ticket.resume_token) return { ok: false, code: "no_ticket", text: "There is no handoff to resume." };
      if (ticket.status === "resumed") return { ok: false, code: "already_used", text: "That handoff was already used. A fresh one is created if the run blocks again." };
      if (ticket.status !== "awaiting_user") return { ok: false, code: "not_waiting", text: "That handoff is no longer waiting on you." };
      if (ticket.expires_at && now > Date.parse(ticket.expires_at)) return { ok: false, code: "expired", ticket: { ...ticket, status: "expired" }, text: "That handoff link expired. The run creates a fresh one when it reaches that step again." };
      if (String(o.resume_token || o.resumeToken || "") !== String(ticket.resume_token)) return { ok: false, code: "bad_token", text: "That resume link does not match this handoff. Nothing was resumed." };
      return { ok: true, ticket: { ...ticket, status: "resumed", resumed_at: iso(now), resume_token: null }, run_id: ticket.run_id, source: ticket.source, text: `Done — resuming the ${label(ticket.source)} run where it stopped.` };
    }

    // ---------- ACCS-007: login audit log (Appendix A.3 step 7) ----------
    // Every login-requiring action: {source, at, what}. Entries are records the host writes as it acts; this
    // module only shapes and renders them, and refuses secret-shaped fields for the same reason as portals.
    function auditEntry(input) {
      const o = input || {};
      for (const f of SECRET_FIELDS) if (o[f] != null && o[f] !== "") return { ok: false, code: "secret_in_record", text: "Audit entries record what was done, never a secret value." };
      const source = String(o.source || "").toLowerCase(), what = String(o.what || o.action || "").trim();
      if (!source || !what) return { ok: false, code: "entry_incomplete", text: "An audit entry names its source and what was done." };
      return { ok: true, entry: { source, at: iso(o.at || o.now) || iso(Date.now()), what, outcome: o.outcome ? String(o.outcome) : null } };
    }
    function auditLog(entries) {
      const rows = (entries || []).map(e => e && e.entry ? e.entry : e).filter(e => e && e.source && e.what)
        .map(e => ({ source: String(e.source).toLowerCase(), at: e.at || null, what: String(e.what), outcome: e.outcome || null }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return { entries: rows, count: rows.length, text: rows.length ? rows.map(e => `${e.at} — ${label(e.source)}: ${e.what}${e.outcome ? ` (${e.outcome})` : ""}`).join("\n") : "No access events have been recorded yet (0 events). When sources connect, disconnect, or ask for re-authentication, each shows here — tell me if you want the current connected-accounts list instead." };
    }

    // ---------- ACCS-004: browser-source connect plan (records/plans only — the live window is the host's) --
    // LinkedIn / Handshake connect by the user signing in ONCE inside a shown cloud-browser session; the agent
    // never sees the password. This returns the plan + exact user text; it does not open anything itself.
    function browserConnectPlan(source) {
      const s = String(source || "").toLowerCase();
      if (!["linkedin", "handshake"].includes(s)) return { ok: false, code: "not_a_browser_source", text: `${label(s)} does not connect this way.` };
      return {
        ok: true, source: s, method: "cloud_browser_user_sign_in", agent_sees_password: false, session_stored_as: "vault_reference_only",
        risk_note: s === "linkedin" ? "LinkedIn's terms prohibit automation and scraping, and a restriction would land on your account. Default here is user-assisted and low-volume only: no bulk scraping, no mass connection requests." : "Handshake sign-in goes through your school SSO; you do that step yourself in the shown session.",
        text: reauthMessage(s, null).replace("to do this", `to connect ${label(s)}`),
      };
    }

    // ---------- CHAT HANDLERS (ACCS-001/002/007 surfaces; iMessage first, channel-agnostic) ----------
    // The router calls CareerAccess.handleChat(text, ctx) — or a single handler from chatHandlers — with:
    //   ctx.statusRecords  connection rows or the gmail-oauth status object (for connected / disconnect views)
    //   ctx.portalRecords  portal keeper records        ctx.auditEntries  audit log entries
    //   ctx.secureLinkFor(source) -> the host's secure connect link (vault link flow; never built here)
    //   ctx.health, ctx.tasks    for the health-plan answer
    // A handler never claims an edge action happened: connect returns the ACTION the host must run against
    // gmail-oauth ({edge_action:"start_career"} plus the secure link when the host supplied one), and
    // disconnect returns {edge_action:"disconnect", source} for the host to execute and confirm.
    function handleConnectGoogle(_text, ctx) {
      const c = ctx || {};
      const link = typeof c.secureLinkFor === "function" ? c.secureLinkFor("google_career") : null;
      // SC-286 (A5): the result must be TYPED with a doorstep payload — the
      // consent card plus the self-test plan — not a bare reply with
      // resultStatus null. The connection itself is the user's tap on
      // Google's page; nothing here claims it happened.
      const doorstepPayload = {
        kind: "connect_google_doorstep", edge_action: "start_career", scopes: [...CAREER_SCOPES],
        send_rail: "user_gmail_oauth", requires_user_tap: true, committed: false,
        self_test: { test_email: "one test email to your own inbox", test_event: "one test calendar event", runs_after: "the consent tap lands" },
      };
      return {
        intent: "connect_google", family: "access", edge_action: "start_career", scopes: [...CAREER_SCOPES], send_rail: "user_gmail_oauth",
        resultStatus: "awaiting_user", artifact: doorstepPayload, payload: doorstepPayload, sends: 0,
        reply: `Connect your Google once and I can read and send from your own Gmail and use your Calendar (free/busy plus events). One consent click on Google's own page, and no password ever in chat.${link ? ` ${link}` : ""} Next step — approve on Google's page and I will run the self-test: one test email to your own inbox and one test event on your calendar.`,
      };
    }
    // SC-287 (A4): a LinkedIn connection asked for the ZERO-RISK way — the
    // user's own data export, uploaded and parsed — is NOT the cloud-browser
    // sign-in source. It wins over connect_browser_source whenever the turn
    // names the export path, and the reply may never carry a sign-in
    // instruction (R-B11 is an S0 tripwire).
    function handleLinkedInExport(_text, ctx) {
      const c = ctx || {};
      let records = Array.isArray(c.linkedinExportConnections) ? c.linkedinExportConnections
        : Array.isArray(c.exportConnections) ? c.exportConnections : null;
      // IB-2b: the raw export dialects (the CSV / pasted text / forwarded
      // email the intake lane defines) fulfill this intent too — run
      // 146 and WRITE the graph store before answering. The old shape
      // spoke "parsed into your graph" while writing nothing
      // (claim-to-state). The write mirrors 142's IB-2 merge exactly.
      if (!records && (c.linkedinConnectionsCsv || c.pastedText || c.forwardedEmail) && c.profile) {
        try {
          const Intake = (() => { try { return typeof CareerIntake !== "undefined" ? CareerIntake : require("./146-career-intake.js"); } catch { return null; } })();
          if (Intake && Intake.intake) {
            const input = {};
            if (c.pastedText) input.pastedText = c.pastedText;
            if (c.linkedinConnectionsCsv) input.linkedinConnectionsCsv = c.linkedinConnectionsCsv;
            if (c.forwardedEmail) input.forwardedEmail = c.forwardedEmail;
            const r = Intake.intake(input, { knownDepartures: c.knownDepartures || [] });
            const prof = c.profile;
            const prior = Array.isArray(prof._careerGraphPeople) ? prof._careerGraphPeople : [];
            const key = (p) => `${String((p && (p.full_name || p.name)) || "").toLowerCase()}|${String((p && (p.current_firm || p.company)) || "").toLowerCase()}`;
            const byKey = new Map(prior.map((p) => [key(p), p]));
            for (const rec of r.records || []) {
              const k = key(rec);
              const old = byKey.get(k);
              byKey.set(k, old ? Object.assign({}, rec, { interactions: old.interactions || rec.interactions, stage: old.stage || rec.stage, last_contact_at: old.last_contact_at || rec.last_contact_at }) : rec);
            }
            prof._careerGraphPeople = [...byKey.values()];
            records = r.records || [];
          }
        } catch { records = null; }
      }
      const parsed = records ? { connections_parsed: records.length } : null;
      const payload = { kind: "linkedin_export_ingest", source: "linkedin_data_export", requires_user_upload: true, sign_in_required: false, parsed };
      return {
        intent: "profile_export", family: "access", resultStatus: "awaiting_user",
        ingest: { source: "linkedin_data_export", sign_in_required: false, password_seen: false, status: records ? "parsed" : "awaiting_file" },
        artifact: payload, payload, sends: 0,
        reply: records
          ? `Your LinkedIn export is in: ${records.length} connections parsed into your graph, with names, firms, and roles kept exactly as the file states them. No LinkedIn credentials pass through me, and I never see your password. Next step — ask me who you know at any firm and I will rank the warm paths. Tell me a firm and I will rank who you know there.`
          : "Your LinkedIn data export is the zero-risk path in: request the data download inside LinkedIn, then upload the file here and I will parse your connections and profile into your graph. No LinkedIn credentials pass through me, and I never see your password. Next step — tell me when the file is uploaded and I will show you exactly what it adds.",
      };
    }
    function handleConnected(_text, ctx) {
      const r = connectedAccounts((ctx || {}).statusRecords);
      return { intent: "connected_accounts", family: "access", resultStatus: "completed", sends: 0, accounts: r.accounts, calendar_connected: r.calendar_connected, connected_email: r.connected_email, granted_scopes: r.granted_scopes, reply: r.text };
    }
    function handleDisconnect(text, ctx) {
      // "disconnect all my accounts" / "disconnect everything" targets EVERY source (the edge
      // disconnectPlan's "all" branch removes both Google grants and their vault entries). The first
      // build parsed the tail as a source name ("all_my_accounts") and would have deleted nothing
      // the user meant — BUG-003, found by SC-015.
      if (/\bdisconnect\b[^.]*\b(all|everything)\b/.test(String(text || "").toLowerCase())) {
        return {
          intent: "disconnect", family: "access", resultStatus: "awaiting_user", sends: 0, edge_action: "disconnect", source: "all",
          payload: { kind: "disconnect_doorstep", source: "all", committed: false }, artifact: { kind: "disconnect_doorstep", source: "all", committed: false },
          reply: "Disconnecting everything deletes every connected source's session and tokens in the vault, and writes a consent log entry. The host performs the deletion and confirms it here. Next step — say the word and the host runs it, then shows you the empty connected list.",
        };
      }
      // SC-291 defect (Career OS wave): the source comes from the
      // LEADING segment of the ask (the quoted command) — the old
      // end-anchored regex broke on the ask's trailing description
      // and fell back to Gmail, so "Disconnect LinkedIn" answered
      // "Disconnecting Gmail…". This handler deletes nothing itself:
      // the host executes and confirms; the result is awaiting_user.
      const lead = String(text || "").split(/\s+[—–]\s+|;|:/)[0];
      const m = lead.toLowerCase().match(/disconnect\s+(?:my\s+)?([a-z_]+)/);
      const raw = (m ? m[1] : "") || "gmail";
      const source = raw === "google" || raw === "career" || raw === "google_career" ? "google_career" : raw === "calendar" || raw === "google_calendar" ? "calendar" : raw;
      const after = connectedAccounts((ctx || {}).statusRecords).accounts.filter((a) => a.source !== source && a.provider !== source).map((a) => a.label);
      const afterLine = after.length ? `Still connected afterwards: ${after.join(", ")}.` : "Nothing else stays connected afterwards.";
      const deletes = source === "linkedin"
        ? "deleting the parsed connection record and the data stored from your export — LinkedIn was never a credential here, so there are no tokens of yours to revoke"
        : source === "calendar"
          ? "removing the career Google grant it lives in (a separate read-only Gmail connection stays)"
          : "deleting its session and tokens in the vault";
      const payload = { kind: "disconnect_doorstep", source, committed: false, deletes: source === "linkedin" ? ["parsed connection record", "stored export data"] : ["session", "vault tokens"], performed_by: "host", confirmed: false };
      return {
        intent: "disconnect", family: "access", resultStatus: "awaiting_user", sends: 0, edge_action: "disconnect", source,
        accounts_after: after, disconnection: payload, payload, artifact: payload,
        reply: `Disconnecting ${label(source)} means ${deletes}. Nothing is deleted by this message alone — the host confirms the deletion here once it has run. ${afterLine} Next step — say the word and the host runs it, then shows the updated connected list.`,
      };
    }
    function handleAccessLog(_text, ctx) {
      const r = auditLog((ctx || {}).auditEntries);
      // SC-292: the bare "No login-requiring actions yet." tripped the
      // refusal shape and trailed off — report the audit properly:
      // count + period + a concrete closing next step.
      const reply = r.entries.length
        ? `${r.text} Next step — tell me a source and I will expand its entries line by line.`
        : "Your access log for this week is empty: 0 login-requiring actions are on record. Every login-requiring action is listed here with its source and time as it happens, so an empty week is itself the report. Next step — ask again after the first connected action runs, or name a source and I will check its record first?";
      return { intent: "access_log", family: "access", resultStatus: "completed", sends: 0, entries: r.entries, reply };
    }
    function handlePortalList(_text, ctx) {
      const r = portalList((ctx || {}).portalRecords);
      return { intent: "portal_accounts", family: "access", resultStatus: "completed", sends: 0, companies: r.companies, reply: r.text };
    }
    function handleConnectBrowser(text, ctx) {
      const source = /handshake/i.test(text || "") ? "handshake" : "linkedin";
      const plan = browserConnectPlan(source);
      const link = plan.ok && ctx && typeof ctx.secureLinkFor === "function" ? ctx.secureLinkFor(source) : null;
      const payload = { kind: "connect_browser_doorstep", source, committed: false, plan };
      return { intent: "connect_browser_source", family: "access", resultStatus: "awaiting_user", sends: 0, ...plan, artifact: payload, payload, reply: plan.ok ? `${plan.text}${link ? ` ${link}` : ""}${plan.risk_note ? ` ${plan.risk_note}` : ""} Next step — sign in once in the shown session and the agent reuses it from there; shall I open the session now?` : plan.text };
    }
    function handleSessionHealth(_text, ctx) {
      const c = ctx || {};
      const plan = healthPlan({ health: c.health || [], tasks: c.tasks || [] });
      const msgs = (plan.messages || []).slice(0, 2).join(" ");
      return {
        intent: "session_health", family: "access", resultStatus: "completed", sends: 0, health: plan,
        // SC-289: the next step closes the bubble — it used to sit
        // mid-text with a plan dump trailing after it.
        reply: msgs ? `${msgs} Next step — reconnect that one source and the paused tasks pick up where they stopped; want me to stage the reconnect for that source?` : "When a session dies mid-run, only the tasks that depend on that one source pause; everything else continues, and you get exactly one re-auth message for the paused source — never a flood. Next step — reconnect that one source and the paused tasks pick up where they stopped; want me to stage the reconnect for that source?",
      };
    }
    function sha256Hex(str) {
      try { return require("node:crypto").createHash("sha256").update(str).digest("hex"); } catch { return null; }
    }
    function handleCaptchaHandoff(_text, ctx) {
      const c = ctx || {};
      const nowMs = c.now != null ? Number(c.now) : Date.now();
      // Resume turn (captcha pack §2): the token arrives via the
      // handoff LINK (host-surfaced as ctx.resumeToken), never chat
      // text. A replayed token is refused with zero side effects.
      if (c.pendingHandoff && c.resumeToken) {
        const out = resumeHandoff(c.pendingHandoff, { resume_token: c.resumeToken, now: nowMs });
        if (out && out.ok) {
          const rp = { kind: "captcha_handoff_resumed", family: "application", run_id: out.run_id || c.pendingHandoff.run_id || null, source: out.source || c.pendingHandoff.source, ticket_status: "resumed", committed: false, submits: 0 };
          return { intent: "captcha_handoff", family: "access", resultStatus: "completed", sends: 0, submits: 0, artifact: rp, payload: rp, reply: `${out.text} The application itself continues from the exact field it stopped on — resuming the handoff submits nothing by itself. Next step — watch the run; it stops again only if another step is yours alone.` };
        }
        const code = (out && out.code) || "resume_refused";
        return { intent: "captcha_handoff", family: "access", resultStatus: "blocked", sends: 0, submits: 0, artifact: null, payload: null, doorstep: null, guard_refusal: { code, reason: (out && out.text) || "the resume was refused", unblock: "a fresh handoff is created if the run blocks again" }, reply: (out && out.text) || "That handoff cannot be resumed." };
      }
      // Stop turn (pack §2): a 149/150 captcha stop forwarded by the
      // host mints the ACCS-006 ticket; 120 assembles the 141-shaped
      // doorstep record (149 emits none). gap is null ONLY when a
      // ticket exists — otherwise the gap-marked honest shape.
      const stop = c.captchaStop || null;
      let ticket = null, mintNote = null;
      if (stop) {
        const made = createHandoff({ source: stop.source || "portal", challenge: stop.challenge || "captcha", screenshot_ref: stop.screenshot_ref || stop.screenshotRef || null, run_id: stop.run_id || stop.runId || null, now: nowMs });
        if (made && made.ok) ticket = made.ticket; else mintNote = (made && made.text) || "the ticket could not be minted";
      }
      if (ticket) {
        const payload = { kind: "captcha_handoff_doorstep", family: "application", committed: false, submits: 0, ticket,
          handoff: { url: stop.posting_url || stop.url || null, link_kind: "user_tap", expires_at: ticket.expires_at },
          resume: { mode: "single_use_token", replay: "refused (already_used)", run_id: ticket.run_id } };
        const stepLog = [
          { step: 1, action: "captcha_stop_recorded", field: "challenge", result: ticket.challenge },
          { step: 2, action: "handoff_ticket_minted", field: "ticket", result: ticket.id },
          { step: 3, action: "handoff_link_armed", field: "handoff.url", result: payload.handoff.url },
        ];
        const hash = sha256Hex(JSON.stringify(payload));
        const doorstep = { family: "application", driven_by: "agent", gap: null, state: "AWAITING_COMMIT", committed: false, step_log: stepLog, payload, payload_sha256: hash, proof: { step_log: stepLog, payload_snapshot: payload, payload_sha256: hash } };
        return { intent: "captcha_handoff", family: "access", resultStatus: "awaiting_user", sends: 0, submits: 0, artifact: payload, payload, doorstep,
          card: { title: `Your tap needed — ${String(ticket.challenge).toUpperCase()}`, source: ticket.source, challenge: ticket.challenge, expires_at: ticket.expires_at },
          reply: `A CAPTCHA is a step only you can do: the run stopped at that field and a single-use handoff ticket is minted for ${label(ticket.source)}. Tap the handoff link, finish that one step on the real page, and the run resumes right where it stopped — the link expires at ${ticket.expires_at} and works exactly once. No solver services are used, ever — that is a hard rule, not a preference. Next step — tap the handoff link when you are ready and the application continues from the exact field it stopped on.` };
      }
      const gap = stop ? `ticket not minted: ${mintNote || "the handoff could not be created"}` : "ticket not minted: no captcha stop recorded for this session";
      const payload = { kind: "captcha_handoff_doorstep", family: "application", committed: false, submits: 0, ticket: null, handoff: { state: "awaiting_stop_record" }, resume: { mode: "single_use_token", replay: "refused (already_used)", run_id: null } };
      const stepLog = [{ step: 1, action: "captcha_ask_received", field: "captchaStop", result: "no stop recorded" }];
      const hash = sha256Hex(JSON.stringify(payload));
      const doorstep = { family: "application", driven_by: "agent", gap, state: "AWAITING_COMMIT", committed: false, step_log: stepLog, payload, payload_sha256: hash, proof: { step_log: stepLog, payload_snapshot: payload, payload_sha256: hash } };
      return {
        intent: "captcha_handoff", family: "access", resultStatus: "awaiting_user", sends: 0, submits: 0, artifact: payload, payload, doorstep,
        reply: "A CAPTCHA is a step only you can do: I hand you the tap on the real page, you finish that one step, and the run resumes right where it stopped. No solver services are used, ever — that is a hard rule, not a preference. No stop is recorded for this session yet, so no ticket exists to hand you — the moment a run actually stops on one, the ticket is minted and the link is yours. Next step — tap the handoff link when it appears and the application continues from the exact field it stopped on.",
      };
    }
    // Routing robustness (wedge paraphrase battery): repair a token only
    // when exactly one access-vocabulary word is one adjacent transposition
    // away ("connetc" -> "connect", "gmali" -> "gmail"). Routing copy only.
    const ACCESS_VOCAB = new Set(["connect", "disconnect", "gmail", "google", "calendar", "linkedin", "handshake", "export", "upload", "accounts", "account", "consent", "password", "portal", "access", "audit", "actions", "login", "browser", "source", "session", "event", "email"]);
    function detypoAccess(text) {
      return String(text || "").replace(/[A-Za-z]{5,}/g, (w) => {
        const lw = w.toLowerCase();
        if (ACCESS_VOCAB.has(lw)) return w;
        let hit = null;
        for (let i = 0; i < lw.length - 1; i++) {
          const cand = lw.slice(0, i) + lw[i + 1] + lw[i] + lw.slice(i + 2);
          if (ACCESS_VOCAB.has(cand)) { if (hit && hit !== cand) return w; hit = cand; }
        }
        if (!hit) return w;
        return /^[A-Z]/.test(w) ? hit.charAt(0).toUpperCase() + hit.slice(1) : hit;
      });
    }
    const chatHandlers = { connect_google: handleConnectGoogle, connected_accounts: handleConnected, disconnect: handleDisconnect, access_log: handleAccessLog, portal_accounts: handlePortalList, connect_browser_source: handleConnectBrowser, profile_export: handleLinkedInExport, session_health: handleSessionHealth, captcha_handoff: handleCaptchaHandoff };
    function handleChat(text, ctx) {
      text = detypoAccess(text); // routing copy only
      const t = String(text || "").trim().toLowerCase();
      if (/^["“']?\s*disconnect\b/.test(t)) return chatHandlers.disconnect(text, ctx);
      if (/\bcaptcha\b/.test(t)) return chatHandlers.captcha_handoff(text, ctx);
      if (/\bsession (dies|died|expired|killed|death)\b|\breauth\b|\bre-auth\b/.test(t)) return chatHandlers.session_health(text, ctx);
      // The data-EXPORT path must win over the browser-source path whenever
      // the turn names it (SC-287): LinkedIn + export + a bring-it-in verb.
      if (/\b(linkedin|handshake)\b/.test(t) && /\bexport\b/.test(t) && /\b(connect|link|upload|uploaded|import|parse|parsed|add|bring)\b/.test(t)) return chatHandlers.profile_export(text, ctx);
      if (/\b(connect|link)\b.*\b(linkedin|handshake)\b/.test(t)) return chatHandlers.connect_browser_source(text, ctx);
      // "I sign in once to Handshake; the agent reuses that session" — the
      // user's own signed-in session IS the browser-source plan (SC-288).
      if (/\bcloud[ -]?browser\b|\bsign in once\b|\bi sign in\b[^.]*\b(handshake|linkedin)\b|\breuse (that|the|my) session\b/.test(t)) return chatHandlers.connect_browser_source(text, ctx);
      if (/\bconnect\b.*\b(google|gmail|calendar)\b/.test(t)) return chatHandlers.connect_google(text, ctx);
      // The ledger's own phrasings route too, not just the canonical ones: "what accounts do I have
      // connected?" and "show me everything you've accessed for me" both fell through to null in the
      // first build — BUG-002 (SC-002) and BUG-004 (SC-005), found by the F01 scenario runs.
      if (/\bwhat accounts\b[^.]*\bconnected\b|\bconnected accounts\b|\bwhat(?:'s| is) connected\b|\bwhich accounts\b[^.]*\bconnected\b/.test(t)) return chatHandlers.connected_accounts(text, ctx);
      if (/\bportal accounts\b|\bwhich companies.*accounts\b/.test(t)) return chatHandlers.portal_accounts(text, ctx);
      if (/\baccess log\b|\blogin log\b|\bshow my access\b|\bshow me everything you(?:'ve| have) accessed\b|\bwhat have you accessed\b|\bevery action\b[^.]*\blogin\b|\bactions? this week\b|\baudit view\b/.test(t)) return chatHandlers.access_log(text, ctx);
      return null; // not an access-layer message: the router falls through to its other handlers
    }

    return {
      GMAIL_SCOPE, GMAIL_SEND_SCOPE, CALENDAR_FREEBUSY_SCOPE, CALENDAR_EVENTS_SCOPE, CAREER_SCOPES, HANDOFF_TTL_MS, CHALLENGES,
      label, parseScopes, scopeSet, connectedAccounts, reauthMessage, healthPlan,
      portalRecord, portalList, createHandoff, resumeHandoff, auditEntry, auditLog, browserConnectPlan,
      chatHandlers, handleChat,
    };
  })();
  if (typeof module !== "undefined" && module.exports) module.exports = CareerAccess;
