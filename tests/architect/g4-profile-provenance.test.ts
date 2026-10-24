// G4 review (coordinator, 2026-10-24): the server prepare's real profile reader. The connected flow (flow-connected.test.ts)
// hands prepareAhead a profile built by hand, so it never runs storedProfile (workers/career-browser/prepare-ahead.ts),
// which reads what the chat stored in agent_flow_state. Here the profile is written by the chat's own writers and stored
// the way the chat stores it, on a real Postgres:
//   brain   career_tools.ts confirm_profile_fact with its event recorded: confirmed, with the owner's provenance and the
//           confirmation event (WO-102 evidence)                                           -> trusted
//   brain   the same tool when the event could not be recorded: confirmed, nothing stamped  -> never trusted
//   router  CareerProfile.confirmFact (122, the router path): confirmed, no event            -> never trusted
//   brain   confirmed with its event, then corrected (correct_profile_fact): a draft again, still carrying the old
//           event (updateFact merges the correction)                                       -> never trusted
//   draft   read from the resume, never confirmed                                          -> never trusted
//   legacy  a fact with no status, no confirmation and no provenance (a shape a reader meets) -> never trusted
//   lost    a stored row that kept its provenance but lost its confirmation event (no chat writer leaves one; a copy or
//           restore can)                                                                   -> never trusted
// and each person's threads hold more than one profile: an older thread's, and a row claiming another owner.
// What is checked is what prepareAhead hands on: the facts file the engine is given (judged by the engine's own
// trustedManifest, as scripts/apply.ts does), the resume it prints (the renderer's own input, line by line with the facts
// each line cites), and what the cover-letter drafter's model is given. The engine is a stub that reads the facts file and
// stops on a cover-letter question; nothing opens a page.
import { pgBinDir, startPg } from "../flow/pg.ts";
import { prepareAhead, storedProfile, tailoredResume, trustedProfile } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { trustedManifest } from "../../extension/src/apply_core.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000a1", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000000a2";
const T_NEW = "00000000-0000-4000-8000-0000000a0001", T_OLD = "00000000-0000-4000-8000-0000000a0002", T_FOREIGN = "00000000-0000-4000-8000-0000000a0003";
const POSTING = { job_id: "greenhouse:provtest:1", company: "TEST Provenance Employer" };
const LETTER = "I built a reporting dashboard in React and Python used by 200 internal users at TEST Systems Inc, and I built " +
  "DeployBoard in Go to deploy containerised apps on Kubernetes for 12 student teams. I want to bring that work to TEST Provenance Employer.";

const tools = (events: { add: (e: unknown) => Promise<void> } | null) =>
  careerTools({ postings: async () => [], events: events as any });
const recorded: unknown[] = [];
const keeps = { add: async (e: unknown) => { recorded.push(e); }, recall: async () => [] };
const loses = { add: async () => { throw new Error("TEST: the event store is down"); }, recall: async () => [] };
// One chat turn's tool call, as the brain makes it: the person's own message this turn, the profile in the thread's state.
async function chat(profile: any, events: any, tool: string, input: Record<string, unknown>, message: string, added: string[] = []) {
  const t = tools(events).find((x) => x.name === tool)!;
  return await t.run(input, { userId: PERSON, threadId: T_NEW, now: Date.UTC(2026, 9, 24, 12), state: { profile }, turn: { message, added, before: "" } } as any);
}
const byText = (p: any, re: RegExp) => p.facts.find((f: any) => re.test(String(f.text))).id as string;

