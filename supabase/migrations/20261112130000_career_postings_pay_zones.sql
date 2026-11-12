-- D-069 (real set item 13, finding 4): every pay zone a job board states for a posting, as a structured array
-- (career_ingest.ts boardPayZones): [{ text, label, currency, min, max, period }], from the board's own numbers, currency and
-- period, never converted. `pay` (200 characters, whole ranges only) could not hold Robinhood's third zone (Lake Mary, FL), so
-- that zone was dropped; pay_zones keeps every zone (at most 24). Additive and idempotent: applies cleanly twice.
alter table public.career_postings add column if not exists pay_zones jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'career_postings_pay_zones_shape') then
    alter table public.career_postings add constraint career_postings_pay_zones_shape
      check (pay_zones is null or (jsonb_typeof(pay_zones) = 'array' and jsonb_array_length(pay_zones) between 1 and 24 and pg_column_size(pay_zones) <= 16384));
  end if;
end $$;
