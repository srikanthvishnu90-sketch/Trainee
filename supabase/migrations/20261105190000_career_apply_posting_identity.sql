-- One Greenhouse posting, one identity, whatever link carries it (D-MS-3; the mass-apply outcome eval, PR #519:
-- duplicates prevented 0/14 on Greenhouse).
-- NOT APPLIED: like every migration, the owner applies it; nothing here runs on the live project until then.
--
-- The bug: career_apply_posting_key (20261027141000) read a Greenhouse job number only on a greenhouse.io host. The same
-- job shown on the employer's own careers page (company.com/careers?gh_jid=123) keyed as that page's link, not as
-- greenhouse.io/jobs/123, so a second application to the very posting already sent or in flight could be queued, prepared
-- and claimed for Submit. A Greenhouse job number is global (one number, one job, on every board), so here:
--   * ?gh_jid=N on any host is Greenhouse job N;
--   * on a greenhouse.io host, .../jobs/N, and the embedded form's token=N (embed/job_app?for=<board>&token=N), are job N;
--   * Lever's EU host (jobs.eu.lever.co) is the same board as jobs.lever.co.
-- Lever and Ashby postings stay keyed by board and id (the same id on another board is not taken for the same posting);
-- their /apply and /application steps, trailing slashes, case and tracking parameters already key as one (20261027141000).
-- Mirrored rule for rule by supabase/functions/_shared/career_apply.ts postingKey (tests/architect/flow-scenarios-apply-r4
-- compares them on Postgres; tests/architect/posting-identity.test.ts and tests/db/career_apply_posting_identity.test.sql).
--
-- Every layer that refuses a duplicate reads this one function: the queue (career_apply_ledger_refusal and the want queue
-- through career_apply_posting_sent), preparation (the prepare candidates) and the Submit claims (career_apply_posting_sent).
-- The function is immutable and an expression index reads it (career_apply_jobs_posting_key), so the index is rebuilt here.
-- Additive: one function body replaced, one index rebuilt; no table, row or grant changes. Idempotent. After 20261027141000.

create or replace function public.career_apply_posting_key(p_url text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare m text[]; h text; p text; q text; jid text;
begin
 m := regexp_match(lower(btrim(coalesce(p_url, ''))), '^https?://([^/?#@]+)([^?#]*)(\?[^#]*)?');
 if m is null then return null; end if;
 h := regexp_replace(regexp_replace(regexp_replace(m[1], '^www\.', ''), ':(80|443)$', ''), '^jobs\.eu\.lever\.co$', 'jobs.lever.co');
 p := regexp_replace(coalesce(m[2], ''), '/+$', '');
 if p ~ '^/[^/]+/.+/(apply|application)$' then p := regexp_replace(regexp_replace(p, '/(apply|application)$', ''), '/+$', ''); end if;
 jid := substring(coalesce(m[3], '') from '[?&]gh_jid=([0-9]+)(?:&|$)');
 if jid is not null then return 'greenhouse.io/jobs/' || jid; end if;
 if h ~ '(^|\.)greenhouse\.io$' then
  jid := substring(p from '/jobs/([0-9]+)$');
  if jid is null and p ~ '^/embed/' then jid := substring(coalesce(m[3], '') from '[?&]token=([0-9]+)(?:&|$)'); end if;
  if jid is not null then return 'greenhouse.io/jobs/' || jid; end if;
 end if;
 if m[3] is null or length(m[3]) < 2 then return h || p; end if;
 select string_agg(x, '&' order by x collate "C") into q from unnest(string_to_array(substr(m[3], 2), '&')) x
  where x <> '' and x !~ '^(utm_[a-z_]*|gh_src|src|source|ref|referrer|lever-[a-z-]*)(=|$)';
 return h || p || coalesce('?' || q, '');
end $$;

-- The expression index holds keys the old body computed: rebuilt so every lookup reads the new identity.
create index if not exists career_apply_jobs_posting_key on public.career_apply_jobs (user_id, public.career_apply_posting_key(url));
reindex index public.career_apply_jobs_posting_key;
