// Upmore agent-chat edge function.
// POST /functions/v1/agent-chat  { thread_id?, message }
// Auth: Supabase JWT in Authorization header.
// Flow: load profile + thread + relevant verified routes → Anthropic →
// grounding post-check → save + return reply.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import {
  SYSTEM_PROMPT,
  renderRouteCards,
  checkGrounding,
  isDebunkReply,
  findFalseNoRouteClaim,
  appendSources,
  SAFE_FALLBACK,
  FINANCE_SAFE_FALLBACK,
  BILLING_SAFE_FALLBACK,
  SETTLEMENT_SAFE_FALLBACK,
  isBillingContext,
  isSettlementContext,
  SCAM_FALLBACK,
  RouteCard,
} from "./_shared/agent.ts";
import { tryCapabilities, tryReminderIntent, isGenericReminderRequest, tryTrialTracker, prettyTrialDate, tryGamblingGuard, tryFakeDocGuard, tryContestGuard, tryCryptoGuard, tryFakeReviewGuard, tryTaxFraudGuard, tryPrivacyGuard, tryScamGuard, trySyspromptGuard, tryGiftRewardSafe, tryServerGuards, type CapCtx } from "./_shared/capabilities.ts";
import { renderFinanceFacts, financeFactMatch, financeModeNudge, tryFinanceFact } from "./_shared/finance_facts.ts";
// Learning-from-mistakes helpers (2026-09-28): the SAME pure functions the
// real-trust fixtures exercise. index.ts calls them, never re-implements.
import {
  lessonRelevant,
  detectUserCorrection,
  renderLessonsBlock,
  type ChatLesson,
} from "./_shared/lessons.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 400; // tight budget: short, basic replies

const MAX_MESSAGE_LEN = 4000; // M2: cap input size — output already capped at MAX_TOKENS

// L1: CORS allowlist (was: Access-Control-Allow-Origin: *). Every non-OPTIONS
// path requires a valid user JWT, but a wildcard would let any website spend
// the *user's own* rate-limit quota through their browser session. Only the
// app's own origins get the header; unknown origins get none (browser blocks
// the read). NOTE: add the custom domain here when it goes live.
const ALLOWED_ORIGINS = new Set([
  "https://upmore-srikanthvishnu90-sketchs-projects.vercel.app",
  "http://localhost:3000",
  "http://localhost:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8080",
]);
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// Generic provider words that must never trigger provider matching on their
// own — they hijack unrelated questions ("this site ..." matched provider "Site").
const GENERIC_PROVIDER_WORDS = new Set([
  "site", "app", "website", "online", "money", "cash", "pay", "earn",
  "free", "best", "new", "top", "get", "make", "work", "works", "working",
  "job", "jobs", "gig", "gigs", "task", "tasks", "micro", "quick", "easy",
  "fast", "platform", "program", "reward", "rewards", "bonus", "survey",
  "surveys", "testing", "review", "reviews", "extra", "side", "hustle",
  // FIX (2026-09-28, route-hijack): number words are never provider
  // identifiers in a user message — "five" in "five words" matched
  // "Five Star Credit Union".
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  // FIX (2026-09-28, feature-#2 test): common verbs/nouns that are also
  // provider names must never match on their own — "can you help me"
  // matched provider "Help" (Ting referral promo R6341). Same class:
  // "Account", "Go", "Home", "Refer", "Share", "Try" are all provider names
  // in the catalog. Multi-word matches ("Ting referral") still work.
  "help", "helps", "helping", "account", "accounts", "go", "goes", "going",
  "home", "refer", "refers", "referring", "referral", "referrals",
  "share", "shares", "sharing", "try", "tries", "trying",
]);
function isGenericProviderWord(w: string): boolean {
  return GENERIC_PROVIDER_WORDS.has(w);
}

// Warm-isolate catalog cache (see the fetch site for the TTL rationale).
let catalogCache: { at: number; routes: any[] } | null = null;

// NOT A TRAINEE ROLLBACK (D-046, architect, 2026-11-09): this is the Upmore-era agent-chat. It calls Anthropic directly,
// outside Trainee's gateway and its $70 budget, on a Haiku default. Function secrets are project-wide, so on a project that
// holds Trainee's secrets it refuses every request instead of serving as Trainee's agent-chat.
const TRAINEE_PROJECT = ["TRAINEE_INBOUND_SECRET", "TRAINEE_DELIVER_SECRET", "CAREER_INGEST_SECRET", "CAREER_PROACTIVE_SECRET"].some((k) => !!Deno.env.get(k));

