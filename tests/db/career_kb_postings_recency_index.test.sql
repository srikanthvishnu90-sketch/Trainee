-- Launch readiness X3 (20261026230400): the pool's read (newest first, limit 600) is served by the posted_at index, not a
-- sort of the whole table.
\set ON_ERROR_STOP on
begin;
reset role;
insert into career_kb_postings(posting_key, source, company, title, posted_at, text_excerpt, content_hash)
select 'TEST-IDX-'||g, 'greenhouse', 'Index Co '||(g % 50), 'Analyst '||g, now() - make_interval(mins => g), 'text', md5(g::text)
from generate_series(1, 5000) g on conflict do nothing;
analyze career_kb_postings;
set local enable_seqscan = off;
do $$
declare line text; txt text := '';
begin
  for line in execute 'explain select posting_key,source,board,company,title,location,url,posted_at,fetched_on,corpus_vintage,text_excerpt
    from career_kb_postings order by posted_at desc nulls last limit 600' loop
    txt := txt || line || E'\n';
  end loop;
  if txt !~ 'career_kb_postings_posted_at_recent' or txt ~ 'Sort' then raise exception 'FAIL the pool read is not served by the index: %', txt; end if;
  raise notice 'ok   the pool read (newest 600) walks career_kb_postings_posted_at_recent with no sort';
end $$;
rollback;
