// R10 F.3 (stop/pause truth): the two send paths that did not read the account pause now do, on Postgres 16 with every
// migration (20261109120000_career_pause_send_paths.sql), Gmail faked at the HTTP boundary, no model call:
//   - career_send_go, the check before each email of a claimed batch: paused mid-batch, the email already sent stays sent
//     and the rest go back to queued (held, not failed), and go after the explicit resume;
//   - career_outreach_action_claim: a paused person's approved replies-lane actions (a calendar invite here) are passed
//     over, still approved, and taken once they resume.
// The pause is the record the chat's pause writes: career_watch_kv career:account paused (career_user_quiet reads it).
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";
import { CI, startWorld, tokenOf, uidOf, type Person, type World } from "./scenarios/journeys-r2-world.ts";
import { approvedDrafts, draftsReader } from "../flow/send-rail-fixture.ts";
import { serviceRpc } from "../flow/pgwire.ts";
import { queueApprovedOutreach } from "../../supabase/functions/_shared/career_send_rail.ts";
import { proposeEvent, supabaseRepliesStore } from "../../supabase/functions/_shared/career_outreach_replies.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const RUN = crypto.randomUUID().slice(0, 4);
const at = (local: string) => `${local}.${RUN}@example.test`;

Deno.test({
  name: "R10 F.3 send paths: a pause stops a claimed email batch and the replies lane's approved actions",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const ids = [940001, 940002, 940003];
    const w: World = await startWorld({ tokens: Object.fromEntries(ids.map((j) => [tokenOf(j), uidOf(j)])) });
    const rpc = serviceRpc(w.conn as any);
    const outreachDeps = { ...rpc, drafts: draftsReader(w.conn as any) };
    const railDb = { sql: w.conn } as any;
    const setPaused = (p: Person, on: boolean) => w.sql(`update public.career_watch_kv set value = jsonb_set(value, '{paused}', '${on}') where user_id = ${q(p.uid)} and key = 'career:account'`);
    const quiet = async (p: Person) => (await w.sql(`select public.career_user_quiet(${q(p.uid)})`)) === "t";
    const states = (p: Person) => w.json<{ state: string; n: number }>(`select state, count(*)::int n from public.career_send_queue where user_id = ${q(p.uid)} group by state order by state`);
    try {
      await t.step("career_send_go: a claimed email of a paused person is stopped, untried; unpaused it may go", async () => {
        const p = await w.addPerson(ids[0], 0);
        await w.connectGmail(p);
        await w.web(p, "hi"); // the account record exists
        const [d] = await approvedDrafts(railDb, p.uid, [at("go1")]);
        eq((await queueApprovedOutreach(outreachDeps, p.uid, [d])).map((x) => x.status), ["queued"]);
        const claim = await w.admin.rpc("career_send_claim", { p: { worker: `t-go-${RUN}`, accounts: 50, per_account: 5, lease_seconds: 60 } });
        const item = (claim.data?.accounts ?? []).flatMap((a: any) => a.items ?? []).find((x: any) => x.source_id === d.draftId);
        eq(!!item, true, `setup: claimed: ${JSON.stringify(claim)}`);
        await setPaused(p, true);
        eq(await quiet(p), true);
        eq((await w.admin.rpc("career_send_go", { p: { worker: `t-go-${RUN}`, id: item.id } })).data, "stop", "paused after the claim: the email does not go");
        await setPaused(p, false);
        eq((await w.admin.rpc("career_send_go", { p: { worker: `t-go-${RUN}`, id: item.id } })).data, "go", "the same email may go once unpaused");
        await w.sql(`update public.career_send_queue set state = 'queued', lease_owner = null, lease_until = null where id = ${q(item.id)};
          update public.career_send_accounts set lease_owner = null, lease_until = null where user_id = ${q(p.uid)}`);
      });

      await t.step("paused in the middle of a claimed batch: the email already sent stays sent, the rest are held (queued, not failed)", async () => {
        const p = await w.addPerson(ids[1], 1);
        await w.connectGmail(p);
        await w.web(p, "hi");
        const items = await approvedDrafts(railDb, p.uid, [at("mb1"), at("mb2"), at("mb3")]);
        eq((await queueApprovedOutreach(outreachDeps, p.uid, items)).map((x) => x.status), ["queued", "queued", "queued"]);
        const before = w.gmail.sent.length;
        // The pause lands right after Gmail accepts the first email, while the worker still holds the batch.
        const orig = w.gmail.fetch;
        let paused = false;
        w.gmail.fetch = async (input: Request | URL | string, init?: RequestInit) => {
          const res = await orig(input, init);
          const req = input instanceof Request && !init ? input : new Request(input as any, init);
          if (!paused && req.method === "POST" && new URL(req.url).pathname.endsWith("/messages/send") && res.ok) { paused = true; await setPaused(p, true); }
          return res;
        };
        try { await w.sendWorker(); } finally { w.gmail.fetch = orig; }
        eq(await quiet(p), true, "setup: paused mid-batch");
        eq(w.gmail.sent.length - before, 1, "only the email sent before the pause went out");
        eq(await states(p), [{ state: "queued", n: 2 }, { state: "sent", n: 1 }], "the rest are held, not failed");
        await w.sql(`update public.career_send_queue set next_at = now() where user_id = ${q(p.uid)} and state = 'queued'`);
        await w.sendWorker();
        eq(w.gmail.sent.length - before, 1, "nothing goes while paused");
        eq((await w.web(p, "resume career work")).intent, "career_resumed");
        await w.sql(`update public.career_send_queue set next_at = now() where user_id = ${q(p.uid)} and state = 'queued'`);
        await w.sendWorker();
        eq(w.gmail.sent.length - before, 3, "after the resume the held emails go, once each");
      });

      await t.step("career_outreach_action_claim: a paused person's approved calendar invite is passed over, still approved, and taken after resume", async () => {
        const p = await w.addPerson(ids[2], 2);
        await w.web(p, "hi");
        const store = supabaseRepliesStore(w.admin);
        const now = Date.now();
        const id = await store.track({ user_id: p.uid, draft_id: null, provider: "gmail", provider_thread: `th-${RUN}`, email: at("cal"), name: "Avery Synthetic", firm: "Beta", subject: "Hello", sent_at: new Date(now - 86_400_000).toISOString() });
        await store.applyReply(p.uid, id, `m-${RUN}`, "wants_call", new Date(now).toISOString(), { who: "contact" });
        const a = (await proposeEvent({ store, userId: p.uid, threadId: id, slot: { start: new Date(now + 3 * 86_400_000).toISOString(), end: new Date(now + 3 * 86_400_000 + 1_800_000).toISOString(), person: "Thu 10:00" } as any, now }))!;
        eq((await store.approve(p.uid, a.batch_id, [{ n: a.n, hash: a.hash }], now)).length, 1, "setup: the invite is approved");
        await setPaused(p, true);
        const claim = (worker: string) => w.admin.rpc("career_outreach_action_claim", { p_worker: worker, p_limit: 50, p_per_user: 5, p_now: new Date().toISOString(), p_lease_seconds: 60 });
        const held = await claim(`t-ac1-${RUN}`);
        eq((held.data ?? []).filter((x: any) => x.user_id === p.uid).length, 0, `nothing of theirs is claimed while paused: ${JSON.stringify(held)}`);
        eq(await w.sql(`select status from public.career_outreach_actions where id = ${q(a.id)}`), "approved", "still approved, untouched");
        await setPaused(p, false);
        const taken = await claim(`t-ac2-${RUN}`);
        eq((taken.data ?? []).filter((x: any) => x.id === a.id).map((x: any) => x.status), ["running"], "taken once they resume");
      });
    } finally {
      await w.stop();
    }
  },
});
