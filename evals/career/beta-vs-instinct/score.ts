// BETA VS INSTINCT: the pure scoring rules (no I/O), shared by run.ts and run.test.ts.
//
// Every criterion in cases.json is scored here. "Code" kinds are checked against the reply and the account rows; a
// "judge" kind is a semantic question. A judge criterion carries a deterministic proxy (det / det_not / det_min /
// det_words_max) so the default run needs no model at all; `--judge` replaces the proxy with Claude Haiku through the
// Claude CLI on the owner's subscription (run.ts claudeJudge). The proxy is coarse on purpose: it asks whether the reply
// contains the thing the person asked for (a role name, a timed plan, a "no"), not whether it is well written.

export type Crit = {
  id: string; k: string; when?: "empty" | "seeded"; v?: string[]; what?: string; min?: number; max?: number; n?: number; re?: string; q?: string;
  det?: string; det_not?: string; det_min?: number; det_all?: boolean; det_words_max?: number;
};
export type Case = { id: string; feature: string; input: string; after?: string[]; needs?: string; excluded?: string; live?: boolean; input_note?: string; criteria: Crit[]; instinct?: any; title?: string };
export type Rec = {
  case: string; state: string; input: string; status: number; reply: string; intent: string | null; result_status: string | null; contained: boolean;
  brain: string | null; router_intent: string | null; layer: string; handler: string; router_ms: number; router_calls: number; turn_ms: number; cpu_ms: number;
  model_calls: number; brain_tools: string[]; file_tool_offered: boolean; files: string[]; roles: number; links: number; file_words?: number;
  writes: Record<string, [number, number]>; profile_changed: boolean; outbound: string[]; meta_keys: string[]; setup?: string[];
  criteria: Record<string, { pass: boolean | null; why: string; kind: string }>; pass: boolean | null; bucket: string[]; score?: number; delivered?: boolean | null; guards?: boolean;
};
export type Verdict = { pass: boolean | null; why: string };

export const SCRIPTED = "SCRIPTED BRAIN REPLY: the staged brain answered this turn (no live model in this benchmark).";
export const GENERIC = /I'm Trainee, a career agent: I find roles|I'm not sure which part of your search that's about|I did not catch what to do with that one|I may have missed what you meant/;
export const URLS = /https?:\/\/[^\s)>\]"]+/g;
// Bookkeeping every turn writes (thread, messages, cost, rate limit, turn record, the account version counter, the
// conversation frame). The career_watch_kv and agent_flow_state TABLE counts are bookkeeping too: a real kv write is
// caught by its key (counts() reads every kv key as "kv:<key>"), so the table-level count is not a second signal.
export const IGNORE_WRITE = /^(agent_turn_costs|agent_rate_limits|agent_threads|agent_messages|agent_flow_state|career_watch_kv|career_turn_gate.*|career_turns?|career_turn_.*|career_events|model_budget.*|career_spend.*)$/;
export const IGNORE_KV = /^kv:(career:thread|career:snapshot|career:results|career:list|career:account$|career:role-results|career:apply-all|career:turn)/;
export const EFFECT_TABLES = /^(career_send_queue|career_apply_jobs|career_email_log|career_outbox|career_cloud_runs|career_apply_submissions)$/;

export function words(s: string) { return s.split(/\s+/).filter(Boolean).length; }
export function draftBody(reply: string) {
  const lines = reply.split("\n");
  const subj = lines.findIndex((l) => /^\s*(subject|re):/i.test(l));
  const hi = lines.findIndex((l) => /^\s*(hi|hello|dear)\b/i.test(l));
  const at = subj >= 0 ? subj : hi;
  return at >= 0 ? lines.slice(at).join("\n") : lines.slice(1).join("\n");
}
// Practice questions: sentences ending in "?", or labelled ones ("Question 3: Tell me about ...", "Q3.") as a File writes them.
export function questionCount(text: string) {
  const qs = new Set<string>();
  for (const m of text.matchAll(/[^?\n.!]{8,}\?/g)) qs.add(m[0].trim().toLowerCase());
  const labelled = new Set([...text.matchAll(/\b(?:question|q)\s*(\d{1,2})\s*[:.)]/gi)].map((m) => m[1]));
  return Math.max(qs.size, labelled.size);
}
// A draft shown in the reply: a Subject line anywhere (router templates inline it mid-paragraph), or a salutation to
// sign-off block.
export function hasDraftText(reply: string) {
  return /\bsubject:\s*\S/i.test(reply) || /(^|\n)\s*(hi|hello|dear)\b[^\n]*,?\s*\n[\s\S]{20,}\n\s*(thanks|thank you|best|sincerely|regards)/i.test(reply);
}

