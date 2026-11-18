// ag/ma-06-card-terms (2026-11-17; source: ag/mass-apply-10 ebc53ab1f, 9ca014147, 911c6d2d1). The card a person says one yes
// to names each application's ROLE beside its employer, the posting's own terms (where, the pay and the apply-by date exactly
// as posted) and a "Why it fits" line from the person's CONFIRMED facts only. Before, the card the hosted preparation pushed
// read "1. Lumen" and the answers, so three Data Analyst roles at three employers read as three company names.
// Display only: none of these lines is part of what the yes approves. Each item stays bound to the payload hash the database
// stored for its prepared application (career_apply_prepared.payload_hash, read back by career_apply_card_open_as), and the
// card's own hash is over those payload hashes (D-MS-1, D-R9-2). The last test pins that the lines change neither which
// applications a card opens nor the hashes it carries.
import assertNode from "node:assert/strict";
import { cardFor, cardTurn, type CardStore, fitLine, type Prepared, postedTerms, postingDetailLines, withRoles } from "../../../supabase/functions/_shared/career_apply_cards.ts";
import { handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

Deno.test("the posting's own pay and deadline, as written; none when it states none", () => {
  eq(postedTerms("Software Engineering Intern. Requirements: Python. Pay: $42-$48 per hour. Apply by December 15, 2026. Summer 2026 internship."), { pay: "$42-$48 per hour", deadline: "December 15, 2026" });
  eq(postedTerms("Data Analyst. Salary: $70,000-$85,000. Entry level."), { pay: "$70,000-$85,000", deadline: null });
  eq(postedTerms("Backend intern. Applications close January 10, 2027."), { pay: null, deadline: "January 10, 2027" });
  eq(postedTerms("Competitive pay and great benefits. Apply soon."), { pay: null, deadline: null }, "no amount, no date: nothing guessed");
  eq(postedTerms("Apply by Friday. Pay: depends on experience."), { pay: null, deadline: null }, "a weekday is not a date; words are not pay");
  eq(postingDetailLines({ location: "Remote (US)", description: "Pay: $45 per hour." }), ["Where: Remote (US)", "Pay (as posted): $45 per hour"]);
});

Deno.test("the card names the role and the posting's terms above the answers, and still carries every answer line", () => {
  const p = { id: "p1", company: "Northwind", card_lines: ["Northwind", "Email: a@example.test", "Sends to https://boards.greenhouse.io/northwind/jobs/9101"], role: "Software Engineering Intern",
    details: postingDetailLines({ location: "Chicago, IL", description: "Pay: $42-$48 per hour. Apply by December 15, 2026." }) };
  const c = cardFor([p]) as { text: string };
  assert(c.text.includes("1. Northwind — Software Engineering Intern\n   Where: Chicago, IL\n   Pay (as posted): $42-$48 per hour\n   Apply by (as posted): December 15, 2026\n   Email: a@example.test"), c.text);
  for (const l of p.card_lines.slice(1)) assert(c.text.includes(l), l);
});

// A service-role client double for withRoles: the attempts that link each prepared application to its posting, the postings,
// and (when given) career_apply_profile_for.
const admin = (postings: any[], attempts: any[], profile?: unknown) => ({
  from: (t: string) => ({ select: () => ({ eq: () => ({ in: async () => ({ data: t === "career_apply_prepare_attempts" ? attempts : [] }) }), in: async () => ({ data: t === "career_postings" ? postings : [] }) }) }),
  ...(profile === undefined ? {} : { rpc: async (name: string) => (name === "career_apply_profile_for" ? { data: profile } : { data: null }) }),
});

Deno.test("the hosted preparation's pushed card: role and posted terms from describe (before: '1. Lumen' and the answers only)", async () => {
  const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123", U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
  const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1", LEASE = "11111111-2222-4333-8444-0000000000f1";
  const row = { id: RID, user_id: U, job_ids: ["greenhouse:lumen:801"], lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const ready = [{ id: "cccccccc-bbbb-4ccc-8ddd-0000000000f3", company: "Lumen", card_lines: ["Lumen", "Email: a@example.test"], created_at: new Date().toISOString() }];
  let pushed = "";
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    describe: (user: string, rows: any[]) => withRoles(admin([{ job_id: "greenhouse:lumen:801", title: "Data Analyst", company: "Lumen", location: "Chicago, IL", description: "Salary: $70,000-$85,000." }],
      [{ prepared_id: "cccccccc-bbbb-4ccc-8ddd-0000000000f3", posting_job_id: "greenhouse:lumen:801" }]), user, rows),
    rpc: async (name: string, args: any) => {
      if (name === "career_apply_prepare_request_ready") return ready;
      if (name === "career_apply_questions_open_as" || name === "career_apply_prepare_candidates_for" || name === "career_apply_prepare_request_questions") return [];
      if (name === "career_apply_card_push_requested_for") { pushed = args.p_text; return "dddddddd-bbbb-4ccc-8ddd-0000000000f4"; }
      if (name === "career_apply_prepare_request_finish") return { state: "done" };
      throw Error(name);
    } };
  const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), outcomes: [{ job_id: "greenhouse:lumen:801", outcome: "ready", detail: "" }] }, deps as any);
  eq((out.body as any).push, "shown");
  assert(pushed.includes("1. Lumen — Data Analyst\n   Where: Chicago, IL\n   Pay (as posted): $70,000-$85,000\n   Email: a@example.test"), pushed);
});

