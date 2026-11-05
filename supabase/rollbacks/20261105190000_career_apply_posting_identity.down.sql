-- Reverses 20261105190000_career_apply_posting_identity.sql: career_apply_posting_key exactly as 20261027141000 left it (a
-- Greenhouse job number read only on a greenhouse.io host), and its expression index rebuilt for that body.
create or replace function public.career_apply_posting_key(p_url text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare m text[]; h text; p text; q text; jid text;
begin
 m := regexp_match(lower(btrim(coalesce(p_url, ''))), '^https?://([^/?#@]+)([^?#]*)(\?[^#]*)?');
 if m is null then return null; end if;
 h := regexp_replace(regexp_replace(m[1], '^www\.', ''), ':(80|443)$', '');
 p := regexp_replace(coalesce(m[2], ''), '/+$', '');
 if p ~ '^/[^/]+/.+/(apply|application)$' then p := regexp_replace(regexp_replace(p, '/(apply|application)$', ''), '/+$', ''); end if;
 if h ~ '(^|\.)greenhouse\.io$' then
  jid := coalesce(substring(coalesce(m[3], '') from '[?&]gh_jid=([0-9]+)'), substring(p from '/jobs/([0-9]+)$'));
  if jid is not null then return 'greenhouse.io/jobs/' || jid; end if;
 end if;
 if m[3] is null or length(m[3]) < 2 then return h || p; end if;
 select string_agg(x, '&' order by x collate "C") into q from unnest(string_to_array(substr(m[3], 2), '&')) x
  where x <> '' and x !~ '^(utm_[a-z_]*|gh_src|src|source|ref|referrer|lever-[a-z-]*)(=|$)';
 return h || p || coalesce('?' || q, '');
end $$;
reindex index public.career_apply_jobs_posting_key;