// The person's profile as the chat leaves it: their resume read in (every entry a draft), then what they confirmed.
async function chatProfile() {
  const p = (CareerProfile as any).createProfile({ basics: { name: "Flow Tester", email: "flow.tester@example.test", location: "Chicago, IL" } });
  assert((CareerProfile as any).ingestResume(p, { text: await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`), fileName: "t.txt" }).ok);
  const ids = {
    systems: byText(p, /TEST Systems Inc/), deploy: byText(p, /DeployBoard/), capital: byText(p, /Example Capital/),
    club: byText(p, /Investing Club/), marketsim: byText(p, /MarketSim/),
  };
  // Brain, event kept: their plain yes to facts shown in an earlier turn.
  await chat(p, keeps, "confirm_profile_fact", { id: ids.systems }, "yes, that's right");
  await chat(p, keeps, "confirm_profile_fact", { id: ids.deploy }, "yes");
  const phone = (await chat(p, keeps, "add_profile_fact", { kind: "other", text: "My phone number is +1 555 0100" }, "my phone number is +1 555 0100") as any).fact.id;
  await chat(p, keeps, "confirm_profile_fact", { id: phone }, "yes, correct");
  // Brain, confirmed and then corrected: it waits for their yes again, with the earlier event still on it.
  await chat(p, keeps, "confirm_profile_fact", { id: ids.marketsim }, "yes");
  await chat(p, keeps, "correct_profile_fact", { id: ids.marketsim, text: "Built DCF and comparable-company models in Excel for 9 fictional companies" },
    "it was 9 fictional companies, not 8");
  // Brain, event lost: confirmed, nothing stamped.
  await chat(p, loses, "confirm_profile_fact", { id: ids.club }, "yes");
  // Router (122): confirmed without an event.
  (CareerProfile as any).confirmFact(p, ids.capital);
  const country = (CareerProfile as any).addFact(p, { kind: "other", text: "My country of residence is United States", needs_confirmation: true, status: "draft" }).id;
  (CareerProfile as any).confirmFact(p, country);
  // Legacy: no status, no confirmation, no provenance.
  p.facts.push({ id: "F-LEGACY", kind: "project", text: "Built the ZETAQUANT risk engine used by 300 traders" });
  // Lost: confirmed, with the owner's provenance, but no confirmation event.
  p.facts.push({ id: "F-NOEVENT", kind: "project", text: "Built the QUILLMARK pricing model for 30 clients", title: "", status: "confirmed",
    needs_confirmation: false, provenance: "owner confirmed in chat (2026-09-01T00:00:00.000Z)" });
  return { p, ids: { ...ids, phone, country } };
}

Deno.test({
  name: "G4 review: the stored profile reader keeps the chat's provenance, and only facts with it reach the engine, the resume or the drafter",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    const pg = await startPg();
    try {
      const { p, ids } = await chatProfile();
      const f = (id: string) => p.facts.find((x: any) => x.id === id);
      // What the chat wrote, before anything reads it.
      assert(f(ids.systems).provenance?.startsWith("owner confirmed in chat") && f(ids.systems).confirmation_event_id, "the brain stamps its confirmations");
      assert(f(ids.club).status === "confirmed" && !f(ids.club).confirmation_event_id, "an unrecorded event stamps nothing");
      assert(f(ids.capital).status === "confirmed" && !f(ids.capital).confirmation_event_id, "the router confirms without an event");
      assert(f(ids.marketsim).status === "draft" && f(ids.marketsim).confirmation_event_id, "a corrected fact is a draft that still carries its old event");
      const TRUSTED = [ids.systems, ids.deploy, ids.phone].sort();
      // An older thread's profile, and a row in their threads claiming another owner (newest of all).
      const old = (CareerProfile as any).createProfile({ basics: { name: "Flow Tester" } });
      const oldFact = (CareerProfile as any).addFact(old, { kind: "project", text: "Built the OLDTHREAD inventory tool in Excel for 5 stores", needs_confirmation: true, status: "draft" });
      Object.assign(oldFact, { needs_confirmation: false, status: "confirmed", provenance: "owner confirmed in chat (2026-09-01)", confirmation_event_id: crypto.randomUUID() });
      const foreign = { ...structuredClone(p), user_id: OTHER };
      const state = (profile: unknown) => JSON.stringify({ career: { stores: { profile } } }).replace(/'/g, "''");
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'flow.tester@example.test'), ('${OTHER}', 'other@example.test');
        insert into public.profiles (id) values ('${PERSON}'), ('${OTHER}');
        insert into public.agent_threads (id, user_id) values ('${T_OLD}', '${PERSON}'), ('${T_NEW}', '${PERSON}'), ('${T_FOREIGN}', '${PERSON}');
        insert into public.agent_flow_state (thread_id, user_id, state, updated_at) values
         ('${T_OLD}', '${PERSON}', '${state(old)}', now() - interval '2 days'),
         ('${T_NEW}', '${PERSON}', '${state(p)}', now() - interval '1 hour'),
         ('${T_FOREIGN}', '${PERSON}', '${state(foreign)}', now());
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_apply_questions (user_id, key, kind, label, type, state, answer, answered_at) values
         ('${PERSON}', 'fact:first_name', 'fact', 'First name', 'input_text', 'answered', 'Flow', now()),
         ('${PERSON}', 'fact:last_name', 'fact', 'Last name', 'input_text', 'answered', 'Tester', now()),
         ('${PERSON}', 'fact:email', 'fact', 'Email', 'input_text', 'answered', 'flow.tester@example.test', now());
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
         values ('${POSTING.job_id}', 'greenhouse', 'provtest', '${POSTING.company}', 'TEST Analyst', 'Chicago, IL',
          'https://boards.greenhouse.io/provtest/jobs/1', 'TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.', now(), now());
        insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON}', 'alert:${POSTING.job_id}', 'alert', 'TEST alert', now());`);
      const svc = pg.asService();
      const admin = { rpc: (name: string, args?: unknown) => svc.rpc(name, args) };

      await t.step("the reader: their newest own thread's profile, provenance exactly as the chat wrote it", async () => {
        const read = await storedProfile(admin)(PERSON);
        assert(read, "a profile is read");
        eq(read.user_id, PERSON);
        assert(read.facts.some((x: any) => x.id === ids.systems), "the newest of their own threads, never an older one");
        assert(!read.facts.some((x: any) => /OLDTHREAD/.test(x.text)), "not the older thread's");
        for (const id of [ids.systems, ids.deploy, ids.phone]) {
          const [a, b] = [read.facts.find((x: any) => x.id === id), f(id)];
          eq([a.status, a.needs_confirmation, a.provenance, a.confirmation_event_id], [b.status, b.needs_confirmation, b.provenance, b.confirmation_event_id], id);
        }
        eq(await storedProfile(admin)(OTHER), null, "a row claiming another owner is nobody's profile");
      });

      await t.step("the trust filter: only facts with the owner's confirmation event survive", () => {
        const kept = trustedProfile(p, PERSON, []);
        eq(kept!.facts.map((x: any) => x.id).sort(), TRUSTED);
        eq(trustedProfile({ ...p, user_id: OTHER }, PERSON, []), null, "another owner's profile is not filtered into theirs");
      });

      // prepareAhead, as the worker composes it, over the seeded database.
      const files: any[] = [], printed: any[] = [], drafted: unknown[] = [];
      const render = edgeRenderer();
      const deps = {
        db: svc, profileFor: storedProfile(admin), urlFor: () => "http://127.0.0.1:9/never-opened",
        resumeFor: tailoredResume({ render: async (doc: any) => { printed.push(doc); return await render(doc); }, resumes: memoryResumeStore() }),
        runEngine: async (args: string[]) => {
          files.push(JSON.parse(await Deno.readTextFile(args[args.indexOf("--facts") + 1])));
          return { result: { state: "not_submitted", reason: "needs_answers", posting: POSTING.job_id, company: "provtest",
            questions: [{ label: "Cover letter", type: "textarea", options: [] }] } } as any;
        },
        draftModel: async (payload: unknown) => { drafted.push(payload); return { content: [{ type: "text", text: LETTER }], stop_reason: "end_turn" }; },
      };
      let done: any[] = [];
      await t.step("prepare: it runs on what the reader returned", async () => {
        done = await prepareAhead(deps);
        eq(done.map((r) => [r.job_id, r.outcome]), [[POSTING.job_id, "asked"]], JSON.stringify(done));
        eq([files.length, printed.length, drafted.length], [1, 1, 1], "the engine, the resume and the drafter each ran once");
      });

      await t.step("the engine's facts: only the trusted facts, and the engine's own contract keeps nothing else", () => {
        const file = files[0];
        eq((file.facts ?? []).map((x: any) => x.id).sort(), TRUSTED, "the facts file holds only facts with the owner's confirmation event");
        const m = trustedManifest({ owner: PERSON, file, rows: file.text_answers ?? [], resume: null });
        eq(m.answers.phone?.value, "+1 555 0100", "the brain-confirmed phone answers the phone field");
        eq(m.answers.country, undefined, "the router-confirmed country answers nothing");
        for (const a of Object.values(m.answers) as any[]) {
          assert(TRUSTED.includes(a.factId) || String(a.factId).startsWith("text-answer:"), `trusted: ${a.factId}`);
        }
      });

      await t.step("the resume: every printed line cites only trusted facts", () => {
        const cited = [...new Set(printed[0].lines.flatMap((l: any) => l.factIds ?? []))] as string[];
        assert(cited.includes(ids.systems), `the resume prints their confirmed work: ${cited.join(",")}`);
        for (const id of cited) assert(TRUSTED.includes(id), `the resume prints ${id}, which has no confirmation event`);
      });

      await t.step("the drafter: its model is given only trusted facts", () => {
        const sent = JSON.stringify(drafted[0]);
        assert(sent.includes("TEST Systems Inc"), "their confirmed work");
        for (const w of ["Example Capital", "Investing Club", "MarketSim", "9 fictional companies", "ZETAQUANT", "QUILLMARK", "OLDTHREAD"]) {
          assert(!sent.includes(w), `the model was given ${w}`);
        }
      });
    } finally {
      await pg.stop();
    }
  },
});