serve(async (req) => {
  const cors = corsFor(req);
  if (TRAINEE_PROJECT) return json(cors, { error: "not_a_trainee_rollback", detail: "agent-chat v203 is the Upmore-era handler and is never served as Trainee; roll Trainee back with docs/launch/TRAINEE-GO-LIVE.md (Rollback)" }, 503);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const authM = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!authM) return json(cors, { error: "unauthorized" }, 401);
    // Read the body once up front: the bridge override below needs as_user_id
    // and the main flow needs thread_id/message/images.
    const body = await req.json().catch(() => ({}));

    // TEST BRIDGE ONLY (iMessage): when the bearer token is EXACTLY the
    // service_role key, the caller may run the turn as a specific user via
    // `as_user_id`. This exists solely for the first-party iMessage test
    // bridge. The normal user-JWT path below is completely unchanged.
    // The key itself is never logged.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isBridgeCall = serviceKey !== "" && authM[1] === serviceKey;
    const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let bridgeUserId: string | null = null;
    if (isBridgeCall) {
      const raw = typeof body.as_user_id === "string" ? body.as_user_id : "";
      if (!UUID_RX.test(raw)) return json(cors, { error: "as_user_id must be a valid UUID" }, 400);
      bridgeUserId = raw;
    }

    // The gateway already verified the JWT signature (verify_jwt=true). Extract
    // the user token and pass it EXPLICITLY: auth.getUser() with no argument
    // reads the client session, which does not exist in an edge function, so it
    // would always return null and every signed-in user would get a 401.
    let supabase: any;
    let user: { id: string; email?: string | null };
    if (bridgeUserId) {
      // Bridge path: service_role client (bypasses RLS); every query below is
      // still explicitly scoped with .eq("user_id", user.id).
      supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
      user = { id: bridgeUserId };
    } else {
      supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user: u } } = await supabase.auth.getUser(authM[1]);
      if (!u) return json(cors, { error: "unauthorized" }, 401);
      user = u;
    }

    // The rate limiter FKs to profiles — make sure a profile row exists first
    // (the app upserts on sign-in, but API/test callers may not). Without this
    // a missing profile would make the RPC error and look like rate limiting.
    await supabase.from("profiles").upsert({ id: user.id }, { onConflict: "id" });

    // Rate limiting: 60 chat requests per fixed 60-minute window per user,
    // enforced on EVERY request (deterministic capabilities included) via
    // the agent_rl_bump RPC — atomic row-locked increment so concurrent
    // requests can't double-spend. A false return is a real 429 (with
    // Retry-After); an RPC *error* is a 500, never a fake "slow down".
    // Bridge path: the hardened agent_rl_bump derives the user from
    // auth.uid(), which is null for service_role callers, so it would always
    // 429. agent_rl_bump_as takes the user explicitly and is executable ONLY
    // by service_role (our own backend) — same window math, same limit.
    const rlFn = bridgeUserId ? "agent_rl_bump_as" : "agent_rl_bump";
    const RATE_LIMIT = 60;
    const { data: rlOk, error: rlErr } = await supabase.rpc(rlFn, { p_user: user.id, p_limit: RATE_LIMIT });
    if (rlErr) {
      console.error("agent_rl_bump failed:", rlErr.message);
      return json(cors, { error: "internal" }, 500);
    }
    if (!rlOk) {
      return new Response(
        JSON.stringify({ error: "rate_limited", message: "Slow down a little — try again in a bit." }),
        { status: 429, headers: { ...cors, "content-type": "application/json", "Retry-After": "3600" } }
      );
    }

    const { thread_id, message, images } = body as { thread_id?: unknown; message?: unknown; images?: unknown };
    if (!message || typeof message !== "string") return json(cors, { error: "message required" }, 400);
    if (message.length > MAX_MESSAGE_LEN) return json(cors, { error: "message too long" }, 400);
    // Optional photo attachments: validated Anthropic image blocks (max 3,
    // each capped at ~2MB base64 — the client downscales to 1024px JPEG).
    const imageBlocks: unknown[] = [];
    if (Array.isArray(images)) {
      for (const im of images.slice(0, 3)) {
        if (!im || typeof im.data !== "string" || im.data.length === 0 || im.data.length > 2_000_000) continue;
        const mt = typeof im.media_type === "string" ? im.media_type : "";
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mt)) continue;
        imageBlocks.push({ type: "image", source: { type: "base64", media_type: mt, data: im.data } });
      }
    }
    // Stored user content: the text plus an honest marker when photos were attached.
    const userContent = (imageBlocks.length ? "[photo attached] " : "") + message;
    // L4: thread_id must be a string when provided (non-string truthy values
    // would otherwise cause a DB error → noisy 500).
    if (thread_id !== undefined && thread_id !== null && typeof thread_id !== "string")
      return json(cors, { error: "thread_id must be a string" }, 400);

    // Thread (create if needed)
    let tid: string = thread_id;
    if (!tid) {
      const { data, error } = await supabase.from("agent_threads")
        .insert({ user_id: user.id, title: message.slice(0, 60) }).select("id").single();
      if (error) throw error;
      tid = data.id;
    }

    // Catalog-independent safety guards run BEFORE the heavy parallel fetches
    // (1500-route catalog in 5 pages). They need no DB data, so a gambling,
    // privacy, scam, or system-prompt question returns in ~500ms instead of
    // waiting for the full catalog. Persist like the other deterministic paths.
    const earlyGuard = tryGiftRewardSafe(message) ?? tryGamblingGuard(message) ?? tryFakeDocGuard(message) ?? tryContestGuard(message) ?? tryCryptoGuard(message) ?? tryFakeReviewGuard(message) ?? tryTaxFraudGuard(message) ?? tryPrivacyGuard(message) ?? tryScamGuard(message) ?? tryServerGuards(message) ?? trySyspromptGuard(message) ?? tryFinanceFact(message);
    if (earlyGuard) {
      await supabase.from("agent_messages").insert([
        { thread_id: tid, role: "user", content: userContent },
        { thread_id: tid, role: "assistant", content: earlyGuard, meta: { capability: true, guard: true } },
      ]);
      return json(cors, { thread_id: tid, reply: earlyGuard, action: null });
    }

    // Parallel fetches: profile, playbook, reminders, history, expiring.
    // The verified catalog is cached module-level for 5 minutes: fetching
    // 1500 full cards in 5 PostgREST pages on every request made even
    // deterministic replies slow. Deno reuses isolates, so warm requests hit
    // the cache; the catalog only changes via batch verification, so a 5-min
    // staleness window is acceptable (expiry checks below are never cached).
    const nowIso = new Date().toISOString();
    const soonIso = new Date(Date.now() + 14 * 86400000).toISOString();
    const catalogFresh = catalogCache && Date.now() - catalogCache.at < 5 * 60 * 1000;
    const routePagesPromise = catalogFresh
      ? Promise.resolve(null)
      : Promise.all(
          [0, 1, 2, 3, 4].map((p) =>
            supabase.from("routes").select("*").eq("status", "researched")
              .order("route_id").range(p * 1000, p * 1000 + 999)
          ),
        );
    const [profRes, playRes, remRes, verPages, histRes, exclRes, expRes, expiredRes, listRes, subsRes, renewRes, settleRes, ipoRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase.from("playbook_progress")
        .select("*, routes!inner(*)").eq("user_id", user.id).eq("status", "active")
        .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      // Due reminders: due_at passed and not yet sent.
      supabase.from("route_reminders")
        .select("route_id, kind, message, due_at").eq("user_id", user.id)
        .is("sent_at", null).lte("due_at", nowIso)
        .order("due_at", { ascending: true }).limit(3),
      routePagesPromise,
      supabase.from("agent_messages")
        .select("role, content").eq("thread_id", tid).order("id", { ascending: false }).limit(15),
      // Full-thread user messages for payout-exclusion scanning ("no points"
      // etc.): the 30-message window ages standing exclusions out of long
      // threads (beta fix 2026-09-24). Content-only, no model prompt cost.
      supabase.from("agent_messages")
        .select("content").eq("thread_id", tid).eq("role", "user")
        .order("id", { ascending: true }).limit(200),
      // Expiring within 14 days (warn before recommending) vs already
      // expired (never present as live) — tracked separately.
      supabase.from("routes")
        .select("route_id, name, expires_at").eq("status", "researched")
        .not("expires_at", "is", null).gte("expires_at", nowIso).lte("expires_at", soonIso).limit(5),
      supabase.from("routes")
        .select("route_id, name, expires_at").eq("status", "researched")
        .not("expires_at", "is", null).lt("expires_at", nowIso).limit(5),
      // Open Wanted-board listings (electronics people need; others can accept).
      supabase.from("listings")
        .select("id, title, description, budget_max, created_at").eq("status", "open")
        .order("created_at", { ascending: false }).limit(10),
      // User's saved subscriptions (Save tab) — the agent CAN see these.
      // This is what powers "find my subscriptions" and related features.
      supabase.from("save_subscriptions")
        .select("merchant, plan_name, amount, currency, billing_interval, next_billing_date, status, cancel_url, detected_via")
        .eq("user_id", user.id).eq("status", "active")
        .order("amount", { ascending: false }),
      // Upcoming renewals — for proactive trial/subscription warnings.
      supabase.from("save_renewals")
        .select("name, renews_on, kind, status")
        .eq("user_id", user.id).eq("status", "upcoming").gte("renews_on", nowIso.split("T")[0])
        .order("renews_on", { ascending: true }).limit(10),
      // Open class action settlements — verified, with live claim deadlines.
      // Powers "find class actions I'm eligible for" matching.
      supabase.from("class_action_settlements")
        .select("name, case_name, category, summary, eligibility, eligibility_states, claim_deadline, payout_summary, proof_required, claim_url")
        .eq("status", "open").gte("claim_deadline", nowIso.split("T")[0])
        .order("claim_deadline", { ascending: true }).limit(15),
      // IPO / pre-IPO offerings — verified, with live allocation windows.
      // Powers "any IPOs I can get into" alerts and guidance.
      supabase.from("ipo_offerings")
        .select("company_name, ticker, offering_type, provider, price_low, price_high, expected_date, window_opens, window_closes, status, shares_offered, official_url, notes, verified_at")
        .in("status", ["announced", "window_open"])
        .order("expected_date", { ascending: true }).limit(15),
    ]);
    const profile = profRes.data;
    // Agentic walkthrough parity: {{name}}/{{email}}/{{state}} values resolved
    // via the module-level resolvePlaceholders (plain text in chat; the app
    // renders tap-to-copy chips for the same placeholders).
    const agentVals = {
      name: (profile && profile.display_name) || "",
      email: (user && user.email) || "",
      state: (profile && profile.state) || "",
    };
    const playbook = playRes.data;
    const reminders = remRes.data;
    // Catalog: warm-isolate cache hit, or concatenate the fresh pages.
    let verRows: RouteCard[];
    if (verPages) {
      verRows = [];
      for (const pg of verPages) for (const r of (pg.data ?? [])) verRows.push(r as RouteCard);
      catalogCache = { at: Date.now(), routes: verRows };
    } else {
      verRows = catalogCache!.routes;
    }

    // Earn-ratio ordering: payout_mid / max(1, time_mid), ties broken by
    // higher payout midpoint. This is the same ordering the catalog uses.
    const ratioOf = (r: any) => {
      const pm = (Number(r.payout_min ?? 0) + Number(r.payout_max ?? 0)) / 2;
      const tm = Math.max(1, (Number(r.time_min_minutes ?? 0) + Number(r.time_max_minutes ?? 0)) / 2);
      return { ratio: pm / tm, pmid: pm };
    };
    const verified = (verRows as RouteCard[]).sort((a, b) => {
      const ra = ratioOf(a), rb = ratioOf(b);
      return rb.ratio - ra.ratio || rb.pmid - ra.pmid;
    });

    // Candidate routes: active playbook route + verified routes
    // matching the user's state (simple keyword match v1; semantic search later).
    // Capabilities (make-me-$X, walkthroughs) see every verified route;
    // the fast path and the model only see Standard-lane ones.
    let routes: RouteCard[] = [];
    if (playbook?.routes) routes.push(playbook.routes as RouteCard);
    const state = (profile?.state ?? "").toLowerCase();
    for (const r of verified) {
      if (!routes.some((x) => x.route_id === r.route_id)) routes.push(r);
    }
    const standardRoutes = routes.filter((r) => (r.lane ?? "Standard") === "Standard");
    // The model only gets the top 60 by earn ratio in its prompt (full cards
    // with steps for 1500 routes would blow the context). Capabilities and
    // the grounding post-check use the full `routes` array.
    const PROMPT_ROUTE_LIMIT = 60;
    const promptRoutes = standardRoutes.slice(0, PROMPT_ROUTE_LIMIT);
    // INSTANT-START PIN (2026-09-28): an "rn"/"right now" request must get a
    // concrete method WITH exact links, never "go search the app store". Top
    // earn-ratio ranking buries low-payout instant routes (Fetch etc.), so pin
    // up to 5 fresh verified app-based no-prerequisite routes at the top of
    // the model's cards. Dedupe against the top-60.
    const freshMs = 7 * 24 * 3600 * 1000;
    const instantPool = routes.filter((r) =>
      (r.lane ?? "Standard") === "Standard" &&
      r.status === "researched" && r.verified_at &&
      Date.now() - new Date(r.verified_at).getTime() < freshMs &&
      ((r as any).ios_url || (r as any).android_url)
    );
    const seenIds = new Set(promptRoutes.map((r) => r.route_id));
    const pinnedRoutes = instantPool.filter((r) => !seenIds.has(r.route_id)).slice(0, 5);
    for (const r of pinnedRoutes) promptRoutes.unshift(r);
    // Fast lookup: route_id → card (validates model actions against reality).
    const routeIdSet = new Set(routes.map((r) => r.route_id));
    const routeSteps = (rid: string) => routes.find((r) => r.route_id === rid)?.steps?.length ?? 0;

    // Recent history
    const hist = ((histRes.data ?? []).reverse());

    // Learning from mistakes (2026-09-28): if the user is correcting the
    // previous reply, record it as a lesson — fire-and-forget, never blocks
    // the reply. Past lessons relevant to this message are fetched for the
    // model prompt below.
    const userCorrection = detectUserCorrection(message, hist);
    if (userCorrection) {
      recordChatLesson(supabase, user.id, {
        kind: "user_correction", scope: "global", category: "user_correction",
        title: `You were corrected: "${userCorrection.correction.slice(0, 80)}"`,
        what_happened: `After you said "${userCorrection.prevReply.slice(0, 200)}", the user corrected you: "${userCorrection.correction}".`,
        what_to_do_instead: "When the user corrects you, acknowledge the correction plainly, adjust your answer to what they actually meant, and don't defend the wrong one.",
        signal: userCorrection.correction.slice(0, 200),
      }).then(() => {}, () => {});
    }
    const chatLessons = await fetchChatLessons(supabase, user.id, message);

    // FAST-PATH: deterministic answers for factual questions about verified
    // routes. Skips the Anthropic call entirely (<500ms vs ~9s). Only triggers
    // for safe factual patterns; everything else goes to the model.
    // CAPABILITY PATHS: deterministic answers that never touch the model —
    // "make me $X" (honest time-to-cash math + full steps + exact links),
    // prediction-market/gambling guard (critical-thinking takedown).
    // (The old quantitative stock screen was removed 2026-09-27: it violated
    // the capital wall. Securities questions now hit the refusal guard.)
    // Deterministic output needs no grounding post-check; persist like fast path.
    const exclHist = [{ role: "user", content: userContent },
      ...((exclRes.data ?? []).map((m: any) => ({ role: "user", content: String(m.content ?? "") })))];
    // FIX (2026-09-28, agent 5 C8): when the user is correcting the previous
    // reply, skip ALL deterministic paths and route to the model. The lesson
    // block (renderLessonsBlock) is only injected into the model prompt, so
    // deterministic route answers could never acknowledge or apply a
    // correction — they'd just repeat the same mistake class (e.g. another
    // KEH card after "that's wrong, I asked about textbooks"). Corrections
    // are rare, so the extra model call is negligible.
    const bypassDeterministic = !!userCorrection;
    const capCtx: CapCtx = {
      supa: supabase, userId: user.id,
      jwt: authM[1],
      supabaseUrl: Deno.env.get("SUPABASE_URL")!,
      anonKey: Deno.env.get("SUPABASE_ANON_KEY")!,
    };
    const cap = bypassDeterministic ? null : await tryCapabilities(message, routes, capCtx, hist, exclHist);
    if (cap) {
      // Owner rule 2026-09-28: deterministic capability replies get the same
      // ChatGPT-style Sources block as model replies. Compute before persist
      // so history matches what the user saw.
      const capReply = appendSources(cap.reply, routes, false, []);
      await supabase.from("agent_messages").insert([
        { thread_id: tid, role: "user", content: userContent },
        { thread_id: tid, role: "assistant", content: capReply, meta: { capability: true } },
      ]);
      // Deterministic walkthroughs create playbook progress just like the
      // model's start_walkthrough action does, so the app's Home tab tracks it.
      if (cap.routeId && routes.some((r) => r.route_id === cap.routeId)) {
        await supabase.from("playbook_progress").upsert({
          user_id: user.id, route_id: cap.routeId, current_step: 0,
          status: "active", updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,route_id" });
      }
      return json(cors, { thread_id: tid, reply: capReply, action: null });
    }

    // Deterministic reminder intent: the user asked to be reminded about a
    // known route. Create it directly instead of relying on the model to emit
    // a set_reminder action (it sometimes promises in words and forgets the
    // line — the words alone do nothing).
    const remIntent = bypassDeterministic ? null : tryReminderIntent(message, routes);
    if (remIntent) {
      const { error: detRemErr } = await supabase.from("route_reminders").insert({
        user_id: user.id,
        route_id: remIntent.routeId,
        kind: "nudge",
        message: remIntent.text.slice(0, 280),
        due_at: parseDueAt(remIntent.when),
        channel: "agent",
      });
      if (!detRemErr) {
        const detReply = `Done — I'll remind you ${remIntent.when}: ${remIntent.text}.`;
        await supabase.from("agent_messages").insert([
          { thread_id: tid, role: "user", content: userContent },
          { thread_id: tid, role: "assistant", content: detReply, meta: { capability: true, deterministic_reminder: true } },
        ]);
        return json(cors, { thread_id: tid, reply: detReply, action: null });
      }
      console.error("deterministic reminder insert failed:", detRemErr.message);
      const detFail = `Quick heads-up: I tried to save that reminder but it didn't stick (technical hiccup on my end). Want me to try again?`;
      await supabase.from("agent_messages").insert([
        { thread_id: tid, role: "user", content: userContent },
        { thread_id: tid, role: "assistant", content: detFail, meta: { capability: true } },
      ]);
      return json(cors, { thread_id: tid, reply: detFail, action: null });
    }

    // Feature #6 (2026-09-28): free-trial tracking. The model used to claim
    // trial reminders were set while nothing was persisted — agent-chat had
    // no free-form reminder path. Parse deterministically and persist one
    // route_reminders row per trial (route_id null) due the day before the
    // trial ends; the existing due-reminder surfacing warns the user in chat
    // on/after the warn date.
    const trialCap = bypassDeterministic ? null : tryTrialTracker(message, hist);
    if (trialCap) {
      if ("needDetails" in trialCap) {
        const ask = `Got it — I'll track them and warn you before each one charges. Which free trials do you have, and when does each one end? (e.g. "Hulu ends Oct 3, Paramount+ ends Oct 10")`;
        await supabase.from("agent_messages").insert([
          { thread_id: tid, role: "user", content: userContent },
          { thread_id: tid, role: "assistant", content: ask, meta: { capability: true, trial_tracker: true } },
        ]);
        return json(cors, { thread_id: tid, reply: ask, action: null });
      }
      const withWarn = trialCap.trials.map((t) => {
        const warn = new Date(t.endDate + "T00:00:00Z");
        warn.setUTCDate(warn.getUTCDate() - 1);
        return { trial: t, warnIso: warn.toISOString().slice(0, 10) };
      });
      // Dedupe: don't re-track a trial that's already being watched.
      const { data: existingTrials } = await supabase.from("route_reminders")
        .select("message").eq("user_id", user.id).eq("kind", "trial_warning").is("sent_at", null);
      const haveMsgs = (existingTrials ?? []).map((r: any) => String(r.message).toLowerCase());
      const isDup = (svc: string) => haveMsgs.some((m) => m.includes(svc.toLowerCase()));
      const fresh = withWarn.filter((w) => !isDup(w.trial.service));
      const already = withWarn.filter((w) => isDup(w.trial.service));
      const rows = fresh.map((w) => ({
        user_id: user.id,
        route_id: null,
        kind: "trial_warning",
        message: `⚠️ ${w.trial.service} free trial ends ${prettyTrialDate(w.trial.endDate)} — cancel before you're charged.`.slice(0, 280),
        due_at: `${w.warnIso}T09:00:00.000Z`,
        channel: "agent",
      }));
      const { error: trialErr } = rows.length
        ? await supabase.from("route_reminders").insert(rows)
        : { error: null };
      if (!trialErr) {
        const lines = fresh.map((w) =>
          `• ${w.trial.service} — trial ends ${prettyTrialDate(w.trial.endDate)} → I'll warn you ${prettyTrialDate(w.warnIso)}`);
        const dup = already.map((w) => `• ${w.trial.service} — already tracked, warning stays set.`);
        const n = fresh.length + already.length;
        const detReply =
          `Done — tracking ${n} free trial${n === 1 ? "" : "s"}. I'll warn you right here in chat before each one charges:\n\n` +
          [...lines, ...dup].join("\n") +
          `\n\nJust open the app on or after a warning date and I'll flag it at the top of our chat so you can cancel in time.`;
        await supabase.from("agent_messages").insert([
          { thread_id: tid, role: "user", content: userContent },
          { thread_id: tid, role: "assistant", content: detReply, meta: { capability: true, trial_tracker: true } },
        ]);
        return json(cors, { thread_id: tid, reply: detReply, action: null });
      }
      console.error("trial reminder insert failed:", trialErr.message);
      const detFail = `Quick heads-up: I tried to save those trial reminders but they didn't stick (technical hiccup on my end). Want me to try again?`;
      await supabase.from("agent_messages").insert([
        { thread_id: tid, role: "user", content: userContent },
        { thread_id: tid, role: "assistant", content: detFail, meta: { capability: true } },
      ]);
      return json(cors, { thread_id: tid, reply: detFail, action: null });
    }

    // FIX (2026-09-28, agent 5 C11): "remind me ..." with no route match used
    // to fall through silently — no reminder created, no acknowledgment, the
    // request just vanished. Say plainly what reminders can do.
    if (!bypassDeterministic && isGenericReminderRequest(message)) {
      const noRouteRem = `I can set reminders tied to a specific route — like "remind me tomorrow to check the Florence Bank bonus terms for R2748". Which route is this reminder for?`;
      await supabase.from("agent_messages").insert([
        { thread_id: tid, role: "user", content: userContent },
        { thread_id: tid, role: "assistant", content: noRouteRem, meta: { capability: true, no_route_reminder: true } },
      ]);
      return json(cors, { thread_id: tid, reply: noRouteRem, action: null });
    }

    // FIX (2026-09-28, route-hijack): finance questions must never be answered
    // from a route card — "my credit score dropped" was returning a
    // test-scoring gig ("score" is in its route name). financeFactMatch
    // already nudges the model into FINANCE Q&A mode for these; skip the
    // route fast-path entirely so the model answers from the curated facts.
    const financePre = bypassDeterministic ? [] : financeFactMatch(message);
    const fastReply = (bypassDeterministic || financePre.length > 0) ? null : tryFastPath(message, standardRoutes, playbook?.routes as RouteCard | undefined, agentVals, hist);
    if (fastReply) {
      // Owner rule 2026-09-28: same Sources block as model replies.
      const fastFinal = appendSources(fastReply, routes, false, []);
      await supabase.from("agent_messages").insert([
        { thread_id: tid, role: "user", content: userContent },
        { thread_id: tid, role: "assistant", content: fastFinal, meta: { fast_path: true } },
      ]);
      return json(cors, { thread_id: tid, reply: fastFinal, action: null });
    }

    const profileLine = profile
      ? `User profile: state=${profile.state ?? "unknown"}, age=${profile.age ?? "unknown"}, free time=${profile.free_time_hours ?? "?"}h/wk, paycheck=${profile.paycheck_status ?? "?"}, cash available=$${profile.cash_available ?? "?"}.`
      : "User profile: unknown — learn it from what the user tells you and save facts with the ask_profile action; never ask for the same fact twice.";
    const playbookLine = playbook
      ? `Active walkthrough: route ${playbook.route_id}, currently on step ${playbook.current_step + 1}.`
      : "No active walkthrough.";
    // Resume nudge: user started a walkthrough but went quiet > 24h.
    let resumeLine = "";
    if (playbook?.updated_at) {
      const idleHrs = (Date.now() - new Date(playbook.updated_at).getTime()) / 3600000;
      if (idleHrs > 24) {
        resumeLine = `PROACTIVE NUDGE: the user started the ${playbook.route_id} walkthrough but hasn't touched it in ${Math.round(idleHrs)} hours. Open with a warm resume offer ("want to pick up where you left off on step ${playbook.current_step + 1}?"), don't just answer and move on.`;
      }
    }
    const reminderLine = (reminders?.length ?? 0) > 0
      ? `Due reminders (be proactive — mention these naturally): ` +
        reminders!.map((r: any) => `${r.message ?? r.route_id} (due ${r.due_at})`).join("; ") + "."
      : "No due reminders.";
    // Expiry alerts: verified routes expiring within 14 days (warn before
    // recommending) and already-expired ones (never present as live).
    const expiring = expRes.data;
    const expired = expiredRes.data;
    const expiryLine = [
      (expiring?.length ?? 0) > 0
        ? `EXPIRING SOON (warn the user before recommending): ` +
          expiring!.map((r: any) => `${r.name ?? r.route_id} expires ${r.expires_at}`).join("; ") + "."
        : "No verified routes expiring within 14 days.",
      (expired?.length ?? 0) > 0
        ? `ALREADY EXPIRED (never present these as live offers): ` +
          expired!.map((r: any) => `${r.name ?? r.route_id} expired ${r.expires_at}`).join("; ") + "."
        : "No recently expired verified routes.",
    ].join("\n");

    const catalogLine =
      `Verified route catalog: ${verified.length} verified routes total. ` +
      `Showing the top ${promptRoutes.length} by dollars-per-minute below. ` +
      (promptRoutes.length === 0
        ? "You have ZERO verified routes right now. Never claim you have verified routes to walk through. Say new routes are being verified and you'll have them soon."
        : "Only present routes marked LIVE below as offers.");

    const openListings = listRes.data ?? [];
    // Keyword-match open Wanted listings against the user's message so the
    // model only hears about relevant ones (avoids dumping the whole board).
    const msgWords = new Set(message.toLowerCase().split(/[^a-z0-9+]+/).filter(w => w.length > 2));
    const matchListings = openListings.filter((l: any) => {
      const hay = `${l.title ?? ""} ${l.description ?? ""}`.toLowerCase();
      const hayWords = new Set(hay.split(/[^a-z0-9+]+/).filter(w => w.length > 2));
      for (const w of msgWords) if (hayWords.has(w)) return true;
      return false;
    }).slice(0, 3);
    const listingLine = matchListings.length > 0
      ? `WANTED BOARD (real users need these electronics right now — mention the relevant one(s) naturally when the user asks about selling, trading, or finding electronics; tell them to open the Explore tab's Wanted board to accept): ` +
        matchListings.map((l: any) => `"${l.title}"${l.budget_max != null ? ` (up to $${l.budget_max})` : ""}${l.description ? ` — ${l.description}` : ""}`).join("; ") + "."
      : (openListings.length > 0
        ? `Wanted board has ${openListings.length} open electronics listing(s), none matching this message — don't mention them unless the user asks about electronics/selling.`
        : "Wanted board is empty right now.");
    // USER'S SAVED SUBSCRIPTIONS (Save tab) — the agent CAN see these.
    // This is the data source for "find my subscriptions" and related asks.
    const subs = subsRes.data ?? [];
    const renewals = renewRes.data ?? [];
    const subscriptionLine = subs.length > 0
      ? `USER'S SAVED SUBSCRIPTIONS (you CAN see these — this is real data from their Save tab, not a guess): ` +
        subs.map((s: any) => {
          const amt = s.amount != null ? `$${s.amount}${s.billing_interval ? `/${s.billing_interval}` : ""}` : "price unknown";
          const next = s.next_billing_date ? `, next charge ${s.next_billing_date}` : "";
          const cancel = s.cancel_url ? `, cancel at ${s.cancel_url}` : "";
          return `${s.merchant}${s.plan_name ? ` (${s.plan_name})` : ""}: ${amt}${next}${cancel}`;
        }).join("; ") + "." +
        (renewals.length > 0
          ? ` UPCOMING RENEWALS: ` + renewals.map((r: any) => `${r.name} on ${r.renews_on}${r.kind ? ` (${r.kind})` : ""}`).join("; ") + "."
          : "")
      : "USER'S SAVED SUBSCRIPTIONS: the user has no subscriptions saved in their Save tab yet. Say so honestly — do NOT claim you cannot see their data. Tell them to add subscriptions in the Save tab (or connect their bank/email when those integrations are live) and you'll track them.";
    // OPEN CLASS ACTION SETTLEMENTS — verified, with live deadlines.
    // Match the user's scenario (state, products, services) against these.
    const settlements = settleRes.data ?? [];
    const settlementLine = settlements.length > 0
      ? `OPEN CLASS ACTION SETTLEMENTS — ${settlements.length} verified entries. THIS BLOCK IS THE ONLY SOURCE OF TRUTH FOR THESE SETTLEMENTS. Your training data may contain different deadlines, fund sizes, or states for cases with similar names — IGNORE your memory and use ONLY what is written here. Quote fund sizes, payouts, dates, and proof requirements EXACTLY as written; never rephrase, round, or approximate them.\n` +
        settlements.map((s: any, i: number) => {
          const states = (s.eligibility_states?.length ?? 0) > 0 ? s.eligibility_states.join(", ") : "nationwide (all US states)";
          return `[Settlement ${i + 1}/${settlements.length}]\nName: ${s.name}\nClaim deadline: ${s.claim_deadline}\nEligible states: ${states}\nWhat happened: ${s.summary}\nPayout: ${s.payout_summary}\nProof required: ${s.proof_required}\nWho qualifies: ${s.eligibility}\nFile here: ${s.claim_url}`;
        }).join("\n\n")
      : "No open class action settlements in the directory right now.";
    // IPO / PRE-IPO OFFERINGS — verified, with live allocation windows.
    // The agent alerts on open windows and guides the user to request
    // allocations in the venue's app (no broker API exists for IPO offers).
    const ipos = (typeof ipoRes !== "undefined" && ipoRes.data) ? ipoRes.data : [];
    const ipoLine = ipos.length > 0
      ? `IPO / PRE-IPO OFFERINGS — ${ipos.length} verified entries. THIS BLOCK IS THE ONLY SOURCE OF TRUTH FOR THESE OFFERINGS. Your training data may contain different prices, dates, or tickers — IGNORE your memory and use ONLY what is written here. Quote prices, dates, and share counts EXACTLY as written; never rephrase, round, or approximate them. Never claim a window is open unless status says "window_open" AND window_closes is in the future.\n` +
        ipos.map((o: any, i: number) => {
          const price = o.price_low && o.price_high ? `$${o.price_low}-$${o.price_high}` : "TBD";
          const win = o.window_opens && o.window_closes ? `Window: ${o.window_opens} to ${o.window_closes}` : "Window: TBD";
          return `[Offering ${i + 1}/${ipos.length}]\nCompany: ${o.company_name}${o.ticker ? ` (${o.ticker})` : ""}\nType: ${o.offering_type}\nVenue: ${o.provider}\nPrice range: ${price}\n${win}\nStatus: ${o.status}\nNotes: ${o.notes ?? ""}${o.official_url ? `\nOfficial page: ${o.official_url}` : ""}`;
        }).join("\n\n")
      : "No IPO or pre-IPO offerings in the directory right now.";
    const system = SYSTEM_PROMPT + "\n\n" + profileLine + "\n" + playbookLine + "\n" + resumeLine + "\n" + reminderLine + "\n" + expiryLine + "\n" + listingLine + "\n" + subscriptionLine + "\n" + settlementLine + "\n" + ipoLine +
      `\n${catalogLine}\n\n` +
      "\n\nROUTE CARDS (only source of truth):\n" + renderRouteCards(promptRoutes);

    const systemStatic = SYSTEM_PROMPT + // stable: cacheable
      "\n\nFINANCE FACTS (only source of truth for general finance questions — figures, limits, official URLs):\n" + renderFinanceFacts();
    // COST OPT 2026-09-27: route cards are stable for the 5-min catalog cache
    // window, so they get their own cache breakpoint. This turns ~10K tokens
    // from $1.00/MTok into $0.10/MTok — the single biggest cost win.
    const routeCardsBlock =
      `\n${catalogLine}\n\n` +
      "\n\nROUTE CARDS (only source of truth):\n" + renderRouteCards(promptRoutes);
    // Deterministic finance-intent nudge: if the question matches curated
    // finance facts, force FINANCE Q&A mode so route matching can't hijack it
    // ("how can I improve my credit score" must not return a bank bonus).
    const financeIds = financeFactMatch(message);
    const financeNudge = financeIds.length ? "\n\n" + financeModeNudge(financeIds) : "";
    const systemDynamic = "\n\n" + profileLine + "\n" + playbookLine + "\n" + resumeLine + "\n" + reminderLine + "\n" + expiryLine + "\n" + listingLine + "\n" + subscriptionLine + "\n" + settlementLine + "\n" + ipoLine + financeNudge +
      renderLessonsBlock(chatLessons);

    // COST OPT 2026-09-27: monthly AI quota — tail-risk protection for the
    // $10/mo margin. 900 model calls/month (~30/day) caps worst-case AI cost
    // at ~$3.87/mo = 61% margin. Normal users never hit this; only a runaway
    // script or abuse does. Counts actual model calls only (deterministic
    // fast-path/capability replies cost $0 and don't count).
    // Friendly message, not a hard error — the user can keep using the app.
    const MONTHLY_AI_LIMIT = 900;
    try {
      const monthStart = new Date();
      monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const { count: monthCalls } = await supabase.from("agent_usage")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", monthStart.toISOString());
      if ((monthCalls ?? 0) >= MONTHLY_AI_LIMIT) {
        const msg = "You've had a lot of deep chats this month — I've hit my monthly limit for AI replies. The rest of the app (routes, tools, tracking) still works fine, and I'll be back fresh next month.";
        await supabase.from("agent_messages").insert([
          { thread_id: tid, role: "user", content: userContent },
          { thread_id: tid, role: "assistant", content: msg, meta: { capability: true, quota: true } },
        ]);
        return json(cors, { thread_id: tid, reply: msg, action: null });
      }
    } catch (_) { /* quota check must never break chat — fail open */ }

    // COST ARMOR 2026-09-27: AI anomaly tripwire. The 900-call/month hard cap
    // bounds worst-case AI cost at ~$3.87, but a runaway client or leaked
    // session should page the founder early. No behavior change for users —
    // just a founder_alerts row (once per user per day, enforced inside the
    // RPC). Never breaks chat.
    try {
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const mStart = new Date(); mStart.setUTCDate(1); mStart.setUTCHours(0, 0, 0, 0);
      const [{ count: mCalls }, { count: dCalls }] = await Promise.all([
        supabase.from("agent_usage").select("id", { count: "exact", head: true })
          .eq("user_id", user.id).gte("created_at", mStart.toISOString()),
        supabase.from("agent_usage").select("id", { count: "exact", head: true })
          .eq("user_id", user.id).gte("created_at", dayStart.toISOString()),
      ]);
      if ((mCalls ?? 0) >= 450 || (dCalls ?? 0) >= 100) {
        await supabase.rpc("report_ai_anomaly", {
          p_user_id: user.id, p_month_calls: mCalls ?? 0, p_day_calls: dCalls ?? 0,
        });
      }
    } catch (_) { /* tripwire must never break chat */ }

    // (rate limit was already enforced for every request at the top of the
    // handler, before any DB work)
    const anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: "text", text: systemStatic, cache_control: { type: "ephemeral" } },
          { type: "text", text: routeCardsBlock, cache_control: { type: "ephemeral" } },
          { type: "text", text: systemDynamic },
        ],
        messages: [...hist.map((m: any) => ({ role: m.role, content: m.content })), {
          role: "user",
          content: [...imageBlocks, { type: "text", text: message }],
        }],
      }),
    });
    if (!anthropicRes.ok) {
      const t = await anthropicRes.text();
      console.error("anthropic error", anthropicRes.status, t.slice(0, 300));
      return json(cors, { error: "agent_unavailable" }, 502);
    }
    const aj = await anthropicRes.json();
    let reply: string = aj.content?.map((b: any) => b.text ?? "").join("") ?? "";

    // COST OPT 2026-09-27: log token usage per request for margin verification.
    // Anthropic returns usage: {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}.
    // Fire-and-forget: never blocks the reply on a logging failure.
    try {
      const u = aj.usage ?? {};
      supabase.from("agent_usage").insert({
        user_id: user.id,
        thread_id: tid,
        model: MODEL,
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      }).then(() => {}, () => {});
    } catch (_) { /* usage logging must never break chat */ }

    // Grounding post-check: any violation → safe fallback.
    // Parse the ACTION line FIRST and strip it, so the check only sees the
    // user-facing text (an action's JSON must never trip grounding).
    let action: any = null;
    const m = reply.match(/ACTION\s+(\{.*\})\s*$/);
    if (m) {
      try { action = JSON.parse(m[1]); } catch { /* ignore */ }
      reply = reply.replace(/ACTION\s+\{.*\}\s*$/, "").trim();
    }
    // FINANCE Q&A mode: the model ends finance answers with [FINANCE].
    // Strip the marker and run the finance-aware grounding check instead
    // of the route-card check (different source of truth).
    let financeMode = false;
    if (/\[FINANCE\]\s*$/.test(reply)) {
      financeMode = true;
      reply = reply.replace(/\s*\[FINANCE\]\s*$/, "").trim();
      action = null; // finance answers carry no walkthrough actions
    }
    // A question that matched finance facts is finance-mode even if the model
    // forgot the marker: finance grounding + finance fallback apply.
    if (financeIds.length) financeMode = true;
    const violations = checkGrounding(reply, routes, message, financeMode, financeIds,
      exclHist.map((h) => String(h.content ?? "")).join("\n"),
      settlements.map((s: any) => ({ name: s.name, claim_url: s.claim_url, settlement_site_url: s.settlement_site_url, payout_summary: s.payout_summary, summary: s.summary })),
      ipos.map((o: any) => ({ company_name: o.company_name, ticker: o.ticker, official_url: o.official_url, price_low: o.price_low, price_high: o.price_high, notes: o.notes })));
    if (violations.length) {
      console.warn("grounding violations", violations);
      // Learning: the model made an ungrounded claim and got caught — record
      // the mistake so the lesson is injected into future prompts.
      recordChatLesson(supabase, user.id, {
        kind: "chat_caught", scope: "global", category: "grounding_violation",
        title: `Made an ungrounded claim (${violations.slice(0, 3).join(", ")})`,
        what_happened: `Reply to "${message.slice(0, 120)}" tripped grounding: ${violations.slice(0, 3).join("; ")}.`,
        what_to_do_instead: "Every factual claim about a route must come from the route card — never invent payouts, links, steps, or availability. When the card doesn't say it, say you don't know instead of filling the gap.",
        signal: violations.slice(0, 3).join("|"),
      });
      // A blocked debunk still warns: the user asked about a scam, and a
      // generic deflection would leave them unprotected. The scam fallback
      // names the pattern without inventing any amounts or URLs.
      // Finance-mode violations get the finance fallback (no route to ask about).
      // Billing-thread violations get the billing fallback (the route-specific
      // "which route you're asking about" is nonsensical there).
      reply = isDebunkReply(reply) ? SCAM_FALLBACK
        : financeMode ? FINANCE_SAFE_FALLBACK
        : isBillingContext(message, exclHist.map((h) => String(h.content ?? "")).join("\n")) ? BILLING_SAFE_FALLBACK
        : isSettlementContext(message, exclHist.map((h) => String(h.content ?? "")).join("\n")) ? SETTLEMENT_SAFE_FALLBACK
        : SAFE_FALLBACK;
      action = null;
    } else if (financeMode) {
      // Finance answers skip the route-correction pass below (no route claim).
    } else {
      // False no-route claim: the model said "I don't have a verified route
      // for X" but the catalog does. Correct it with the real card instead of
      // letting the lie stand. The correction is question-aware: earnings
      // questions get honest hedging (never a promised amount), guarantee
      // questions get an explicit no-guarantee line.
      const correction = findFalseNoRouteClaim(reply, routes);
      if (correction) {
        // Learning: the model denied a route that exists — record it scoped
        // to the route so the next similar question gets the lesson.
        recordChatLesson(supabase, user.id, {
          kind: "chat_caught", scope: `route:${correction.route_id}`, category: "false_no_route",
          title: `Claimed no verified route for "${correction.provider}" — route ${correction.route_id} exists`,
          what_happened: `Told the user there was no verified route, but ${correction.route_id} (${correction.provider}) is verified.`,
          what_to_do_instead: `Route ${correction.route_id} (${correction.provider}) IS verified for this kind of question — check the catalog before ever saying "I don't have a route for X".`,
          signal: correction.route_id,
        });
        const cc: string[] = Array.isArray(correction.catches) ? correction.catches : [];
        const q = message.toLowerCase();
        let hedge = "";
        if (/\bhow much will i (make|earn)\b/i.test(q)) {
          hedge = `\nI can't promise a specific amount — it depends on how much you use it, and varies person to person.`;
        } else if (/\bguarantee/i.test(q)) {
          hedge = `\nI can't guarantee speed or earnings — no honest route can promise that.`;
        }
        reply =
          `**${correction.provider}** (${correction.name}) — verified ✓ (route ${correction.route_id})\n\n` +
          `**Payout:** ${correction.payout_text ?? "see official terms"}` +
          `${correction.payout_timing ? ` — ${correction.payout_timing}` : ""}` +
          (cc.length ? `\n**Biggest catch:** ${cc[0]}` : "") +
          (correction.provider_url ? `\n**Official link:** ${correction.provider_url}` : "") +
          hedge +
          `\n\nWant me to walk you through it step by step?`;
        action = null;
      }
    }

    // Deterministic walkthrough start: if the user asks to be walked through a
    // verified route step-by-step and has no active playbook for it, create it
    // here (current_step=0). The model sometimes skips its start_walkthrough
    // action; this makes persistence reliable, not model-dependent. The target
    // must be fresh-verified (7 days) — a stale card gets no walkthrough.
    const walkStart = /\b(walk me through|step by step|get (me )?started with|start.*walkthrough)\b/i.test(message);
    if (walkStart && !playbook) {
      const targetNamed = routes.find((r) =>
        message.toLowerCase().includes(r.provider.toLowerCase()) ||
        message.toLowerCase().includes(r.name.toLowerCase()));
      const target = targetNamed ??
        (lastMentionedRouteId(hist)
          ? routes.find((r) => r.route_id === lastMentionedRouteId(hist))
          : undefined);
      const targetFresh = target && target.status === "researched" && target.verified_at &&
        Date.now() - new Date(target.verified_at).getTime() < 7 * 24 * 3600 * 1000;
      if (target && targetFresh) {
        await supabase.from("playbook_progress").upsert({
          user_id: user.id, route_id: target.route_id, current_step: 0,
          status: "active", updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,route_id" });
      }
    }

    // Deterministic Sources block (owner rule): every factual reply ends with
    // a ChatGPT-style Sources block of tappable official URLs. Runs after all
    // correction passes so corrected replies get sources too; the URLs come
    // from the route cards / finance facts themselves, so they're grounded by
    // construction. Skips when the model already added one.
    reply = appendSources(reply, routes, financeMode, financeIds,
      settlements.map((s: any) => ({ name: s.name, claim_url: s.claim_url })));

    // Persist
    await supabase.from("agent_messages").insert([
      { thread_id: tid, role: "user", content: userContent },
      { thread_id: tid, role: "assistant", content: reply, meta: { action, violations, lessons_applied: chatLessons.map((l) => l.id) } },
    ]);
    // Apply walkthrough actions to playbook_progress. Model actions are
    // validated against the real route catalog first: a hallucinated
    // route_id must never create a phantom playbook row, and next_step is
    // clamped to the route's actual step count.
    if (action?.type === "start_walkthrough" && typeof action.route_id === "string") {
      if (routeIdSet.has(action.route_id)) {
        await supabase.from("playbook_progress").upsert({
          user_id: user.id, route_id: action.route_id, current_step: 0,
          status: "active", updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,route_id" });
      } else {
        action = null;
      }
    }
    if (action?.type === "next_step" && typeof action.route_id === "string") {
      if (routeIdSet.has(action.route_id)) {
        const maxStep = Math.max(0, routeSteps(action.route_id) - 1);
        const step = typeof action.step === "number"
          ? Math.min(Math.max(0, Math.floor(action.step)), maxStep)
          : null;
        if (step !== null) {
          await supabase.from("playbook_progress").upsert({
            user_id: user.id, route_id: action.route_id, current_step: step,
            status: "active", updated_at: new Date().toISOString(),
          }, { onConflict: "user_id,route_id" });
        }
      } else {
        action = null;
      }
    }
    // set_reminder: the model promised a reminder — actually create it in the
    // reminders table so it fires. Invalid route_ids are dropped, not stored.
    // The insert error is CHECKED: if it fails, the action is nulled and the
    // user gets an honest heads-up instead of a fake "reminder set".
    let reminderFailed = false;
    if (action?.type === "set_reminder" && typeof action.route_id === "string") {
      if (routeIdSet.has(action.route_id)) {
        const { error: remErr } = await supabase.from("route_reminders").insert({
          user_id: user.id,
          route_id: action.route_id,
          kind: typeof action.kind === "string" ? action.kind.slice(0, 40) : "nudge",
          message: typeof action.message === "string" && action.message.trim()
            ? action.message.slice(0, 280)
            : `Reminder: check on ${action.route_id}`,
          due_at: parseDueAt(action.when),
          channel: "agent",
        });
        if (remErr) {
          console.error("set_reminder insert failed:", remErr.message);
          action = null;
          reminderFailed = true;
        }
      } else {
        action = null;
      }
    }
    // ask_profile: the model learned a fact about the user (state, age, ...).
    // Persist it so it is never asked for again, across turns and sessions.
    // Both field NAMES and VALUES are validated: a hallucinated or nonsense
    // value (e.g. state "XX") must never reach the profiles table.
    if (action?.type === "ask_profile" && action.fields && typeof action.fields === "object") {
      const F = action.fields as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      const US_STATES = new Set([
        "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
        "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
        "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
        "VA","WA","WV","WI","WY",
      ]);
      if (typeof F.state === "string") {
        const st = F.state.trim().toUpperCase().slice(0, 2);
        if (US_STATES.has(st)) patch.state = st;
      }
      if (typeof F.age === "number" && Number.isFinite(F.age) && F.age >= 13 && F.age <= 120) {
        patch.age = Math.floor(F.age);
      }
      if (typeof F.free_time_hours === "number" && Number.isFinite(F.free_time_hours) &&
          F.free_time_hours >= 0 && F.free_time_hours <= 168) {
        patch.free_time_hours = F.free_time_hours;
      }
      if (typeof F.paycheck_status === "string" && ["yes", "no", "unsure"].includes(F.paycheck_status)) {
        patch.paycheck_status = F.paycheck_status;
      }
      if (typeof F.cash_available === "string" && ["0", "100", "1000", "1001"].includes(F.cash_available)) {
        patch.cash_available = F.cash_available;
      }
      if (typeof F.display_name === "string" && F.display_name.trim().length >= 1) {
        patch.display_name = F.display_name.trim().slice(0, 40);
      }
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        await supabase.from("profiles").update(patch).eq("id", user.id);
      }
    }

    // Deterministic proactivity guard: if there are due reminders and the
    // model didn't mention them, prepend a natural heads-up. The model
    // sometimes drops reminders on greetings; this makes it reliable.
    let finalReply = reply;
    if (reminders?.length) {
      const rl = reply.toLowerCase();
      const missed = (reminders as any[]).filter((r) => {
        const msg = String(r.message ?? r.route_id ?? "").toLowerCase();
        const keywords = msg.split(/\W+/).filter((w) => w.length > 4).slice(0, 4);
        return keywords.length > 0 && !keywords.some((k) => rl.includes(k));
      });
      if (missed.length) {
        const headsUp = missed
          .map((r) => `Quick heads-up: ${r.message ?? r.route_id}.`)
          .join(" ");
        finalReply = headsUp + "\n\n" + reply;
      }
    }

    // Deterministic scam guard: if the message matches known scam patterns and
    // the model reply lacks any debunk/warning language, prepend a clear
    // warning. Scam defense must be reliable, not model-nondeterministic.
    const SCAM_PATTERNS: Array<[RegExp, string]> = [
      [/recruit.*(friend|people).*pay|pay.*recruit|pyramid/i,
       "That recruit-people-who-pay structure is a pyramid scheme — illegal and it collapses, with the people at the bottom losing money."],
      [/gift\s?card/i,
       "Anyone asking for payment in gift cards is running a scam — legitimate work never asks for gift cards."],
      [/guaranteed.*(income|money|\$)|risk-free/i,
       "There's no such thing as guaranteed or risk-free income — that's the language scams use."],
      [/wire.*back|deposit.*check.*wire|double.*crypto|send.*btc/i,
       "That's a classic scam pattern — don't send money or share bank/crypto details."],
      [/bank\s?log\s?in|bank\s?(password|credential)|share.*(bank|account).*(login|password|credential)|dm me your/i,
       "Never share your bank login or account credentials with anyone — that's a phishing scam, and it's how accounts get drained. No legitimate offer needs your bank login."],
      [/pay.*\$.*(unlock|secret list|fee.*start)|background.check.*fee/i,
       "Legitimate earning routes never charge you upfront to start — upfront fees are a scam red flag."],
    ];
    {
      const rl = finalReply.toLowerCase();
      const hasDebunk = /scam|red flag|pyramid|ponzi|fraud|phishing|too good|stay away|warning|don't (do|send|pay)|never/i.test(rl);
      if (!hasDebunk) {
        for (const [pat, warning] of SCAM_PATTERNS) {
          if (pat.test(message)) {
            finalReply = `⚠️ ${warning}\n\n` + finalReply;
            break;
          }
        }
      }
    }

    // Honest reminder failure: if the reminder insert failed above, say so
    // plainly instead of letting the model claim it was set.
    if (reminderFailed) {
      finalReply += `\n\nQuick heads-up: I tried to save that reminder but it didn't stick (technical hiccup on my end). Want me to try again?`;
    }
    // Safety net: the model sometimes promises a reminder in words without
    // emitting the set_reminder action (the words alone do nothing). Catch the
    // lie in flight rather than letting the user believe it's set.
    const reminderPromiseCaught = !reminderFailed && action?.type !== "set_reminder" &&
        /i('ve| have) set a reminder|reminder (is )?set|i'll remind you/i.test(finalReply);
    if (reminderPromiseCaught) {
      finalReply += `\n\nQuick correction: I said I'd set a reminder just now, but it didn't actually save. Tell me again and I'll make sure it sticks.`;
      // Learning: the model promised without acting — record it so the
      // lesson ("words don't save reminders") is injected next time.
      recordChatLesson(supabase, user.id, {
        kind: "chat_caught", scope: "global", category: "reminder_promise",
        title: "Promised a reminder in words without the set_reminder action",
        what_happened: `Reply said a reminder was set but no set_reminder action was emitted (thread ${tid.slice(0, 8)}).`,
        what_to_do_instead: "Never tell the user a reminder is set in words alone — words save nothing. Only the set_reminder action (or the deterministic reminder path) actually creates it.",
        signal: finalReply.slice(0, 200),
      });
    }

    // Learning: count this reply as an application of the injected lessons
    // when the reply survived grounding (a violated reply learned nothing).
    if (chatLessons.length && violations.length === 0) {
      supabase.rpc("agent_lessons_note_applied", {
        p_ids: chatLessons.map((l) => l.id),
      }).then(() => {}, () => {});
    }

    return json(cors, { thread_id: tid, reply: finalReply, action });
  } catch (e) {
    console.error(e);
    return json(cors, { error: "internal" }, 500);
  }
});

function json(cors: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

// ================= Learning from mistakes (2026-09-28) =================
// The chat side of the agent's failure memory. Caught mistakes (grounding
// violations, false no-route claims, reminder promises without actions) and
// user corrections are recorded as lessons; before the model call, lessons
// relevant to the message are injected into the prompt so the agent applies
// what it learned instead of repeating the mistake. Relevance, correction
// detection, and prompt rendering are pure shared functions (./_shared/
// lessons.ts — the same ones the real-trust fixtures exercise); only the
// DB reads/writes live here.

/** Open lessons (global + the user's own) relevant to this message. */
async function fetchChatLessons(
  supa: any, userId: string, message: string,
): Promise<ChatLesson[]> {
  try {
    const { data } = await supa.from("agent_lessons")
      .select("id, category, scope, title, what_to_do_instead, times_seen")
      .eq("resolved", false)
      .or(`user_id.is.null,user_id.eq.${userId}`)
      .order("times_seen", { ascending: false })
      .limit(20);
    const rows = (data ?? []) as ChatLesson[];
    return rows.filter((l) => lessonRelevant(l, message)).slice(0, 3);
  } catch {
    return []; // lesson fetch must never break chat
  }
}

/**
 * Record a chat-side lesson. Deterministic categories dedupe per
 * (user, scope, category) — a repeat sighting bumps times_seen instead of
 * adding a row. User corrections are never deduped: each one is its own
 * record. The caller treats this as fire-and-forget (it never throws).
 */
async function recordChatLesson(
  supa: any, userId: string,
  lesson: {
    kind: string; scope: string; category: string; title: string;
    what_happened: string; what_to_do_instead: string; signal?: string;
  },
): Promise<void> {
  try {
    // Atomic caller-owned upsert via record_agent_lesson (SECURITY DEFINER).
    // The old select+update path was RLS-denied (no UPDATE policy on
    // agent_lessons) so repeated lessons silently failed to increment.
    const { error } = await supa.rpc("record_agent_lesson", {
      p_kind: lesson.kind,
      p_scope: lesson.scope,
      p_category: lesson.category,
      p_title: lesson.title,
      p_what_happened: lesson.what_happened,
      p_what_to_do_instead: lesson.what_to_do_instead,
      p_signal: lesson.signal ?? "",
    });
    if (error) throw error;
  } catch (e) {
    console.error("recordChatLesson failed:", (e as Error)?.message);
  }
}

/**
 * detectUserCorrection and renderLessonsBlock live in ./_shared/lessons.ts
 * (shared with the real-trust fixtures) — imported at the top of this file.
 */

// Resolve {{name}}/{{email}}/{{state}} step placeholders with the user's real
// values (plain text in chat; the app renders tap-to-copy chips for the same
// placeholders). Module-level so deterministic helpers can use it.
function resolvePlaceholders(
  t: string,
  vals: { name: string; email: string; state: string }
): string {
  return String(t).replace(
    /\{\{(name|email|state)\}\}/g,
    (_m, k: string) => vals[k as keyof typeof vals] || _m
  );
}

// Parse a reminder "when" into an ISO datetime. Accepts ISO strings, "tomorrow",
// "in N hours|days|weeks"; anything else defaults to 24h from now.
function parseDueAt(when: unknown): string {
  const now = Date.now();
  if (typeof when === "string") {
    const t = when.trim().toLowerCase();
    if (t === "tomorrow") return new Date(now + 24 * 3600000).toISOString();
    const rel = t.match(/^in\s+(\d+)\s*(hour|day|week)s?$/);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const mult = rel[2] === "hour" ? 3600000 : rel[2] === "day" ? 86400000 : 7 * 86400000;
      return new Date(now + n * mult).toISOString();
    }
    const parsed = Date.parse(when);
    if (!isNaN(parsed) && parsed > now - 60000) return new Date(parsed).toISOString();
  }
  return new Date(now + 24 * 3600000).toISOString();
}


// Beta-test fix (2026-09-24): when the user says "walk me through step 1" /
// "yes, do it" right after a recommendation, the message names no provider.
// Fall back to the most recent route id the ASSISTANT mentioned in this
// thread (e.g. "**Mindswarms** (R7242)") before asking "which route?".
function lastMentionedRouteId(hist: { role: string; content: string }[]): string | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.role !== "assistant") continue;
    // LAST match in the message: the plan stack names its top pick last
    // ("My pick to start with: ... (R3445)"), so "walk me through step 1"
    // resolves to the pick, not the first-listed route. Beta fix 2026-09-24:
    // first-match semantics resolved TELUS (listed #1) instead of Userfeel
    // (the actual pick, named last).
    const ms = String(h.content ?? "").match(/\((R\d{3,})\)/g);
    if (ms && ms.length) return ms[ms.length - 1].slice(1, -1);
  }
  return null;
}

