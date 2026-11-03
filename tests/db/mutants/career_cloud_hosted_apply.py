# Mutants for 20261026230017_career_cloud_hosted_apply.sql against tests/db/career_cloud_hosted_apply.test.sql.
#   python3 tests/db/mutants/run_sql_mutants.py tests/db/mutants/career_cloud_hosted_apply.py
MIGRATION = 'supabase/migrations/20261026230017_career_cloud_hosted_apply.sql'
TEST = 'tests/db/career_cloud_hosted_apply.test.sql'
SETUP = ['tests/db/mutants/t_helpers.sql', 'scripts/launch/verify-claim-guards.sql']
# Equivalent mutants (left out: no test can tell them from the migration as written, and why):
#   M28 claim2 without its own dispatch lock: its first statement calls career_apply_cloud_dispatch_claim, whose first
#       statement takes the same transaction lock ('career-cloud-dispatch-v1') before anything is read.
#   M39 the text claim's candidate filter without approval_hash = payload_hash: every candidate then goes through
#       career_apply_cloud_text_refusal, which refuses that same condition first ('not_approved'); nothing else differs.
#   M48 the text claim without its 6-a-call clamp: only claim2 calls it (service_role cannot), always with least(6, n).
M = [
 # --- the reviewer's set (review of #202, head d74ee203), anchors as the migration reads now
 ('M01 card_of: hash of the card item not required', "  and it->>'payload_hash' = j.payload_hash\n", "  and true\n"),
 ('M02 card_of: prepared payload need not equal the job payload', " and p.payload_hash = j.payload_hash and p.payload = j.payload\n", " and p.payload_hash = j.payload_hash\n"),
 ('M03 refusal: payload need not hash to what was approved', "or j.payload_hash is distinct from public.career_apply_payload_hash(j.payload)", "or false"),
 ('M04 refusal: no kept resume check', "if not exists (select from public.career_apply_cloud_resumes r where r.user_id = j.user_id and r.sha256 = j.payload->>'resume_sha256'", "if false and not exists (select from public.career_apply_cloud_resumes r where r.user_id = j.user_id and r.sha256 = j.payload->>'resume_sha256'"),
 ('M05 refusal: no 24h expiry', "if (card->>'answered_at')::timestamptz <= p_now - interval '24 hours' then return 'approval_expired'; end if;", "null;"),
 ('M06 refusal: claim of a non-queued/claimed job allowed', "if p_phase = 'claim' and (j.state <> 'queued' or j.attempts <> 0 or j.source is not null) then return 'not_approved'; end if;", "null;"),
 ('M07 refusal: no per-site rate', "if p_phase = 'claim' and p_per_site_minute is not null and (select count(*)", "if false and p_phase = 'claim' and p_per_site_minute is not null and (select count(*)"),
 ('M08 refusal: no per-person daily cap', ">= cap then return 'daily_limit'; end if;", ">= 1000000 then return 'daily_limit'; end if;"),
 ('M09 refusal: no 30-day company rule', "if co <> '' and exists (select from public.career_apply_ledger(j.user_id, p_now - interval '30 days') l", "if false and co <> '' and exists (select from public.career_apply_ledger(j.user_id, p_now - interval '30 days') l"),
 ('M10 refusal: gate/waiver ignored', "if not public.career_apply_cloud_open(fam) then\n  if p_phase = 'claim'", "if false then\n  if p_phase = 'claim'"),
 ('M11 refusal: opt-in ignored', "if o.user_id is null or not o.enabled or o.privacy_epoch is distinct from coalesce((a->>'epoch')::bigint, 0) then return 'not_opted_in'; end if;", "null;"),
 ('M12 refusal: text-card switch ignored', " if not public.career_apply_cloud_enabled() or not public.career_apply_cloud_text_cards_enabled() then return 'cloud_switches_off'; end if;\n if p_phase = 'claim' and", " if not public.career_apply_cloud_enabled() then return 'cloud_switches_off'; end if;\n if p_phase = 'claim' and"),
 ('M13 authorize: lease not checked', "or p_lease is null or j.lease_token is distinct from p_lease\n", "or p_lease is null\n"),
 ('M14 authorize: hash param not checked', "  or j.payload_hash is distinct from p_hash or j.claimed_at is null", "  or j.claimed_at is null"),
 ('M15 claim2: global room ignored', "room := least(p_want - first, p_global - (live->>'total')::int);", "room := p_want - first;"),
 ('M16 claim2: per-portal ignored', "n := least(room, p_per_portal - (live->>f)::int);", "n := room;"),
 ('M17 prepare put: not limited to the person', "from public.career_apply_wanted w where w.user_id = p_user and w.state = 'waiting'\n  and w.posting_key = any(p_job_ids)", "from public.career_apply_wanted w where w.state = 'waiting'\n  and w.posting_key = any(p_job_ids)"),
 ('M18 prepare claim: per-person-day ignored (postings)', "   if cardinality(take) >= left_person then", "   if false then"),
 ('M19 prepare claim: global ignored', "exit when got >= p_want or running + got >= p_global;", "exit when got >= p_want;"),
 ('M20 prepare claim: per-site ignored (postings)', "   elsif coalesce((site->>h)::int, 0) >= p_per_site_minute then", "   elsif false then"),
 ('M21 requested push: STOP ignored (card)', " if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return null; end if;\n select thread_id into thread from public.channel_contacts where user_id = p_user and thread_id is not null order by last_inbound_at desc nulls last, created_at limit 1;\n -- A person on the web", " select thread_id into thread from public.channel_contacts where user_id = p_user and thread_id is not null order by last_inbound_at desc nulls last, created_at limit 1;\n -- A person on the web"),
 ("M22 requested push: any prepared row, not only this request's", "   where t.user_id = p_user and t.prepared_id = x and t.posting_job_id = any(req.job_ids))) then\n  raise exception 'not a requested preparation'; end if;", "   where t.user_id = p_user and t.prepared_id = x and t.posting_job_id = any(req.job_ids))) and false then\n  raise exception 'not a requested preparation'; end if;"),
 ('M23 cancel: card not closed', "  where c.user_id = p_user and c.state = 'open' and exists (select from jsonb_array_elements(c.items) it where (it->>'prepared_id')::uuid = any(ids));", "  where false;"),
 ('M24 cancel: approved unclaimed job not closed', "  where user_id = p_user and state = 'queued' and attempts = 0 and source is null and public.career_apply_company_key(company) = co;", "  where false;"),
 ("M25 cancel: not person-scoped (keys and delete)", "delete from public.career_apply_wanted where user_id = p_user and posting_key = any(keys);", "delete from public.career_apply_wanted where posting_key in (select posting_key from public.career_apply_wanted where state = 'waiting' and public.career_apply_company_key(company) = co);"),
 ('M26 cancel: person claim lock removed', " perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));\n perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));\n keys", " perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));\n keys"),
 ('M27 text claim: person lock removed', "foreach u in array users loop perform pg_advisory_xact_lock(hashtextextended(u::text, 0)); end loop;", "null;"),
 ('M29 grant: anon may dispatch (appended)', None, "\ngrant execute on function public.career_apply_cloud_dispatch_claim2(integer, integer, integer, integer, integer) to anon;\n"),
 ('M30 grant: anon may authorize (appended)', None, "\ngrant execute on function public.career_apply_cloud_authorize_any(uuid, uuid, text, text) to anon;\n"),
 ('M31 grant: authenticated may cancel for anyone (appended)', None, "\ngrant execute on function public.career_apply_cancel_for(uuid, text) to authenticated;\n"),
 ('M32 claim: text claim site count never counted', "where t.host = v_host and t.claimed_at > p_now - interval '1 minute') >= p_per_site_minute then return 'site_rate'", "where t.host = v_host and t.claimed_at > p_now - interval '1 minute') >= 100000 then return 'site_rate'"),
 ('M33 refusal: card-cloud jobs not left to their route', "if public.career_apply_cloud_card_bound(j.id) then return 'card_cloud_route'; end if;", "null;"),
 ('M34 refusal: person-submits destination allowed', " if not public.career_apply_cloud_destination_ok(j.payload->>'destination') then return 'person_submits'; end if;", " null;"),
 ('M35 refusal: portal family unchecked', "if fam is null or fam not in ('greenhouse', 'lever', 'ashby') then return 'portal_not_cloud'; end if;", "null;"),
 ('M36 refusal: stale account not checked', "if public.career_apply_current(j.user_id, j.payload) is distinct from true then return 'stale'; end if;", "null;"),
 ('M37 authorize: claim marker not required', "  or not exists (select from public.career_apply_cloud_text_claims t where t.job_id = j.id and t.user_id = j.user_id)) then\n  return 'not_approved'; end if;", "  or false) then\n  return 'not_approved'; end if;"),
 ('M38 authorize: marker need not name this card item', " if p_phase = 'authorize' and not exists (select from public.career_apply_cloud_text_claims t where t.job_id = j.id\n  and t.card_id = (card->>'card_id')::uuid and t.item_n = (card->>'n')::int) then return 'not_approved'; end if;", " null;"),
 ('M41 refusal: engine_approval format not required', "coalesce(j.payload->>'engine_approval', '') !~ '^[0-9a-f]{64}$'", "false"),
 ('M40 refusal: payload user need not be the job user', "or j.payload->>'user_id' is distinct from j.user_id::text", "or false"),
 ('M42 card_of: job need not be created inside the card showing', "  and j.created_at >= c.shown_at and j.created_at <= c.answered_at\n", "\n"),
 ('M43 card_of: item need not be in the approved numbers', "  and jsonb_typeof(c.answer->'approve') = 'array' and c.answer->'approve' @> to_jsonb((it->>'n')::int)\n", "\n"),
 ('M44 card_of: item result must be queued - dropped', "  and exists (select from jsonb_array_elements(coalesce(c.answer->'results', '[]'::jsonb)) r\n   where r->>'n' = it->>'n' and r->>'result' = 'queued')\n", "\n"),
 ("M45 card_of: card need not be this person's", " where c.user_id = j.user_id and c.state = 'answered'", " where c.state = 'answered'"),
 ("M46 card_of: prepared row need not be this person's", "  and p.user_id = j.user_id and p.state = 'approved'", "  and p.state = 'approved'"),
 ('M47 claim2: zero per-person number allowed', "or p_per_person_day is null or p_per_person_day not between 1 and 50", "or p_per_person_day is null"),
 ('M49 authorize: 15-minute claim age not checked', " or j.claimed_at <= clock_timestamp() - interval '15 minutes' then\n  raise exception 'invalid apply claim'; end if;\n -- The owner's kill switch first", " then\n  raise exception 'invalid apply claim'; end if;\n -- The owner's kill switch first"),
 ('M50 authorize: state/source not checked', " if j.state is distinct from 'driving' or j.source is distinct from 'cloud' or p_lease is null", " if p_lease is null"),
 # --- F1: the owner's kill switch on this route
 ('F1a refusal: kill switch ignored', " if not public.career_apply_agent_submit_enabled() then return 'cloud_switches_off'; end if;\n", "\n"),
 ('F1b text claim: kill switch ignored', "  or not public.career_apply_agent_submit_enabled()\n  or not public.career_apply_cloud_enabled()", "  or not public.career_apply_cloud_enabled()"),
 ('F1c authorize: kill switch not checked first', " if not public.career_apply_agent_submit_enabled() then raise exception 'agent submit is off'; end if;\n", "\n"),
 # --- F7: the approved sources' digest at the authorization
 ('F7a authorize: digest format not required', " if coalesce(p_source_digest, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid source digest'; end if;\n", "\n"),
 ('F7b authorize: digest not compared', " if dig is distinct from p_source_digest then raise exception 'approved sources changed'; end if;\n", "\n"),
 # --- F3: preparation numbers count postings
 ('F3a put: per person counts requests again', "\n where user_id = p_user and claimed_at > p_at - interval '1 day'\n$$;", "\n where user_id = p_user and claimed_at > p_at - interval '1 day' and false\n$$;"),
 ('F3b claim: no split (the rest is dropped)', "  if cardinality(rest) > 0 then\n   insert into public.career_apply_prepare_requests", "  if false then\n   insert into public.career_apply_prepare_requests"),
 ('F3c claim: why it waits not recorded', "   update public.career_apply_prepare_requests set outcome = outcome || jsonb_build_object('waiting_for', why) where id = r.id;\n", "\n"),
 ('F3d put: hosts not per posting', "  values (p_user, ids, array(select coalesce(public.career_apply_url_host(w.url), '') from unnest(ids) with ordinality k(pk, n)\n   join public.career_apply_wanted w on w.user_id = p_user and w.posting_key = k.pk order by k.n),", "  values (p_user, ids, array(select '' from unnest(ids)),"),
 ('F3e put: LinkedIn/Indeed not excluded', "  and w.posting_key = any(p_job_ids) and not public.career_apply_never_automated(w.url) order by 1 limit 25);", "  and w.posting_key = any(p_job_ids) order by 1 limit 25);"),
 # --- F4: status true to the records
 ('F4a pending: STOP not said', "    and exists (select from public.channel_contacts c where c.user_id = w.user_id and c.opted_out) then 'stopped'", "    and false then 'stopped'"),
 ('F4b pending: a queued request reads preparing', "r.state = 'running' and w.posting_key = any(r.job_ids)) then 'preparing'", "r.state in ('queued', 'running') and w.posting_key = any(r.job_ids)) then 'preparing'"),
 ('F4c pending: day limit not said', "    and r.outcome->>'waiting_for' = 'per_person_day') then 'waiting_day_limit'", "    and false) then 'waiting_day_limit'"),
 # --- earlier rounds (follow-through, push, notices)
 ('E01 tell: STOP honoured', " if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return false; end if;\n if exists (select from public.channel_contacts where user_id = p_user and thread_id is not null) then", " if exists (select from public.channel_contacts where user_id = p_user and thread_id is not null) then"),
 ('E02 tell: once per key in the thread', "if thread is null or exists (select from public.agent_messages where thread_id = thread and meta->>'notice_key' = p_key) then return false; end if;", "if thread is null then return false; end if;"),
 ('E03 card push: web-only gets no outbox row', "  insert into public.career_outbox (user_id, key, kind, text, deliver_at, card_id) values (p_user, 'card:' || c.id, 'card', p_text, p_now, c.id);\n end if;", "  null;\n end if;\n insert into public.career_outbox (user_id, key, kind, text, deliver_at, card_id) values (p_user, 'card:' || c.id, 'card', p_text, p_now, c.id);"),
 ('E04 card push: web fallback exists', "  web_only := thread is not null;\n end if;\n if thread is null then return null; end if;", "  web_only := false; thread := null;\n end if;\n if thread is null then return null; end if;"),
 ('E05 cancel: scoped to the employer', "ids := array(select id from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown') and public.career_apply_company_key(company) = co);", "ids := array(select id from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown'));"),
 ('E06 cancel: claimed job untouched', "  where user_id = p_user and state = 'queued' and attempts = 0 and source is null and public.career_apply_company_key(company) = co;", "  where user_id = p_user and state in ('queued', 'driving') and public.career_apply_company_key(company) = co;"),
 ('E07 cancel: request emptied expires', "outcome = outcome || '{\"reason\":\"cancelled by the person\"}' where user_id = p_user and state in ('queued', 'running') and job_ids <@ keys;", "outcome = outcome where false;"),
 ('E08 cancel: sent reported', "from public.career_apply_jobs where user_id = p_user and state in ('confirmed', 'submitted_unconfirmed', 'unknown_outcome') and", "from public.career_apply_jobs where false and"),
 ('E09 pending: on card', "p.state = 'shown') then 'on_card'", "p.state = 'shown' and false) then 'on_card'"),
 ('E10 pending: waiting on you', "when t.outcome = 'asked' and q.n > 0 then 'waiting_on_you'", "when false then 'waiting_on_you'"),
 ('E11 pending: applications not repeated', "  and not exists (select from public.career_apply_jobs j where j.user_id = w.user_id and j.job_id in (w.posting_key, coalesce(t.engine_job_id, '')))\n", ""),
 ('E12 claim: lease expiry', "  where state = 'running' and claimed_at < n - interval '15 minutes' returning * loop", "  where false returning * loop"),
 ('E13 put: double tap is the same request', " if r.id is null then\n  insert into public.career_apply_prepare_requests", " if true then\n  insert into public.career_apply_prepare_requests"),
 ('E14 put: accepted says today is used', "'accepted', used < p_per_person_day,", "'accepted', true,"),
 ('E15 scope: lease required', " where r.id = p_id and r.state = 'running' and p_lease is not null and r.lease_token = p_lease and r.claimed_at > clock_timestamp() - interval '15 minutes'", " where r.id = p_id and r.state = 'running'"),
 ('E16 finish: once, under the lease', "  where id = p_id and state = 'running' and p_lease is not null and lease_token = p_lease returning * into r;\n if r.id is null then raise exception 'invalid prepare lease'; end if;", "  where id = p_id returning * into r;\n if r.id is null then raise exception 'invalid prepare lease'; end if;"),
 ('E17 push: card lines all carried', "  raise exception 'card text does not carry every line'; end if;", "  null; end if;"),
 ('E18 push: another person', " select * into req from public.career_apply_prepare_requests where id = p_request and user_id = p_user and created_at > p_now - interval '2 hours';\n if req.id is null then raise exception 'not a requested preparation'; end if;\n if exists (select from unnest(p_ids) x where not exists (select from public.career_apply_prepare_attempts t", " select * into req from public.career_apply_prepare_requests where id = p_request and created_at > p_now - interval '2 hours';\n if req.id is null then raise exception 'not a requested preparation'; end if;\n if exists (select from unnest(p_ids) x where not exists (select from public.career_apply_prepare_attempts t"),
 ('E19 cancel: hosts kept aligned', "where not u.j = any(keys))", "where true)"),
]
