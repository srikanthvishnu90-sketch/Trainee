// ONE CONFIRMED RESUME (migration 20261026120018, docs/architect/RESUME-FLOW-2026-10-26.md), on real Postgres in CI's
// migration order (tests/flow/provision-pg.sh). Each person is a brand-new user who behaves the way people do: sends a
// file on one channel and applies on another, pastes on a text channel and expects the cloud to apply, swaps the resume
// halfway through, deletes it, tries tricks. Every assertion reads database state.
//
//   (1) Telegram file, then the web card: the record is the file (bytes kept, hashed by the database), the cloud keeps
//       exactly that file, a card approved on the web queues it, the person's computer claims it, the cloud's read of a
//       cloud job returns those bytes; anything else carried is refused "no_resume".
//   (2) A paste on a text channel, then the cloud: the record is the paste, the cloud keeps no file; an application
//       carrying the paste's text as a file is refused; a render stored after the confirmation is allowed, and the
//       cloud's read of it returns nothing to attach.
//   (3) Changing the resume mid-flow: the approved-but-not-sent application with the old file is removed from the queue,
//       the prepared one is discarded (and can be prepared again), the old render stops counting, the cloud keeps only
//       the new file, the profile prepares only from the new resume's entries, a stale card approves nothing.
//   (4) Deleting it: every copy gone, everything bound stopped, nothing can be queued, claimed or prepared, the profile
//       holds no resume entries; an account erase does the same.
//   (5) Tricks: another person's message, a message whose text differs from the event's hash, a file whose stored bytes
//       don't hash to the event, an unknown upload kind, the same resume twice: none writes or changes the record.
//   (0) Switch off (as merged): a person with no record is untouched (today's behavior); a person with one still gets
//       change and delete stopped, and the paste's text is never the file; a render the database can't tie to the
//       record is not refused while off.
//   (6) Switch on (the owner's go-live step): no record, refused; earlier unbound queued rows closed as not sent.
//   Steps (1) to (5) run with the switch on.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { deleteReply, parseResumeCommand, statusReply } from "../../supabase/functions/_shared/career_resume_record.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const DAY = 86_400_000;
const VIA = "router: their yes to the resume entries shown to them";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const shaBytes = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as BufferSource));
const shaText = (s: string) => shaBytes(new TextEncoder().encode(s));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const q = (s: string) => `$q$${s}$q$`;

// PR #194's upload table (20261026210016), the columns this rule reads; created here only when that PR is not applied.
const UPLOADS_194 = `create table if not exists public.career_resume_uploads (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 channel text not null, provider_ref text not null, filename text not null, mime text not null, bytes integer not null,
 sha256 text not null, content_b64 text not null, message_sha256 text not null, created_at timestamptz not null default now());`;