// Deterministic fast-path: answer factual questions about verified routes
// directly from the card, no LLM call. Returns null if the question isn't
// a safe factual pattern (falls through to the model).
function tryFastPath(
  message: string,
  routes: RouteCard[],
  playbookRoute?: RouteCard,
  agentVals?: { name: string; email: string; state: string },
  hist: { role: string; content: string }[] = []
): string | null {
  const msg = message.toLowerCase().trim();
  // Never fast-path: guarantees, scams, advice, comparisons, unknowns.
  // These need the model's judgment (honesty dimension).
  if (/\b(guarantee|scam|legit|safe|worth it|should i|best|vs|versus|compare|how much.*(earn|make)|income|tax)\b/i.test(msg)) {
    return null;
  }
  // FIX (2026-09-28, route-hijack): what counts as "naming" a route.
  // Words match on WORD BOUNDARIES, not substrings — "ally"⊂"actually",
  // "appen"⊂"happen", "lowe"⊂"lowered", "star"⊂"started" were hijacking
  // unrelated messages. A route is named only on DISTINCTIVE words: 2+
  // distinct non-generic words, or 1 word that names at most 2 providers
  // catalog-wide (rarity). Single common words ("five"→Five Star Credit
  // Union on "say hello in five words"; "credit"→63 credit unions on "my
  // credit score dropped") never claim the message. Generic words are
  // excluded from names too ("bonus" in name AND category scored 2 on
  // "track my progress toward the signup bonus").
  const wordInMsg = (w: string) => new RegExp(`\\b${w}\\b`).test(msg);
  const contentWords = (r: RouteCard) =>
    `${r.provider ?? ""} ${r.name ?? ""} ${r.category ?? ""}`.toLowerCase()
      .split(/[^a-z]+/).filter((w) => w.length > 3 && !isGenericProviderWord(w));
  const wordProvCount = new Map<string, number>();
  for (const r of routes)
    for (const w of new Set(contentWords(r)))
      wordProvCount.set(w, (wordProvCount.get(w) ?? 0) + 1);
  const matchedWords = (r: RouteCard): Set<string> =>
    new Set(contentWords(r).filter(wordInMsg));
  const isNamedRoute = (r: RouteCard): boolean => {
    const ws = [...matchedWords(r)];
    return ws.length >= 2 || (ws.length === 1 && (wordProvCount.get(ws[0]) ?? 99) <= 2);
  };
  // Discovery: "what offers do you have" / "what should I try" with no named
  // provider -> deterministic list of verified routes. Reliable (no model
  // nondeterminism), fast, and honest (only verified routes, marked as such).
  if (/\b(what.*(offers?|have|available)|show me|list.*offers?|what should i (try|do)|recommend|which.*(offers?|apps?))\b/i.test(msg)) {
    // Verification questions about a specific (possibly unknown) provider are
    // NOT discovery — they need the model's honesty judgment, not a list.
    if (/\b(is|are|was)\b[^?.]{0,60}\bverif/i.test(msg) || /\bverif[^?.]{0,40}\b(is|are)\b/i.test(msg)) {
      return null;
    }
    const namesProvider = routes.some(isNamedRoute);
    if (namesProvider) return null; // let the specific-route path answer
    // Only routes verified within the last 7 days may be called "live right
    // now" — a stale card must never be listed as a live offer.
    const fresh7 = (r: RouteCard) =>
      r.status === "researched" && r.verified_at &&
      Date.now() - new Date(r.verified_at).getTime() < 7 * 24 * 3600 * 1000;
    const live = routes.filter(fresh7);
    if (live.length > 0) {
      const lines = live.slice(0, 6).map(
        (r) => `• ${r.provider} (${r.name}) — verified ✓ — ${r.payout_text ?? "see terms"}`
      );
      return `Here are the offers I've personally verified and have live right now:\n\n` +
        lines.join("\n") +
        `\n\nWant me to walk you through any of these step by step? Just name one.`;
    }
    return null;
  }
  // Find which verified route the question is about.
  // Priority: explicit provider/name in the message beats the active playbook.
  // (A user mid-Fetch-walkthrough asking about Rakuten must get Rakuten.)
  // When several routes share a provider (e.g. Chase checking vs Chase credit
  // card), prefer the one whose name/category words appear in the message.
  // Matching uses isNamedRoute (word boundaries + distinctiveness, see above).
  // Disambiguation prefers more matched words. (History: name-substring
  // matching once hijacked safety-critical messages — "DM me your bank login"
  // matched a route whose NAME contained "bank".)
  const named = routes
    .filter(isNamedRoute)
    .sort((a, b) => matchedWords(b).size - matchedWords(a).size)[0];
  const threadRouteId = lastMentionedRouteId(hist);
  const threadRoute = threadRouteId
    ? routes.find((r) => r.route_id === threadRouteId)
    : undefined;
  const route = named ?? playbookRoute ?? threadRoute;
  if (!route) return null;
  const fresh =
    route.status === "researched" && route.verified_at &&
    Date.now() - new Date(route.verified_at).getTime() < 7 * 24 * 3600 * 1000;
  if (!fresh) return null;

  // Guard (2026-09-28, extended after feature-#1 test): cancellation, billing,
  // charge, refund, dispute, and subscription intents must NEVER get a route-
  // card answer — not from the named-route fallback AND not from any pattern
  // handler above. "Give me the exact steps and the direct link to cancel it
  // myself" was returning the thread's last-mentioned EARN route (Voice123
  // R0381) via the "link" pattern because the guard sat below the handlers.
  // Inflected forms included: "billed through Apple" was matching the Apple
  // Trade In buyback card because the guard only knew base forms.
  // Cancellation/billing questions go to the model / cancel-path capability.
  if (/\b(bill(s|ed|ing)?|charg(e|es|ed)|refund(s|ed)?|disputes?|subscriptions?|cancel(l)?(ed|ing)?|cancellation)\b/i.test(msg)) return null;

  const catches = Array.isArray(route.catches) ? route.catches : route.catches ? [String(route.catches)] : [];
  // Comprehensive brief: the question asks about 2+ aspects (payout + rules +
  // eligibility). Compose a full deterministic brief from the card — faster
  // and more complete than the model, and every fact is card-grounded.
  const aspects = [
    /\b(payout|paid|pay out|cash out|redeem|minimum|timing|fees?)\b/i,
    /\b(requirement|eligible|qualify|who can join|age|where.*available)\b/i,
    /\b(receipt|rules?|terms|catch|convert|points)\b/i,
  ];
  const aspectHits = aspects.filter((a) => a.test(msg)).length;
  if (aspectHits >= 2) {
    const lines: string[] = [`**${route.provider}** (${route.name}) — verified ✓ (route ${route.route_id})`, ""];
    lines.push(`**Payout:** ${route.payout_text ?? "see official terms"}${route.payout_timing ? ` — ${route.payout_timing}` : ""}`);
    const who: string[] = [];
    if (route.min_age != null) who.push(`age ${route.min_age}+`);
    if (route.geo_notes) who.push(route.geo_notes);
    if (who.length) lines.push(`**Who can join:** ${who.join(", ")}`);
    if (catches.length) lines.push(`**Key rules:** ${catches.join("; ")}`);
    if (route.exclusions) lines.push(`**Exclusions:** ${route.exclusions}`);
    if (route.provider_url) lines.push(`**Official link:** ${route.provider_url}`);
    lines.push("", "Want me to walk you through it step by step?");
    return lines.join("\n");
  }
  // "how does X work" / "what is X" / "tell me about X"
  if (/\b(how does|what is|tell me about|explain)\b/i.test(msg)) {
    const steps = route.steps.slice(0, 3).map((s, i) => `${i + 1}. ${resolvePlaceholders(s.text, agentVals ?? { name: "", email: "", state: "" })}`).join("\n");
    return `${route.name} (${route.provider}) — route ${route.route_id}.\n\n` +
      `Here's how it works:\n${steps}\n\n` +
      `Payout: ${route.payout_text ?? "see terms"} (${route.payout_timing ?? "timing varies"}).\n` +
      (catches.length ? `\nHeads up: ${catches[0]}` : "") +
      `\n\nWant me to walk you through it step by step?`;
  }
  // "requirements" / "do I need" / "eligible"
  if (/\b(requirements?|eligib(le|ility)|do i need|what do i need|qualify)\b/i.test(msg)) {
    const parts: string[] = [];
    if (route.min_age != null) parts.push(`Age ${route.min_age}+`);
    if (route.geo_notes) parts.push(route.geo_notes);
    if (route.exclusions) parts.push(`Exclusions: ${route.exclusions}`);
    if (!parts.length) return null;
    return `${route.name} requirements (route ${route.route_id}):\n` +
      parts.map((p) => `• ${p}`).join("\n");
  }
  // "how do I get paid" / "payout" / "cash out" / "how much per receipt"
  if (/\b(payout|paid|pay out|cash out|redeem|withdraw|\bpay\b.*receipt|per receipt)\b/i.test(msg)) {
    return `${route.name} payout (route ${route.route_id}):\n` +
      `• ${route.payout_text ?? "See the official terms for payout details."}\n` +
      `• Timing: ${route.payout_timing ?? "varies"}\n` +
      `• Honest read: actual pay per receipt varies and depends on the receipt and retailer — ` +
      `treat any figure as roughly that, not a guaranteed amount.`;
  }
  // "is X available in [country]" / "does X work in [place]"
  if (/\b(available in|work in|offered in|support.*in)\b/i.test(msg)) {
    return `${route.name} availability (route ${route.route_id}): ${route.geo_notes ?? "see official terms"}.`;
  }
  // General eligibility: "I'm 25, can I use X?" / "Can I use X in Texas?"
  // Combines age + geo from the card. Deterministic and fast.
  if (/\b(can i (use|join)|am i eligible|do i qualify)\b/i.test(msg)) {
    const parts: string[] = [];
    if (route.min_age != null) parts.push(`Age ${route.min_age}+`);
    if (route.geo_notes) parts.push(route.geo_notes);
    if (route.exclusions) parts.push(`Exclusions: ${route.exclusions}`);
    if (!parts.length) return null;
    // If the user stated their age, give a direct yes/no.
    const ageMatch = msg.match(/\b(i'm|i am|age)\s*(\d{1,3})\b/i) || msg.match(/\b(\d{1,3})\s*(-|\s)?years?\s*(-|\s)?old\b/i);
    let verdict = `Here's who can use ${route.name} (route ${route.route_id}):`;
    if (ageMatch && route.min_age != null) {
      const age = parseInt(ageMatch[2] ?? ageMatch[1], 10);
      if (!isNaN(age)) {
        verdict = age >= route.min_age
          ? `Yes, you're good to go — at ${age} you meet the age requirement for ${route.name} (route ${route.route_id}):`
          : `Not yet — ${route.name} needs age ${route.min_age}+ (route ${route.route_id}), so at ${age} you can't join solo:`;
      }
    } else {
      verdict = `Here's who can use ${route.name} (route ${route.route_id}):`;
    }
    const payoutLine = [route.payout_text, route.payout_timing].filter(Boolean).join(" — ");
    return verdict + "\n" +
      parts.map((p) => `• ${p}`).join("\n") +
      (payoutLine ? `\n• Payout: ${payoutLine}` : "");
  }
  // Rules/catches: "what happens if I stop using" / "how long do I have" / "fees" / "what's the catch"
  if (/\b(expire|inactive|stop using|how long.*(upload|submit)|fee|charge|catch|downside|fine print)\b/i.test(msg) && catches.length) {
    return `${route.name} rules to know (route ${route.route_id}):\n` +
      catches.map((c) => `• ${c}`).join("\n");
  }
  if (/\b(\d+\s*(-|\s)?year\s*(-|\s)?old|how old|age (limit|requirement))\b/i.test(msg)) {
    const parts: string[] = [];
    if (route.min_age != null) parts.push(`Minimum age: ${route.min_age}`);
    if (route.geo_notes && /under 18|parent|guardian/i.test(route.geo_notes))
      parts.push(`Under 18 needs a parent/guardian (${route.geo_notes})`);
    else if (route.geo_notes) parts.push(route.geo_notes);
    if (!parts.length) return null;
    return `${route.name} age rules (route ${route.route_id}):\n` +
      parts.map((p) => `• ${p}`).join("\n");
  }
  // "link" / "where do I sign up" / "download"
  if (/\b(link|sign up|signup|download|where.*(start|app|site))\b/i.test(msg)) {
    const steps = route.steps.slice(0, 4).map((s, i) => `${i + 1}. ${resolvePlaceholders(s.text, agentVals ?? { name: "", email: "", state: "" })}`).join("\n");
    const stepsBlock = steps
      ? `\n\nExact steps to start earning:\n${steps}\n\nCheck the official site if anything looks different — steps change over time.`
      : `\n\nStart at Step 1: ${route.steps[0]?.text ?? "follow the on-screen steps"}.`;
    return `Here's the official site for ${route.name} (route ${route.route_id}):\n${route.provider_url}${stepsBlock}`;
  }
  // Named-route fallback: the message names a specific verified route but no
  // question pattern above matched. Answer from the card directly instead of
  // falling through to the model — the model only sees the top 60 routes in
  // its prompt, so it would wrongly claim routes outside that window don't
  // exist. This keeps every named verified route answerable and honest.
  // Question-aware hedging: earnings questions never get a promised amount.
  if (named) {
    const lines: string[] = [`**${named.provider}** (${named.name}) — verified ✓ (route ${named.route_id})`, ""];
    lines.push(`**Payout:** ${named.payout_text ?? "see official terms"}${named.payout_timing ? ` — ${named.payout_timing}` : ""}`);
    if (catches.length) lines.push(`**Biggest catch:** ${catches[0]}`);
    if (named.provider_url) lines.push(`**Official link:** ${named.provider_url}`);
    if (/\bhow much will i (make|earn)\b/i.test(msg)) {
      lines.push(`I can't promise a specific amount — it depends on how much you use it, and varies person to person.`);
    } else if (/\bguarantee/i.test(msg)) {
      lines.push(`I can't guarantee speed or earnings — no honest route can promise that.`);
    }
    lines.push("", "Want me to walk you through it step by step?");
    return lines.join("\n");
  }
  return null;
}