// The deterministic proxy for a judge criterion. null when the criterion has none.
export function proxy(c: Crit, reply: string): Verdict | null {
  if (c.det === undefined && c.det_not === undefined && c.det_words_max === undefined) return null;
  const why: string[] = [];
  let ok = true;
  if (c.det !== undefined) {
    const re = new RegExp(c.det, "gi");
    // det_min counts DISTINCT matches (three different role names), or every match with det_all (three timed steps,
    // two of which may both be "10 min").
    const all = [...reply.matchAll(re)].map((m) => m[0].toLowerCase().trim());
    const hits = c.det_all ? all : [...new Set(all)];
    const need = c.det_min ?? 1;
    if (hits.length < need) { ok = false; why.push(`${hits.length}/${need} of /${c.det.slice(0, 60)}/`); }
    else why.push(`matched ${[...hits].slice(0, 3).map((h) => `"${h.slice(0, 30)}"`).join(", ")}`);
  }
  if (c.det_not !== undefined) {
    const m = reply.match(new RegExp(c.det_not, "i"));
    if (m) { ok = false; why.push(`must not say "${m[0].slice(0, 40)}"`); }
  }
  if (c.det_words_max !== undefined) {
    const n = words(reply);
    if (n > c.det_words_max) { ok = false; why.push(`${n} words > ${c.det_words_max}`); }
  }
  if (GENERIC.test(reply)) { ok = false; why.push("generic fallback text"); }
  return { pass: ok, why: `proxy: ${why.join("; ")}` };
}

