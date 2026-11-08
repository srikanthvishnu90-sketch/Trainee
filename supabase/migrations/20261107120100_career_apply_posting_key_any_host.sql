-- R9 (2026-11-07): a Greenhouse job number on any host is that Greenhouse posting.
-- The mass-apply scorecard (evals/career/mass-apply-outcomes, 3defbcf) admitted a second application to 14 of 14
-- Greenhouse postings reached through an employer's own careers page (https://careers.<employer>/jobs?gh_jid=N): the key
-- read gh_jid only on a greenhouse.io host. Greenhouse numbers its jobs once across every board, so ?gh_jid=N names job N
-- wherever the page lives. Everything else in the key is 20261027141000's, rule for rule (the TS twin is postingKey in
-- supabase/functions/_shared/career_apply.ts; tests/architect/r9-apply-quality.test.ts holds both to it).
-- The expression index on career_apply_jobs reads this function, so it is rebuilt after the change. Idempotent.
-- NOT APPLIED to the live project: the owner applies it through the release path (docs/launch/TRAINEE-GO-LIVE.md).
create or replace function public.career_apply_posting_key(p_url text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare m text[]; h text; p text; q text; jid text;
begin
 m := regexp_match(lower(btrim(coalesce(p_url, ''))), '^https?://([^/?#@]+)([^?#]*)(\?[^#]*)?');
 if m is null then return null; end if;
 h := regexp_replace(regexp_replace(m[1], '^www\.', ''), ':(80|443)$', '');
 p := regexp_replace(coalesce(m[2], ''), '/+$', '');
 if p ~ '^/[^/]+/.+/(apply|application)$' then p := regexp_replace(regexp_replace(p, '/(apply|application)$', ''), '/+$', ''); end if;
 jid := substring(coalesce(m[3], '') from '[?&]gh_jid=([0-9]+)');
 if jid is not null then return 'greenhouse.io/jobs/' || jid; end if;
 if h ~ '(^|\.)greenhouse\.io$' then
  jid := substring(p from '/jobs/([0-9]+)$');
  if jid is not null then return 'greenhouse.io/jobs/' || jid; end if;
 end if;
 if m[3] is null or length(m[3]) < 2 then return h || p; end if;
 select string_agg(x, '&' order by x collate "C") into q from unnest(string_to_array(substr(m[3], 2), '&')) x
  where x <> '' and x !~ '^(utm_[a-z_]*|gh_src|src|source|ref|referrer|lever-[a-z-]*)(=|$)';
 return h || p || coalesce('?' || q, '');
end $$;
reindex index public.career_apply_jobs_posting_key;