Deno.test("why it fits: the posting's requirements a CONFIRMED fact names, and only those; none confirmed, no line", async () => {
  eq(fitLine("Data Analyst. Requirements: SQL, Python, dashboards, statistics.", ["Built a reporting dashboard in React and Python", "Cut reporting time by automating data pulls from PostgreSQL using SQL"]),
    "Why it fits: it asks for SQL, Python, which your confirmed resume has");
  eq(fitLine("Requirements: Go, Kubernetes.", []), null);
  eq(fitLine("Requirements: Rust.", ["Python"]), null);
  eq(fitLine("No requirements listed here", ["Python"]), null);
  const posting = [{ job_id: "greenhouse:lumen:801", title: "Data Analyst", company: "Lumen", location: "Chicago, IL", description: "Requirements: SQL, Python, Go." }];
  const linked = [{ prepared_id: "p1", posting_job_id: "greenhouse:lumen:801" }];
  // Only a fact that is confirmed, needs no confirmation and carries its confirmation event counts; a draft "Go" never does.
  const facts = { facts: [{ text: "Python and SQL dashboards", status: "confirmed", needs_confirmation: false, confirmation_event_id: "e1" }, { text: "Go", status: "draft", needs_confirmation: true },
    { text: "Go services", status: "confirmed", needs_confirmation: false }] };
  const [p] = await withRoles(admin(posting, linked, facts), "u1", [{ id: "p1", company: "Lumen", card_lines: ["Lumen"] }]);
  assert((p.details ?? []).includes("Why it fits: it asks for SQL, Python, which your confirmed resume has"), JSON.stringify(p.details));
  // The profile unreadable: no fit line, and the rest of the card as before.
  const [q] = await withRoles({ ...admin(posting, linked), rpc: async () => { throw Error("down"); } }, "u1", [{ id: "p1", company: "Lumen", card_lines: ["Lumen"] }]);
  eq(q.role, "Data Analyst");
  assert(!(q.details ?? []).some((l) => /Why it fits/.test(l)), JSON.stringify(q.details));
});

Deno.test("display only: the role, terms and fit lines change neither which applications the card opens nor the hashes it carries", async () => {
  const base: Prepared[] = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", company: "Lumen", card_lines: ["Lumen", "Email: a@example.test"], resume_sha256: "a".repeat(64), created_at: "2026-11-17T10:00:00Z" },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", company: "Kite", card_lines: ["Kite", "Phone: +1 555 010 0000"], resume_sha256: "a".repeat(64), created_at: "2026-11-17T10:00:01Z" },
  ];
  const described: Prepared[] = base.map((p, i) => ({ ...p, role: ["Data Analyst", "Analyst"][i],
    details: postingDetailLines({ location: "Remote", description: "Requirements: SQL. Pay: $40 per hour. Apply by December 15, 2026." }, ["SQL reporting"]) }));
  // The hashes a card carries come from the database's prepared rows (payload_hash), keyed by the prepared id; the text plays no part.
  const PAYLOAD_HASH: Record<string, string> = { [base[0].id]: "1".repeat(64), [base[1].id]: "2".repeat(64) };
  const run = async (pending: Prepared[]) => {
    const opened: string[][] = [];
    const store: CardStore = {
      pending: async () => pending,
      open: async (_u, ids) => { opened.push(ids); return { id: "cccccccc-0000-4000-8000-000000000001", items: ids.map((id, i) => ({ n: i + 1, prepared_id: id, payload_hash: PAYLOAD_HASH[id] })), shown_at: "2026-11-17T10:01:00Z" }; },
      latestOpen: async () => null, answer: async () => [], lastAssistantIntent: async () => null, lastShownCard: async () => null,
    };
    const r = await cardTurn({ message: "show my applications", userId: "u1", threadId: "t1", now: Date.parse("2026-11-17T10:01:00Z"), store, resumeReady: async () => true });
    return { opened, reply: r?.reply ?? "" };
  };
  const plain = await run(base), shown = await run(described);
  eq(shown.opened, plain.opened, "the same applications, in the same order");
  eq(plain.opened, [[base[0].id, base[1].id]]);
  assert(shown.reply.includes("Pay (as posted): $40 per hour") && shown.reply.includes("Why it fits: it asks for SQL"), shown.reply);
  assert(!plain.reply.includes("Pay (as posted)"), plain.reply);
  // Every answer line the database checks the card carries is still on it, verbatim.
  for (const p of base) for (const l of p.card_lines.slice(1)) assert(shown.reply.includes(l), l);
  // The lines are never written into the prepared application itself: the card lines (what preparation stored beside its
  // payload) are unchanged by withRoles.
  const [w] = await withRoles(admin([{ job_id: "greenhouse:lumen:801", title: "Data Analyst", company: "Lumen", location: "Remote", description: "Pay: $40 per hour." }],
    [{ prepared_id: base[0].id, posting_job_id: "greenhouse:lumen:801" }]), "u1", [{ ...base[0] }]);
  eq(w.card_lines, base[0].card_lines);
});