export function scoreDet(c: Crit, r: Rec, body: any): Verdict {
  const reply = r.reply, brain = r.layer === "staged_brain";
  const unmeasured = (why: string) => ({ pass: null, why: `UNMEASURED (scripted brain): ${why}` });
  switch (c.k) {
    case "no_effect": {
      const eff = Object.entries(r.writes).filter(([t, [a, b]]) => EFFECT_TABLES.test(t) && b > a).map(([t]) => t);
      const out = r.outbound.filter((o) => !/^GET /.test(o));
      return { pass: !eff.length && !out.length, why: eff.length || out.length ? `effect rows ${eff.join(",")} outbound ${out.join(",")}` : "nothing left the account" };
    }
    case "not_generic":
      // The scripted marker is never generic, so on a brain turn this check would pass for free: unmeasured instead.
      if (brain) return unmeasured("the reply is the scripted marker, not a real answer");
      return r.contained || GENERIC.test(reply) ? { pass: false, why: r.contained ? "containment fallback" : "generic catchall text" } : { pass: true, why: "specific reply" };
    case "intent_not": {
      const v = c.v ?? [];
      const hit = v.includes(String(r.intent)) || (v.includes(String(r.router_intent)) && !brain);
      return hit ? { pass: false, why: `intent ${r.intent}` } : { pass: true, why: `intent ${r.intent}${r.router_intent ? ` (router ${r.router_intent})` : ""}` };
    }
    case "file": {
      if (r.files.length) return { pass: true, why: `files: ${r.files.join(", ")}` };
      if (brain) return { pass: false, why: r.file_tool_offered ? "brain had create_file/attach_document but the scripted model made none (UNMEASURED content)" : "brain answered with NO file tool offered (create_file/attach_document absent): no artifact path" };
      return { pass: false, why: "no File or document came back" };
    }
    case "count": {
      const n = c.what === "roles" ? r.roles : c.what === "links" ? r.links : questionCount(reply + "\n" + (body?.__fileText ?? ""));
      if (brain && c.what === "questions") return unmeasured(`${n} questions in the scripted reply`);
      const ok = (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
      return { pass: ok, why: `${c.what}=${n}` };
    }
    case "words_max": { if (brain) return unmeasured("draft length"); const n = words(draftBody(reply)); return { pass: n <= (c.n ?? 0) && !GENERIC.test(reply), why: `${n} words` }; }
    case "draft": {
      const meta = body?.meta ?? {};
      const card = !!(meta.offer_card || meta.email_card || meta.card_id);
      const text = hasDraftText(reply);
      if (brain && !card) return unmeasured("draft text");
      const sent = Object.entries(r.writes).some(([t, [a, b]]) => EFFECT_TABLES.test(t) && b > a);
      return { pass: (card || text) && !sent, why: card ? `draft card on meta (${Object.keys(meta).filter((k) => /card/.test(k)).join(",")})` : text ? "quoted draft in the reply" : "no draft shown" };
    }
    case "no_profile_change": return { pass: !r.profile_changed, why: r.profile_changed ? "facts changed" : "facts unchanged" };
    case "no_write": {
      const w = Object.entries(r.writes).filter(([t, [a, b]]) => a !== b && !IGNORE_WRITE.test(t) && !IGNORE_KV.test(t)).map(([t]) => t);
      return { pass: !w.length, why: w.length ? `wrote ${w.join(",")}` : "no account write" };
    }
    case "mentions": if (brain) return unmeasured("wording"); return { pass: new RegExp(c.re!, "i").test(reply), why: `/${c.re}/` };
    case "not_mentions": if (brain) return unmeasured("the scripted marker names nothing"); return { pass: !new RegExp(c.re!, "i").test(reply), why: `must not match /${c.re}/` };
    case "honest_empty": {
      if (brain) return unmeasured("empty-record wording");
      const ok = !GENERIC.test(reply) && !r.contained && /\b(no|none|nothing|not yet|haven't|hasn't|don't have|do not have|empty|isn't|aren't|not on (file|record))\b/i.test(reply);
      return { pass: ok, why: ok ? "says the record is not there" : "does not say the record is missing" };
    }
    case "judge": {
      if (brain) return unmeasured("semantic quality is the Opus arm's and S3's job");
      const file = String(body?.__fileText ?? "");
      if (c.det_words_max !== undefined && file) return proxy(c, file) ?? { pass: null, why: "no proxy" };
      return proxy(c, file ? `${reply}\n${file}` : reply) ?? { pass: null, why: "no deterministic proxy; run with --judge" };
    }
  }
  return { pass: null, why: `unknown kind ${c.k}` };
}

// Guards are the "did nothing it should not" checks; everything else is a deliverable the prompt asked for (an answer at
// all, the right route, links, a File, a count, a draft, the asked-for content).
export const GUARD_KINDS = new Set(["no_effect", "no_write", "no_profile_change"]);
// PRIMARY METRIC per record: were all the requested deliverables verifiably produced? true / false / null (unverified:
// some deliverable could not be measured, i.e. the scripted brain answered, and none failed).
export function recDeliverable(r: Pick<Rec, "criteria">): boolean | null {
  const d = Object.values(r.criteria).filter((c) => !GUARD_KINDS.has(c.kind));
  if (d.some((c) => c.pass === false)) return false;
  if (!d.length || d.some((c) => c.pass === null)) return null;
  return true;
}
export function recGuards(r: Pick<Rec, "criteria">): boolean {
  return Object.values(r.criteria).filter((c) => GUARD_KINDS.has(c.kind)).every((c) => c.pass !== false);
}
// One number per record: measured criteria met / measured. Unmeasured criteria do not count either way.
export function recScore(r: Pick<Rec, "criteria">): number | null {
  const m = Object.values(r.criteria).filter((c) => c.pass !== null);
  return m.length ? m.filter((c) => c.pass).length / m.length : null;
}
export function recPass(r: Pick<Rec, "criteria">): boolean | null {
  const vals = Object.values(r.criteria).map((x) => x.pass);
  return vals.some((v) => v === false) ? false : vals.every((v) => v === true) ? true : null;
}

// ------------------------------------------------------------------------------------------------ root-cause buckets
const NEG = /\b(do not|don't|dont|never|without|no|not|nothing)\b([^.?!;]*)/gi;
const TRIGGERS: Record<string, RegExp> = {
  career_application_fields: /\bappl(y|ication)|\bask\b|form/i, career_erase_confirm: /delet|erase/i, career_watch_manage: /alert|watch/i, career_watch_create: /alert|watch/i,
  intent_refusal: /invent|claim|guess/i, tracking_digest: /digest|schedul/i, career_batch_apply: /appl/i, outreach_clarification: /email|contact|send|guess/i,
  career_approval_rule: /send|approv/i, career_discovery: /role|job|posting/i, tracking_status: /send|submit/i, company_intel: /company|fact/i, prep_brief: /interview|company/i,
};
export function negationHit(input: string, intent: string | null): boolean {
  if (!intent || !TRIGGERS[intent]) return false;
  const neg = [...input.matchAll(NEG)].map((m) => m[2]).join(" ");
  const rest = input.replace(NEG, " ");
  return TRIGGERS[intent].test(neg) && !TRIGGERS[intent].test(rest);
}
// Constraint or count words that leaked into the searched role text ("I found no posting for three realistic ...").
export const LEAK = /\bI found no posting for ([^:]*?)(?: in [A-Z][^:]*)?:/;
export function searchLeak(reply: string): string | null {
  const m = reply.match(LEAK);
  if (!m) return null;
  const bad = m[1].match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+|realistic|send|links?|do|contact|anyone|only|current|postings?|company|exist|does)\b/gi);
  return bad ? bad.join(" ") : null;
}
export function buckets(r: Rec, cs: Case): string[] {
  if (r.pass !== false) return [];
  const failed = cs.criteria.filter((c) => r.criteria[c.id]?.pass === false);
  if (r.criteria.no_effect?.pass === false && !failed.some((c) => c.id === "no_effect")) failed.push({ id: "no_effect", k: "no_effect" });
  const out = new Set<string>();
  if (r.status !== 200 || r.cpu_ms > 2000) out.add("cpu_or_turn_error");
  if (r.layer === "containment") out.add("containment_generic_fallback");
  else if (failed.some((c) => c.k === "not_generic")) out.add("router_catchall_template");
  if (r.layer !== "staged_brain" && searchLeak(r.reply)) out.add("search_query_polluted_by_count_or_constraint_words");
  if (r.layer !== "staged_brain" && negationHit(r.input, r.intent)) out.add("negation_read_as_intent");
  if (failed.some((c) => c.k === "intent_not" || (c.k === "not_mentions" && c.id === "on_topic")) && !out.has("negation_read_as_intent")) out.add("greedy_keyword_matcher");
  if (failed.some((c) => c.k === "file")) out.add("missing_artifact_path");
  if (cs.needs && r.state === "seeded" && failed.length) out.add("missing_batch_executor_or_approval_binding");
  const deliverable = failed.filter((c) => ["count", "draft", "words_max", "judge", "mentions", "honest_empty"].includes(c.k));
  if (deliverable.length && r.layer !== "staged_brain" && r.layer !== "containment" && !out.has("router_catchall_template") && !out.has("greedy_keyword_matcher") && !out.has("negation_read_as_intent") && !out.has("search_query_polluted_by_count_or_constraint_words")) out.add("template_beats_requested_deliverable");
  if (failed.some((c) => c.k === "no_effect")) out.add("external_effect");
  if (failed.some((c) => c.k === "no_profile_change" || c.k === "no_write")) out.add("unrequested_write");
  if (!out.size) out.add("other");
  return [...out];
}

// ------------------------------------------------------------------------------------------------ the Claude CLI child
// Subscription billing only: the CLI switches to API billing silently when either variable is set, so both are removed
// from the child environment (and the child gets a cleared env built from this copy).
export function cliEnv(env: Record<string, string>): Record<string, string> {
  const e = { ...env };
  delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN;
  return e;
}
// The subscription gate, run once before the first CLI call of a run: the init event of a stream-json call must report
// apiKeySource "none" (the owner's subscription). Anything else stops the run before any graded call is made.
export async function subscriptionGate(check: () => Promise<string>): Promise<void> {
  const src = await check();
  if (src !== "none") throw new Error(`STOP: the Claude CLI is not on subscription billing (apiKeySource=${src}); no call was made`);
}
export const CLI_ARGS = (model: string) => ["-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config"];