function skip() {
  if (pgBinDir()) return false;
  if (CI) throw Error("the one-resume test needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
}

class World {
  constructor(public pg: Pg) {}
  async person() {
    const u = crypto.randomUUID();
    await this.pg.sql(`insert into auth.users (id) values ('${u}'); insert into public.profiles (id) values ('${u}');
      insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    return u;
  }
  // The person's own message in their thread, as the chat stores it; returns its id.
  async message(u: string, text: string) {
    const t = await this.pg.sql(`insert into public.agent_threads (user_id, title) values ('${u}', 'chat') returning id`);
    return await this.pg.sql(`insert into public.agent_messages (thread_id, role, content) values ('${t.split("\n")[0]}', 'user', ${q(text)}) returning id`);
  }
  // What the chat's evidence step writes for each entry the person confirmed (career_router_evidence.ts).
  async confirm(u: string, upload: { kind: string; ref: string; sha256: string }, entries = 2, via = VIA) {
    for (let i = 0; i < entries; i++) {
      const detail = { id: `f${i}`, kind: "experience", confirmation_event_id: crypto.randomUUID(), message_sha256: "0".repeat(64), upload, via };
      await this.pg.sql(`insert into public.career_events (user_id, kind, subject, detail, source) values ('${u}', 'fact_confirmed', 'entry ${i}', ${q(JSON.stringify(detail))}::jsonb, 'chat')`);
    }
  }
  async pasteAndConfirm(u: string, text: string) {
    const id = await this.message(u, text);
    const sha = await shaText(text);
    await this.confirm(u, { kind: "message", ref: `agent_messages:${id}`, sha256: sha });
    return sha;
  }
  async telegramFile(u: string, bytes: Uint8Array, name: string) {
    await this.pg.sql(UPLOADS_194);
    const sha = await shaBytes(bytes);
    const id = await this.pg.sql(`insert into public.career_resume_uploads (user_id, channel, provider_ref, filename, mime, bytes, sha256, content_b64, message_sha256)
      values ('${u}', 'telegram', 'telegram:AgAD${u.slice(0, 4)}', ${q(name)}, 'application/pdf', ${bytes.length}, '${sha}', '${b64(bytes)}', '${"1".repeat(64)}') returning id`);
    return { sha, ref: `telegram:AgAD${u.slice(0, 4)} (career_resume_uploads:${id.split("\n")[0]})` };
  }
  record(u: string) {
    return this.pg.sql(`select coalesce((select json_build_object('state', state, 'kind', kind, 'sha256', sha256, 'filename', filename,
      'bytes_b64', encode(bytes, 'base64'), 'generation', generation)::text from public.career_resume_record where user_id = '${u}'), 'null')`).then((s) => JSON.parse(s.replace(/\n/g, "")));
  }
  cloud(u: string) {
    return this.pg.sql(`select coalesce(string_agg(sha256 || ':' || translate(encode(bytes, 'base64'), E'\\n', ''), ',' order by sha256), '') from public.career_apply_cloud_resumes where user_id = '${u}'`);
  }
  payload(u: string, job: string, company: string, resume: string | null) {
    return { version: 1, user_id: u, job_id: job, company, url: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${job}`,
      fields: [{ name: "first_name", value: "Ada" }], privacy_epoch: 0, account_version: 0, expires_at: new Date(Date.now() + DAY).toISOString(),
      ...(resume ? { resume_sha256: resume } : {}) };
  }
  hash(p: unknown) { return this.pg.sql(`select public.career_apply_payload_hash(${q(JSON.stringify(p))}::jsonb)`); }
  async enqueue(p: any) {
    const h = await this.hash(p);
    return await this.pg.asService().rpc("career_apply_enqueue", { p_payload: p, p_hash: h, p_approval: h, p_daily: null });
  }
  // A prepared application (what every prepare stores) and the card that shows it, as the card push writes them.
  async prepare(p: any) {
    const h = await this.hash(p);
    try {
      const id = await this.pg.sql(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
        values ('${p.user_id}', '${p.job_id}', '${p.company}', '${p.url}', ${q(JSON.stringify(p))}::jsonb, '${h}', array['${p.company}']) returning id`);
      return { id: id.split("\n")[0], hash: h, error: null as string | null };
    } catch (e) { return { id: null, hash: h, error: String((e as Error).message) }; }
  }
  async card(u: string, items: { id: string; hash: string; company: string }[]) {
    const its = items.map((x, i) => ({ n: i + 1, prepared_id: x.id, payload_hash: x.hash, company: x.company }));
    return (await this.pg.sql(`insert into public.career_apply_cards (user_id, items, shown_at) values ('${u}', ${q(JSON.stringify(its))}::jsonb, now()) returning id`)).split("\n")[0];
  }
  async render(u: string, sha: string) {
    await this.pg.sql(`insert into storage.buckets (id, name) values ('career-resumes', 'career-resumes') on conflict do nothing;
      insert into storage.objects (bucket_id, name, created_at) values ('career-resumes', '${u}/${sha}.pdf', clock_timestamp())`);
  }
  jobs(u: string) {
    return this.pg.sql(`select coalesce(string_agg(job_id || ':' || state, ',' order by job_id), '') from public.career_apply_jobs where user_id = '${u}'`);
  }
  prepared(u: string) {
    return this.pg.sql(`select coalesce(string_agg(job_id || ':' || state, ',' order by job_id), '') from public.career_apply_prepared where user_id = '${u}'`);
  }
  // The profile the chat keeps (its newest thread's), with entries from the given uploads.
  async profile(u: string, facts: { id: string; kind: string; upload_sha256?: string }[]) {
    const state = { career: { stores: { profile: { facts: facts.map((f) => ({ id: f.id, kind: f.kind, text: f.id, status: "confirmed", needs_confirmation: false,
      confirmation_event_id: `ev-${f.id}`, ...(f.upload_sha256 ? { source_ref: { upload: "x", upload_sha256: f.upload_sha256 } } : {}) })) } } } };
    const t = (await this.pg.sql(`insert into public.agent_threads (user_id, title) values ('${u}', 'p') returning id`)).split("\n")[0];
    await this.pg.sql(`insert into public.agent_flow_state (thread_id, user_id, state, updated_at) values ('${t}', '${u}', ${q(JSON.stringify(state))}::jsonb, now())`);
  }
  async profileIds(u: string) {
    const r = await this.pg.asService().rpc("career_apply_profile_for", { p_user: u });
    eq(r.error, null);
    return (r.data?.facts ?? []).map((f: any) => f.id);
  }
}

const PDF_A = new TextEncoder().encode("%PDF-1.4\n% Ada Lovelace resume A\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PDF_B = new TextEncoder().encode("%PDF-1.4\n% Ada Lovelace resume B, new job added\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PASTE = "ok heres my resume i think lol\n\nADA LOVELACE\nada@example.test\n\nEXPERIENCE\nAnalyst, Babbage & Co (2024-2025)\n- built the engine tables\n\nEDUCATION\nUniversity of London, BSc Mathematics, 2026\n";

Deno.test({ name: "one confirmed resume: entries, readers, change, delete, tricks, switch", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (skip()) return;
  const pg = await startPg();
  const w = new World(pg);
  try {
    await t.step("(0) switch off (as merged): no record, unchanged; a record still stops what the old resume made, and a delete stops everything", async () => {
      const u = await w.person();
      // #194's rule (20261026210016) holds for everyone: a confirmed resume on file and the resume carried stored for them.
      // This person has both, the way #194 knows them (a confirmed entry with its event, a stored render), and no record.
      await pg.sql(confirmedResumeSql(u) + `; insert into storage.buckets (id, name) values ('career-resumes', 'career-resumes') on conflict do nothing;
        insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/${"f".repeat(64)}.pdf')`);
      eq((await w.enqueue(w.payload(u, "o-1", "Acme", "f".repeat(64)))).error, null, "no record: unchanged");
      await w.profile(u, [{ id: "legacy", kind: "experience" }]);
      eq(await w.profileIds(u), ["legacy"], "no record: the profile as before");
      const v = await w.person();
      const first = await w.pasteAndConfirm(v, PASTE);
      // Off, this rule alone lets a resume the database can't tie to the record (a render kept outside storage) through; #194's
      // rule does not: a resume stored nowhere for them is refused either way.
      ok(/no_resume/.test((await w.enqueue(w.payload(v, "o-2", "Acme", "9".repeat(64)))).error?.message ?? ""));
      // ...but the paste's own text never goes as the file, and a change stops what was made before it.
      ok(/no_resume/.test((await w.enqueue(w.payload(v, "o-3", "Globex", first))).error?.message ?? ""));
      await w.pasteAndConfirm(v, PASTE + "\nPROJECTS\nEngine notes (2026)\n");
      eq(await w.jobs(v), "", "approved before the change: removed from the queue");
      ok(/no_resume/.test((await w.enqueue(w.payload(v, "o-2", "Acme", "9".repeat(64)))).error?.message ?? ""), "a resume they replaced is never carried again");
      eq((await pg.asService().rpc("career_resume_delete_as", { p_user: v })).error, null);
      ok(/no_resume/.test((await w.enqueue(w.payload(v, "o-4", "Acme", "8".repeat(64)))).error?.message ?? ""), "after a delete nothing goes");
    });

    await t.step("(6) the owner's switch on: people with no record are refused; their earlier unbound queued rows are closed as not sent, with the reason", async () => {
      const u = (await pg.sql(`select user_id from public.career_apply_jobs where job_id = 'o-1'`)).trim();
      const on = await pg.asService().rpc("career_resume_everyone_on", {});
      ok(/permission denied/.test(on.error?.message ?? ""), "only the owner (database owner) turns it on");
      const res = JSON.parse(await pg.sql(`select public.career_resume_everyone_on()::text`));
      ok(res.closed >= 1, JSON.stringify(res));
      eq(await pg.sql(`select state || '|' || reason from public.career_apply_jobs where user_id = '${u}'`),
        "not_submitted|not sent: it carried a resume other than the one on file (one confirmed resume)");
      ok(/no_resume/.test((await w.enqueue(w.payload(u, "s-2", "Acme", "f".repeat(64)))).error?.message ?? ""));
      eq(await w.profileIds(u), [], "on: no record, nothing to prepare from");
    });

    await t.step("(1) a file sent on Telegram is the one resume; the web card, the person's computer and the cloud all use exactly it", async () => {
      const u = await w.person();
      const f = await w.telegramFile(u, PDF_A, "Ada Resume.pdf");
      await w.confirm(u, { kind: "file", ref: f.ref, sha256: f.sha });
      const r = await w.record(u);
      eq([r.state, r.kind, r.sha256, r.filename, r.bytes_b64.replace(/\n/g, ""), r.generation], ["confirmed", "file", f.sha, "Ada Resume.pdf", b64(PDF_A), 1],
        "one record: the file's bytes, hashed by the database");
      eq(await w.cloud(u), `${f.sha}:${b64(PDF_A)}`, "the cloud keeps exactly that file, nothing else");
      // Their Telegram thread holds the entries; then they open the web app (a newer thread, no entries): every prepare still
      // reads the entries of the resume on file.
      await w.profile(u, [{ id: "tg-exp", kind: "experience", upload_sha256: f.sha }]);
      await w.profile(u, []);
      eq(await w.profileIds(u), ["tg-exp"], "the thread holding the record's entries, not the newest");
      // The web: a card of two prepared applications; the one carrying another file is refused before it is stored.
      const good = await w.prepare(w.payload(u, "gh-1", "Acme", f.sha));
      eq(good.error, null);
      const other = await w.prepare(w.payload(u, "gh-2", "Globex", "a".repeat(64)));
      ok(/no_resume/.test(other.error ?? ""), `a prepared application with another resume is refused: ${other.error}`);
      const none = await w.prepare(w.payload(u, "gh-3", "Initech", null));
      ok(/no_resume/.test(none.error ?? ""), `with no resume at all, refused: ${none.error}`);
      const card = await w.card(u, [{ id: good.id!, hash: good.hash, company: "Acme" }]);
      const ans = await pg.asPerson(u).rpc("career_apply_card_answer_own", { p_card: card, p_approve: [1] });
      eq(ans.error, null);
      eq(ans.data?.[0]?.result, "queued", JSON.stringify(ans.data));
      eq(await w.jobs(u), "gh-1:queued");
      // Their own computer claims it: handed out, with that file.
      const claim = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 6, p_source: "own_computer" });
      eq(claim.error, null);
      eq((claim.data ?? []).map((j: any) => [j.job_id, j.state, j.payload.resume_sha256]), [["gh-1", "driving", f.sha]]);
      // A cloud job carrying it: the cloud's read returns those very bytes.
      eq((await w.enqueue(w.payload(u, "gh-4", "Hooli", f.sha))).error, null);
      await pg.sql(`update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = '${u}', source = 'cloud' where user_id = '${u}' and job_id = 'gh-4'`);
      const id = await pg.sql(`select id from public.career_apply_jobs where user_id = '${u}' and job_id = 'gh-4'`);
      const got = await pg.asService().rpc("career_apply_cloud_resume", { p_id: id, p_lease: u });
      eq([got.data?.sha256, got.data?.b64?.replace(/\n/g, ""), got.data?.filename], [f.sha, b64(PDF_A), "Ada Resume.pdf"]);
      // A row written past every trigger (as a superuser restoring data could) that carries another resume: a claim hands
      // nothing out, and (submit worker round, 20261030140000) ends it as not sent with its reason instead of leaving it
      // queued for ever.
      const tampered = w.payload(u, "gh-6", "Initrode", "b".repeat(64));
      await pg.sql(`set session_replication_role = replica; insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash)
        values ('${u}', 'gh-6', 'Initrode', '${tampered.url}', ${q(JSON.stringify(tampered))}::jsonb, '${await w.hash(tampered)}', '${await w.hash(tampered)}'); set session_replication_role = origin;`);
      const again = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 6, p_source: "own_computer" });
      eq([again.error, again.data], [null, []], "nothing handed out");
      eq(await pg.sql(`select state || ' | ' || reason from public.career_apply_jobs where user_id = '${u}' and job_id = 'gh-6'`),
        "not_submitted | not sent: the resume you approved it with is no longer your confirmed resume; nothing was sent. Approve it again with your current resume");
      await pg.sql(`delete from public.career_apply_jobs where user_id = '${u}' and job_id = 'gh-6'`);
      // A render whose stored time is before the confirmation was made from what they had before: refused.
      const early = "6".repeat(64);
      await pg.sql(`insert into storage.buckets (id, name) values ('career-resumes', 'career-resumes') on conflict do nothing; insert into storage.objects (bucket_id, name, created_at) values ('career-resumes', '${u}/${early}.pdf', now() - interval '1 hour')`);
      ok(/no_resume/.test((await w.enqueue(w.payload(u, "gh-7", "Wayne", early))).error?.message ?? ""), "a render older than the confirmation");
      // Anything else carried is never queued.
      const bad = await w.enqueue(w.payload(u, "gh-5", "Umbrella", "b".repeat(64)));
      ok(/no_resume/.test(bad.error?.message ?? ""), `queued with another resume: ${bad.error?.message}`);
      eq(await w.jobs(u), "gh-1:driving,gh-4:driving");
    });

    await t.step("(2) a paste on a text channel is the one resume; the cloud keeps no file and never sends the text as one", async () => {
      const u = await w.person();
      const sha = await w.pasteAndConfirm(u, PASTE);
      const r = await w.record(u);
      eq([r.state, r.kind, r.sha256, r.filename], ["confirmed", "paste", sha, null]);
      eq(new TextDecoder().decode(Uint8Array.from(atob(r.bytes_b64.replace(/\n/g, "")), (c) => c.charCodeAt(0))), PASTE, "the paste, byte for byte");
      eq(await w.cloud(u), "", "the cloud keeps no file for a paste");
      const asFile = await w.enqueue(w.payload(u, "c-1", "Acme", sha));
      ok(/no_resume/.test(asFile.error?.message ?? ""), `the paste's text is never the file: ${asFile.error?.message}`);
      const tailored = "c".repeat(64);
      await w.render(u, tailored);
      eq((await w.enqueue(w.payload(u, "c-2", "Acme", tailored))).error, null, "a render made from it after the confirmation goes");
      await pg.sql(`update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = '${u}', source = 'cloud' where user_id = '${u}' and job_id = 'c-2'`);
      const id = await pg.sql(`select id from public.career_apply_jobs where user_id = '${u}' and job_id = 'c-2'`);
      eq((await pg.asService().rpc("career_apply_cloud_resume", { p_id: id, p_lease: u })).data, null, "the cloud has nothing to attach");
    });

    await t.step("(3) changing the resume mid-flow stops every approval made with the old one", async () => {
      const u = await w.person();
      const a = await w.telegramFile(u, PDF_A, "resume-a.pdf");
      await w.confirm(u, { kind: "file", ref: a.ref, sha256: a.sha });
      const oldRender = "d".repeat(64);
      await w.render(u, oldRender);
      await w.profile(u, [{ id: "a-exp", kind: "experience", upload_sha256: a.sha }, { id: "pref", kind: "preference" }]);
      eq((await w.enqueue(w.payload(u, "j-1", "Acme", a.sha))).error, null);
      eq((await w.enqueue(w.payload(u, "j-2", "Globex", oldRender))).error, null);
      const prep = await w.prepare(w.payload(u, "j-3", "Initech", a.sha));
      eq(prep.error, null);
      await pg.sql(`insert into public.career_apply_prepare_attempts (user_id, posting_job_id, outcome, prepared_id) values ('${u}', 'j-3', 'ready', '${prep.id}')`);
      const card = await w.card(u, [{ id: prep.id!, hash: prep.hash, company: "Initech" }]);
      eq((await w.enqueue(w.payload(u, "j-4", "Hooli", a.sha))).error, null);
      await pg.sql(`update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = gen_random_uuid(), source = 'own_computer' where user_id = '${u}' and job_id = 'j-4'`);
      eq(await w.jobs(u), "j-1:queued,j-2:queued,j-4:driving");
      // The person changes their mind and sends a new file.
      const b = await w.telegramFile(u, PDF_B, "resume-b.pdf");
      await w.confirm(u, { kind: "file", ref: b.ref, sha256: b.sha });
      const r = await w.record(u);
      eq([r.sha256, r.filename, r.generation], [b.sha, "resume-b.pdf", 2]);
      eq(await w.jobs(u), "j-4:driving", "approved-but-not-sent with the old file or its render: removed; the one being sent: left");
      eq(await w.prepared(u), "", "prepared with the old file: discarded");
      eq(await pg.sql(`select count(*) from public.career_apply_prepare_attempts where user_id = '${u}'`), "0", "so the posting is prepared again");
      eq(await w.cloud(u), `${b.sha}:${b64(PDF_B)}`, "the cloud keeps only the new file");
      const note = JSON.parse(await pg.sql(`select detail::text from public.career_events where user_id = '${u}' and kind = 'note' and source = 'resume'`));
      eq([note.why, note.cancelled, note.discarded, note.being_sent, note.companies], ["replaced", 2, 1, 1, ["Acme", "Globex"]]);
      // The stale card approves nothing; the old resume can't come back in through the queue.
      const ans = await pg.asPerson(u).rpc("career_apply_card_answer_own", { p_card: card, p_approve: [1] });
      eq(ans.data?.[0]?.result, "changed", JSON.stringify(ans));
      ok(/no_resume/.test((await w.enqueue(w.payload(u, "j-5", "Acme", a.sha))).error?.message ?? ""), "the old file is refused");
      ok(/no_resume/.test((await w.enqueue(w.payload(u, "j-6", "Acme", oldRender))).error?.message ?? ""), "its render too");
      eq((await w.enqueue(w.payload(u, "j-1", "Acme", b.sha))).error, null, "the same posting approved again with the new file");
      // The profile every prepare reads: only the new resume's entries (none yet), and entries from no upload that are not resume entries.
      eq(await w.profileIds(u), ["pref"]);
      await w.profile(u, [{ id: "a-exp", kind: "experience", upload_sha256: a.sha }, { id: "b-exp", kind: "experience", upload_sha256: b.sha },
        { id: "loose-exp", kind: "experience" }, { id: "pref", kind: "preference" }]);
      eq(await w.profileIds(u), ["b-exp", "pref"]);
      // The same file again changes nothing.
      await w.confirm(u, { kind: "file", ref: b.ref, sha256: b.sha });
      eq((await w.record(u)).generation, 2);
    });

    await t.step("(4) deleting the resume: every copy gone, nothing queued, claimed or prepared until a new one is confirmed", async () => {
      const u = await w.person();
      const a = await w.telegramFile(u, PDF_A, "resume.pdf");
      await w.confirm(u, { kind: "file", ref: a.ref, sha256: a.sha });
      await w.profile(u, [{ id: "a-exp", kind: "experience", upload_sha256: a.sha }]);
      eq((await w.enqueue(w.payload(u, "k-1", "Acme", a.sha))).error, null);
      const d = await pg.asService().rpc("career_resume_delete_as", { p_user: u });
      eq(d.error, null);
      eq([d.data.had, d.data.kind, d.data.filename, d.data.stopped.cancelled, d.data.stopped.companies], [true, "file", "resume.pdf", 1, ["Acme"]]);
      const r = await w.record(u);
      eq([r.state, r.sha256, r.bytes_b64, r.filename], ["deleted", null, null, null]);
      eq(await w.cloud(u), "");
      eq(await pg.sql(`select count(*) from public.career_resume_uploads where user_id = '${u}'`), "0", "the uploaded file is gone too");
      eq(await w.jobs(u), "");
      ok(/no_resume/.test((await w.enqueue(w.payload(u, "k-2", "Acme", a.sha))).error?.message ?? ""));
      ok(/no_resume/.test((await w.prepare(w.payload(u, "k-3", "Acme", a.sha))).error ?? ""));
      eq(await w.profileIds(u), [], "no resume entries to prepare from");
      eq((await pg.asService().rpc("career_resume_delete_as", { p_user: u })).data.had, false, "deleting twice: there was nothing");
      // A new paste brings it back.
      await w.pasteAndConfirm(u, PASTE);
      eq((await w.record(u)).state, "confirmed");
      // An account erase ("forget everything" raises the epoch) leaves no copy either.
      await pg.sql(`update public.career_watch_kv set value = value || '{"epoch":1}' where user_id = '${u}' and key = 'career:account'`);
      eq((await w.record(u)).state, "deleted");
    });

    await t.step("(5) tricks never write the record", async () => {
      const u = await w.person(), other = await w.person();
      const theirs = await w.message(other, PASTE);
      await w.confirm(u, { kind: "message", ref: `agent_messages:${theirs}`, sha256: await shaText(PASTE) });
      eq(await w.record(u), null, "another person's message");
      const mine = await w.message(u, PASTE);
      await w.confirm(u, { kind: "message", ref: `agent_messages:${mine}`, sha256: await shaText(PASTE + "edited") });
      eq(await w.record(u), null, "a hash that is not the message's");
      await w.confirm(u, { kind: "message", ref: `agent_messages:${mine}`, sha256: await shaText(PASTE) }, 1, "router: stated by the person in chat");
      eq(await w.record(u), null, "an event that is not a resume confirmation");
      const f = await w.telegramFile(u, PDF_A, "x.pdf");
      await pg.sql(`update public.career_resume_uploads set content_b64 = '${b64(PDF_B)}' where user_id = '${u}'`);
      await w.confirm(u, { kind: "file", ref: f.ref, sha256: f.sha });
      eq(await w.record(u), null, "stored bytes that don't hash to the event");
      await w.confirm(u, { kind: "file", ref: f.ref.replace(/[0-9a-f-]{36}\)$/, `${other.slice(0, 8)}-0000-0000-0000-000000000000)`), sha256: f.sha });
      eq(await w.record(u), null, "an upload id that is not theirs");
      await w.confirm(u, { kind: "drive", ref: "x", sha256: f.sha });
      eq(await w.record(u), null, "an unknown upload kind");
      // A file the chat read but the database holds no bytes for (the web's file read): recorded by its sha256, no copy.
      await w.confirm(u, { kind: "file", ref: "web:resume.pdf", sha256: f.sha });
      const r = await w.record(u);
      eq([r.state, r.kind, r.sha256, r.bytes_b64], ["confirmed", "file", f.sha, null]);
      eq(await w.cloud(u), "", "no bytes, nothing for the cloud");
      // Nobody but the service can call the doors.
      const asThem = await pg.asPerson(u).rpc("career_resume_delete_as", { p_user: other });
      ok(/permission denied/.test(asThem.error?.message ?? ""), `a person can't delete anyone's resume through the API: ${asThem.error?.message}`);
      const put = await pg.asPerson(u).rpc("career_resume_put", { p_user: u, p_sha256: "e".repeat(64), p_kind: "file", p_ref: "x", p_filename: "x", p_bytes: null, p_event: "x" });
      ok(/permission denied/.test(put.error?.message ?? ""), `nor write the record: ${put.error?.message}`);
    });

    await t.step("(7) the person's own signed-in computer keeping a file for the cloud is the same door", async () => {
      const u = await w.person();
      await w.pasteAndConfirm(u, PASTE);
      const r = await pg.asPerson(u).rpc("career_apply_cloud_resume_put_own", { p_filename: "From My Laptop.pdf", p_b64: b64(PDF_B) });
      eq(r.error, null);
      const rec = await w.record(u);
      eq([rec.state, rec.kind, rec.sha256, rec.filename, rec.generation], ["confirmed", "file", await shaBytes(PDF_B), "From My Laptop.pdf", 2]);
      eq(await w.cloud(u), `${await shaBytes(PDF_B)}:${b64(PDF_B)}`, "one kept file, the record's");
      // The same file kept again changes nothing (no new generation, nothing stopped).
      eq((await pg.asPerson(u).rpc("career_apply_cloud_resume_put_own", { p_filename: "From My Laptop.pdf", p_b64: b64(PDF_B) })).error, null);
      eq((await w.record(u)).generation, 2);
      // The service keeping a file (not the person's session) is not a confirmation.
      const v = await w.person();
      await pg.sql(`insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch) values ('${v}', '${await shaBytes(PDF_A)}', 'x.pdf', decode('${b64(PDF_A)}', 'base64'), 0)`);
      eq(await w.record(v), null);
    });

    await t.step("(8) an emailed application tried again (not_submitted -> driving) goes only with the record's file; the retry with another attachment is refused", async () => {
      const u = await w.person();
      const f = await w.telegramFile(u, PDF_A, "Ada Resume.pdf");
      await w.confirm(u, { kind: "file", ref: f.ref, sha256: f.sha });
      eq((await w.record(u)).state, "confirmed");
      // An email application whose attachment is not the record's file. Gmail refused it (nothing went): not_submitted, as
      // the finish records it. Written past the insert guard here, as a restore could: the retry is what is under test.
      const other = "b".repeat(64);
      const mail = { kind: "email", version: 1, user_id: u, job_id: "mail-1", company: "Acme", title: "Analyst", url: "https://acme.example/jobs/1",
        to: "jobs@acme.example", subject: "Application", body: "Hello", attachment: { filename: "resume.pdf", sha256: other, size: 10, tailored: false },
        resume_sha256: other, resume_tailored: false };
      const h = await w.hash(mail);
      await pg.sql(`set session_replication_role = replica;
        insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, source)
        values ('${u}', 'mail-1', 'Acme', 'https://acme.example/jobs/1', ${q(JSON.stringify(mail))}::jsonb, '${h}', '${h}', 'not_submitted', 1, 'email');
        set session_replication_role = origin;
        insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:email-card',
          jsonb_build_object('id', 'c1', 'state', 'shown', 'payload', ${q(JSON.stringify(mail))}::jsonb, 'payload_hash', '${h}', 'shown_at', now(), 'thread', 't'));`);
      // A fresh yes: the reserve moves the same tracked row back to driving (career_apply_email_reserve_for), which this
      // rule refuses for a resume that is not the record's.
      const again = await pg.asService().rpc("career_apply_email_reserve_as", { p_user: u, p_payload: mail, p_hash: h });
      ok(/no_resume/.test(again.error?.message ?? ""), `the retry with another attachment is refused: ${JSON.stringify(again)}`);
      eq(await w.jobs(u), "mail-1:not_submitted", "and the row stays not sent");
    });

    await t.step("(9) 'resume on file' (#194's career_resume_on_file, read by the chat's apply turn and the card) honours the record", async () => {
      const onFile = async (u: string) => (await pg.asService().rpc("career_resume_on_file", { p_user: u })).data;
      // A person #194 counts as having a resume on file: a confirmed entry with its event in their chat profile.
      const u = await w.person();
      await pg.sql(confirmedResumeSql(u));
      // (Step 6 turned the owner's switch on, so everyone is under the rule now.)
      eq(await onFile(u), false, "under the rule with no record: the chat's entries alone are no resume on file");
      // They confirm a resume (the record), then say "delete my resume": the entries stay in the chat's profile, but
      // nothing is on file, so the chat and the card say so instead of queueing what the database then refuses.
      await w.pasteAndConfirm(u, PASTE);
      eq(await onFile(u), true, "a confirmed record: on file");
      eq((await pg.asService().rpc("career_resume_delete_as", { p_user: u })).error, null);
      eq(await onFile(u), false, "after 'delete my resume': nothing on file, though the entries remain");
    });
  } finally {
    await pg.stop();
  }
} });

// The chat's words for the record: messy phrasings recognised, others left alone, and every reply true to the state.
Deno.test("one confirmed resume: what the person says, and what they are told", () => {
  for (const t of ["delete my resume", "Delete my resume pls", "can you remove the resume you have?", "forget my CV", "get rid of my old resume please", "erase my résumé"]) {
    eq(parseResumeCommand(t), { kind: "delete" }, t);
  }
  for (const t of ["what resume do you have?", "which resume will you send", "do you have my resume", "show me my resume on file", "Did you get my resume"]) {
    eq(parseResumeCommand(t), { kind: "status" }, t);
  }
  for (const t of ["here is my resume:\nADA", "delete my account", "tailor my resume for Stripe", "remove Acme from my list", "my resume is attached, delete the old one and use this"]) {
    eq(parseResumeCommand(t), null, t);
  }
  eq(statusReply({ state: "none" }), "I don't have a resume on file for you. Paste your resume here and confirm it when I show you its entries; every application then uses that one.");
  eq(statusReply({ state: "confirmed", kind: "file", filename: "Ada.pdf", confirmed_at: "2026-10-26T20:00:00Z", file_kept: true }),
    "The resume on file is the file Ada.pdf you sent and confirmed on 2026-10-26. Every application I prepare uses only it: each one carries that file or a version made from the entries you confirmed in it, and nothing goes out until you approve it. To change it, paste your new resume here and confirm it; to remove it, say \"delete my resume\".");
  ok(/can't attach it/.test(statusReply({ state: "confirmed", kind: "file", filename: "Ada.pdf", confirmed_at: "2026-10-26", file_kept: false })));
  eq(deleteReply({ had: true, kind: "file", filename: "Ada.pdf", confirmed_at: "2026-10-26T20:00:00Z", stopped: { cancelled: 2, discarded: 1, being_sent: 1, companies: ["Acme", "Globex"] } }),
    "Deleted the file Ada.pdf you sent and confirmed on 2026-10-26; I keep no copy of it. The entries you confirmed from it stay in your profile until you say \"forget my career profile\", and no application uses them without a resume on file. 2 approved applications that hadn't gone out were cancelled (Acme, Globex). 1 prepared application was discarded. 1 application was already being sent; one that went out can't be taken back. No application will be prepared or sent until you paste your resume here and confirm it.");
  eq(deleteReply({ had: false }), "I didn't have a resume on file for you, so there was nothing to delete. No application will be prepared or sent until you paste your resume here and confirm it.");
});
